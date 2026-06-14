/**
 * Capture runner 模块
 *
 * 负责：
 * - 解析 CLIENT_E2E_SEQUENCE 模型/target 切换序列
 * - 启动隔离 gateway + capture server 并收集上游请求
 * - 调用 capability-aware 断言生成 PASS/FAIL 与 violations
 *
 * @module scripts/lib/capture-runner
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getProviderProfile } = require('../certification/provider-profiles');
const { makeTempRoot, randomPort, removeIfExists, requestJson } = require('../certification/runner-utils');
const { startCaptureServer } = require('../upstream-capture-server');
const providerRegistry = require('../../proxy/providers');
const captureAsserts = require('./capture-asserts');

function sequenceModel(name, models) {
  if (!name || name === 'pro') return models.pro;
  if (name === 'flash') return models.flash;
  return name;
}

function parseSequence(input, models = { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }) {
  const raw = input || process.env.CLIENT_E2E_SEQUENCE || '';
  if (!raw) return [];
  return raw.split(/\s*->\s*/).filter(Boolean).map(step => {
    const [target, model, thinking, effort] = step.split(':');
    return {
      target: target === 'ds' ? 'codex' : target,
      model: sequenceModel(model, models),
      thinking: thinking === 'off' ? 'disabled' : 'enabled',
      effort: effort && effort !== '-' ? effort : 'max',
      raw: step,
    };
  });
}

async function startProxy({ tmpRoot, port, config, capturePort, logPath }) {
  const configDir = path.join(tmpRoot, '.deepseek-claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', '..', 'proxy'), configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  const env = {
    ...process.env,
    DEEPSEEK_CLAUDE_CONFIG_DIR: configDir,
    DEEPSEEK_CLAUDE_PROXY_PORT: String(port),
    DEEPSEEK_CLAUDE_LOG_PATH: logPath,
  };
  if (capturePort) {
    Object.assign(env, {
      DEEPSEEK_CLAUDE_TARGET_PROTOCOL: 'http:',
      DEEPSEEK_CLAUDE_TARGET_HOST: '127.0.0.1',
      DEEPSEEK_CLAUDE_TARGET_PORT: String(capturePort),
      DEEPSEEK_CLAUDE_TARGET_PREFIX: '',
      DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX: '',
    });
  }
  const child = spawn(process.execPath, [path.join(configDir, 'proxy.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const health = await requestJson({ port, requestPath: '/__health', method: 'GET', timeoutMs: 1000 });
      if (health.json?.service === 'deepseek-claude-proxy') return { child, health: health.json, configDir };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(stderr.trim() || 'proxy start timeout');
}

async function stopProxy(proxy, port) {
  if (!proxy) return;
  try { await requestJson({ port, requestPath: '/__stop', method: 'POST', timeoutMs: 1000 }); } catch {}
  if (!proxy.child.killed) proxy.child.kill();
}

async function runCaptureSequence(steps, providerDef) {
  const tmpRoot = makeTempRoot('deepseek-client-e2e-switch-');
  const port = randomPort();
  const logPath = path.join(tmpRoot, 'gateway.log');
  const capture = await startCaptureServer({ outputFile: path.join(tmpRoot, 'requests.jsonl') });
  const results = [];
  let proxy = null;
  try {
    for (const step of steps) {
      proxy = await startProxy({
        tmpRoot,
        port,
        capturePort: capture.port,
        logPath,
        config: {
          activeProvider: providerDef.id,
          providers: { [providerDef.id]: { apiKey: 'sk-capture-placeholder', model: step.model } },
          thinking: step.thinking,
          effort: step.effort,
        },
      });
      const before = fs.existsSync(capture.outputFile)
        ? fs.readFileSync(capture.outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
        : 0;
      const body = step.target === 'claude'
        ? { model: 'ignored', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with CAPTURE_OK' }] }
        : {
          model: 'ignored',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with CAPTURE_OK' }] }],
          stream: false,
          tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
        };
      await requestJson({
        port,
        requestPath: step.target === 'claude' ? '/v1/messages' : '/v1/responses',
        headers: step.target === 'claude' ? { 'anthropic-version': '2023-06-01' } : {},
        body,
      });
      const allRequests = fs.readFileSync(capture.outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      results.push({ step: step.raw, target: step.target, health: proxy.health, requests: allRequests.slice(before), switchedConfigRoot: true, status: 'PASS' });
      await stopProxy(proxy, port);
      proxy = null;
    }
    return results;
  } finally {
    if (proxy) await stopProxy(proxy, port);
    await new Promise(resolve => capture.server.close(resolve));
    removeIfExists(tmpRoot);
  }
}

async function runCaptureMatrix(options = {}) {
  const provider = getProviderProfile(options.providerId || process.env.CLIENT_E2E_PROVIDER || 'deepseek');
  if (!provider) throw new Error('unknown provider');
  const providerDef = providerRegistry.getProvider(provider.id);
  if (!providerDef) throw new Error(`provider adapter not registered: ${provider.id}`);
  const seqModels = {
    pro: options.model || provider.defaultModel,
    flash: options.flashModel || provider.flashModel,
  };
  const steps = parseSequence(options.sequence, seqModels).length ? parseSequence(options.sequence, seqModels) : parseSequence('codex:pro:on:max', seqModels);
  const results = await runCaptureSequence(steps, providerDef);
  let positiveAssertions = 0;
  const violations = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const stepResult = results[index];
    const assertion = captureAsserts.assertCaptureStep(stepResult, providerDef, step);
    stepResult.positiveAssertions = assertion.positiveAssertions;
    stepResult.violations = assertion.violations;
    stepResult.status = assertion.violations.length ? 'FAIL' : 'PASS';
    positiveAssertions += assertion.positiveAssertions;
    violations.push(...assertion.violations.map(item => ({ step: step.raw, ...item })));
  }
  return {
    providerId: provider.id,
    mode: 'capture',
    status: violations.length ? 'FAIL' : 'PASS',
    passed: violations.length === 0,
    positiveAssertions,
    violations,
    steps: results,
  };
}

module.exports = {
  parseSequence,
  runCaptureMatrix,
};
