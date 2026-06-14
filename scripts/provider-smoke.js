#!/usr/bin/env node
/**
 * Provider 真 Key smoke runner
 *
 * 负责：
 * - 在隔离配置目录启动本地 proxy
 * - 对 /__health、/v1/messages、/v1/responses 做最小真实请求
 * - 输出脱敏 smoke 报告，供认证器纳入 true-key 阶段
 *
 * @module scripts/provider-smoke
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getProviderProfile } = require('./certification/provider-profiles');
const { makeTempRoot, randomPort, removeIfExists, requestJson } = require('./certification/runner-utils');
const { redactText } = require('./certification/report-writer');
const { emptyTokenUsage, parseGatewayLogUsage } = require('./lib/token-usage');

/**
 * 按 provider profile 解析 smoke 模型别名。
 * @param {string|undefined} name - pro / flash / 完整模型 id。
 * @param {object} profile - provider 认证档案。
 * @returns {string} 实际模型 id。
 */
function modelFromName(name, profile) {
  if (name === 'flash') return profile.flashModel;
  if (!name || name === 'pro') return profile.defaultModel;
  return name;
}

async function startProxy({ tmpRoot, port, config, env = {} }) {
  const configDir = path.join(tmpRoot, '.deepseek-claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'proxy'), configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, [path.join(configDir, 'proxy.js')], {
    env: {
      ...process.env,
      ...env,
      DEEPSEEK_CLAUDE_CONFIG_DIR: configDir,
      DEEPSEEK_CLAUDE_PROXY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const health = await requestJson({ port, requestPath: '/__health', method: 'GET', timeoutMs: 1000 });
      if (health.json?.service === 'deepseek-claude-proxy') return { child, configDir };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(stderr.trim() || 'proxy start timeout');
}

async function stopProxy(child, port) {
  try {
    await requestJson({ port, requestPath: '/__stop', method: 'POST', timeoutMs: 1000 });
  } catch {}
  if (!child.killed) child.kill();
}

function readTokenUsage(logPath, defaults) {
  try {
    return parseGatewayLogUsage(fs.readFileSync(logPath, 'utf8'), defaults);
  } catch {
    return emptyTokenUsage();
  }
}

async function runSmoke(options = {}) {
  const providerId = options.providerId || process.env.PROVIDER_SMOKE_PROVIDER || 'deepseek';
  const profile = getProviderProfile(providerId);
  if (!profile) throw new Error(`unknown provider: ${providerId}`);
  const apiKey = options.apiKey || process.env[profile.apiKeyEnv];
  if (!apiKey) {
    return {
      passed: false,
      status: 'BLOCKED',
      failureClass: 'provider',
      message: `${profile.apiKeyEnv} is required`,
      positiveAssertions: 1,
      tokenUsage: emptyTokenUsage(),
    };
  }

  const tmpRoot = makeTempRoot('deepseek-provider-smoke-');
  const port = randomPort();
  const logPath = path.join(tmpRoot, 'gateway.log');
  const smokeModel = modelFromName(options.model || process.env.PROVIDER_SMOKE_MODEL || profile.defaultModel, profile);
  // v1.6.1：多 provider 配置——apiKey/model 必须落在 providers.[id]（顶层会被 runtime-config 归一成 deepseek）。
  const config = {
    activeProvider: providerId,
    providers: { [providerId]: { apiKey, model: smokeModel } },
    thinking: options.thinking || process.env.PROVIDER_SMOKE_THINKING || 'enabled',
    effort: options.effort || process.env.PROVIDER_SMOKE_EFFORT || 'max',
  };
  const result = {
    providerId,
    model: smokeModel,
    thinking: config.thinking,
    effort: config.effort,
    status: 'FAIL',
    passed: false,
    positiveAssertions: 0,
    tokenUsage: emptyTokenUsage(),
    checks: {},
  };
  let proxy = null;
  try {
    proxy = await startProxy({ tmpRoot, port, config, env: { DEEPSEEK_CLAUDE_LOG_PATH: logPath } });
    const health = await requestJson({ port, requestPath: '/__health', method: 'GET' });
    result.checks.health = {
      model: health.json?.model,
      thinking: health.json?.thinking,
      effort: health.json?.effort,
    };
    if (health.json?.model !== smokeModel) throw new Error(`health model mismatch: ${health.body}`);
    if (health.json?.thinking !== config.thinking) throw new Error(`health thinking mismatch: ${health.body}`);
    // zai/kimi 等无 effort 档 provider（profile.thinkingEfforts 为空）→ 网关正确报告 effort=null
    const hasEffortTiers = (profile.thinkingEfforts || []).length > 0;
    const expectedEffort = (config.thinking === 'disabled' || !hasEffortTiers) ? null : config.effort;
    if ((health.json?.effort ?? null) !== expectedEffort) throw new Error(`health effort mismatch: ${health.body}`);
    result.positiveAssertions += 3;

    const anthropic = await requestJson({
      port,
      requestPath: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model: 'ignored-by-gateway',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      },
      timeoutMs: 120000,
    });
    result.checks.anthropicStatus = anthropic.statusCode;
    if (anthropic.statusCode < 200 || anthropic.statusCode >= 300 || !anthropic.body) {
      throw new Error(`Anthropic smoke failed: HTTP ${anthropic.statusCode}`);
    }
    result.positiveAssertions += 2;

    const responses = await requestJson({
      port,
      requestPath: '/v1/responses',
      body: {
        model: 'ignored-by-gateway',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: pong' }] }],
        stream: false,
      },
      timeoutMs: 120000,
    });
    result.checks.responsesStatus = responses.statusCode;
    result.checks.responsesStatusField = responses.json?.status;
    result.checks.responsesOutputTextLength = typeof responses.json?.output_text === 'string' ? responses.json.output_text.length : 0;
    if (responses.statusCode < 200 || responses.statusCode >= 300) throw new Error(`Responses smoke failed: HTTP ${responses.statusCode}`);
    if (responses.json?.status !== 'completed') throw new Error(`Responses status mismatch: ${responses.body}`);
    if (!responses.json.output_text) throw new Error('Responses output_text is empty');
    result.positiveAssertions += 3;

    result.status = 'PASS';
    result.passed = true;
    result.message = 'provider smoke passed';
    result.tokenUsage = readTokenUsage(logPath, {
      source: 'provider-smoke',
      providerId,
      model: smokeModel,
    });
    return result;
  } catch (err) {
    result.status = 'FAIL';
    result.failureClass = /HTTP 4|HTTP 5/.test(err.message) ? 'provider' : 'gateway';
    result.message = err.message;
    result.tokenUsage = readTokenUsage(logPath, {
      source: 'provider-smoke',
      providerId,
      model: smokeModel,
    });
    return result;
  } finally {
    if (proxy) await stopProxy(proxy.child, port);
    removeIfExists(tmpRoot);
  }
}

if (require.main === module) {
  runSmoke().then(result => {
    console.log(redactText(JSON.stringify(result, null, 2), [process.env.DEEPSEEK_API_KEY]));
    process.exit(result.passed ? 0 : 1);
  }).catch(err => {
    console.error(redactText(err.stack || err.message, [process.env.DEEPSEEK_API_KEY]));
    process.exit(1);
  });
}

module.exports = {
  modelFromName,
  runSmoke,
};
