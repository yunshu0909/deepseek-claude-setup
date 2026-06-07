/**
 * Hermes Target 自动化测试
 *
 * 负责：
 * - 验证 OpenAI Chat Completions 入口的路由、payload mutation 与 SSE 透传
 * - 验证 Hermes config.yaml patch / restore / 诊断不泄露真实 key
 * - 验证 Linux systemd adapter 与多 target 生命周期
 *
 * @module test/hermes-target
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-hermes-target-'));
const configDir = path.join(tmp, '.deepseek-claude');
const hermesConfigPath = path.join(tmp, 'hermes', 'config.yaml');
const proxyPort = 20000 + Math.floor(Math.random() * 1000);

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);
process.env.HERMES_CONFIG_PATH = hermesConfigPath;

const configStore = require('../src/config-store');
const proxyBundle = require('../src/proxy-bundle');
const proxyManager = require('../src/proxy-manager');
const hermesPatcher = require('../src/hermes-patcher');
const ui = require('../src/ui');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function requestJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
      },
      timeout: 5000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
    req.write(raw);
    req.end();
  });
}

function makeChatUpstream(options = {}) {
  const { mode = 'sse', failMaxToolRequestOnce = false } = options;
  const calls = [];
  let failedOnce = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      const body = calls[calls.length - 1].body;
      if (failMaxToolRequestOnce && !failedOnce && body.reasoning_effort === 'max' && Array.isArray(body.tools) && body.tools.length > 0) {
        failedOnce = true;
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
        return;
      }
      if (mode === 'json') {
        const body = JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'json-ok' }, finish_reason: 'stop' }],
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stream-ok' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

async function withProxy(upstream, cfg, fn) {
  process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL = 'http:';
  process.env.DEEPSEEK_CLAUDE_TARGET_HOST = '127.0.0.1';
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(upstream.port);
  process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX = '';
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await fn();
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstream.server.close(resolve));
  }
}

async function runProxyTests() {
  const cfg = {
    apiKey: 'sk-hermes-real-key',
    model: 'deepseek-v4-flash',
    thinking: 'enabled',
    effort: 'max',
  };

  console.log('\n-- Hermes proxy chat endpoint --');
  const streamUpstream = await makeChatUpstream();
  await withProxy(streamUpstream, cfg, async () => {
    const response = await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'gpt-placeholder',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.2,
    });
    check('API-041-4: returns OpenAI-compatible SSE chunks unchanged', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /stream-ok/);
      assert.match(response.body, /data: \[DONE\]/);
    });
    check('API-041-1/API-041-5: routes chat endpoint to OpenAI chat upstream', () => {
      assert.strictEqual(streamUpstream.calls[0].url, '/chat/completions');
      assert.strictEqual(streamUpstream.calls[0].body.model, cfg.model);
      assert.deepStrictEqual(streamUpstream.calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
    });
    check('API-041-2: injects enabled thinking and max effort for DeepSeek chat', () => {
      assert.deepStrictEqual(streamUpstream.calls[0].body.thinking, { type: 'enabled' });
      assert.strictEqual(streamUpstream.calls[0].body.reasoning_effort, 'max');
      assert.strictEqual(streamUpstream.calls[0].body.output_config, undefined);
    });
    check('KEY-045-2: proxy injects real provider key upstream, client only talks to local proxy', () => {
      assert.strictEqual(streamUpstream.calls[0].headers.authorization, `Bearer ${cfg.apiKey}`);
    });
  });

  const jsonUpstream = await makeChatUpstream({ mode: 'json' });
  await withProxy(jsonUpstream, cfg, async () => {
    const response = await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    check('API-041-1: non-stream chat response is passed through as JSON', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /json-ok/);
      assert.strictEqual(jsonUpstream.calls[0].body.stream, false);
      assert.strictEqual(jsonUpstream.calls[0].body.stream_options, undefined);
    });
  });

  const disabledUpstream = await makeChatUpstream();
  await withProxy(disabledUpstream, { ...cfg, thinking: 'disabled' }, async () => {
    await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'ignored',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    check('API-041-3: disabled thinking does not send reasoning_effort', () => {
      assert.deepStrictEqual(disabledUpstream.calls[0].body.thinking, { type: 'disabled' });
      assert.strictEqual(disabledUpstream.calls[0].body.reasoning_effort, undefined);
    });
  });

  const fallbackUpstream = await makeChatUpstream({ failMaxToolRequestOnce: true });
  await withProxy(fallbackUpstream, cfg, async () => {
    const response = await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'ignored',
      messages: [{ role: 'user', content: 'use a tool if needed' }],
      tools: [
        { type: 'function', function: { name: 'noop', description: 'No-op', parameters: { type: 'object', properties: {} } } },
      ],
      stream: true,
    });
    check('API-041-6: tool-heavy chat retries once with high effort after upstream 5xx', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(fallbackUpstream.calls.length, 2);
      assert.strictEqual(fallbackUpstream.calls[0].body.reasoning_effort, 'max');
      assert.strictEqual(fallbackUpstream.calls[1].body.reasoning_effort, 'high');
      assert.match(response.body, /stream-ok/);
    });
  });
}

function runHermesPatcherTests() {
  console.log('\n-- Hermes patcher --');
  fs.mkdirSync(path.dirname(hermesConfigPath), { recursive: true });
  const original = [
    'model:',
    '  provider: deepseek',
    '  default: old-model',
    '  base_url: https://openrouter.ai/api/v1',
    '  api_mode: auto',
    'agent:',
    '  reasoning_effort: xhigh',
    'toolsets:',
    '  - browser',
    '',
  ].join('\n');
  fs.writeFileSync(hermesConfigPath, original);
  hermesPatcher.patch({ model: 'deepseek-v4-pro', apiKey: 'sk-never-write-this', thinking: 'enabled', effort: 'max' });
  const patched = fs.readFileSync(hermesConfigPath, 'utf-8');
  check('MIG-042-1: patch writes chat_completions runtime and backs up original config', () => {
    assert.ok(fs.existsSync(`${hermesConfigPath}.deepseek-backup`));
    assert.match(patched, /api_mode: "chat_completions"/);
    assert.match(patched, new RegExp(`base_url: "http://127\\.0\\.0\\.1:${proxyPort}/v1"`));
    assert.match(patched, /provider: "custom"/);
    assert.match(patched, /api_key: "deepseek-claude-local"/);
    assert.doesNotMatch(patched, /codex_app_server/);
  });
  check('KEY-042-1: Hermes config never contains the real provider key', () => {
    assert.ok(!patched.includes('sk-never-write-this'));
  });
  const once = fs.readFileSync(hermesConfigPath, 'utf-8');
  hermesPatcher.patch({ model: 'deepseek-v4-pro', thinking: 'enabled' });
  check('MIG-042-2: patch is idempotent', () => {
    assert.strictEqual(fs.readFileSync(hermesConfigPath, 'utf-8'), once);
    assert.strictEqual((once.match(/api_mode:/g) || []).length, 1);
    assert.strictEqual((once.match(/base_url:/g) || []).length, 1);
  });
  check('ADP-044-1: target status reflects available and patched Hermes config', () => {
    const status = hermesPatcher.getStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.patched, true);
    assert.strictEqual(status.model.api_mode, 'chat_completions');
  });
  const diagnosis = hermesPatcher.diagnose(
    { ok: true, provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'enabled', effort: 'max' },
    { installed: true, scope: 'user', path: '/tmp/deepseek-claude-proxy.service' }
  );
  check('KEY-045-1/AC-045-3: diagnosis redacts key surfaces and records vision boundary', () => {
    const text = JSON.stringify(diagnosis);
    assert.ok(!text.includes('sk-never-write-this'));
    assert.match(text, /browser_vision/);
  });
  let drifted = fs.readFileSync(hermesConfigPath, 'utf-8');
  drifted = drifted.replace(`base_url: "http://127.0.0.1:${proxyPort}/v1"`, 'base_url: "https://openrouter.ai/api/v1"');
  fs.writeFileSync(hermesConfigPath, drifted);
  hermesPatcher.patch({ model: 'deepseek-v4-pro', thinking: 'enabled' });
  check('SWC-044-3: re-patch repairs Hermes config drift back to local proxy', () => {
    const repaired = fs.readFileSync(hermesConfigPath, 'utf-8');
    assert.match(repaired, new RegExp(`base_url: "http://127\\.0\\.0\\.1:${proxyPort}/v1"`));
    assert.strictEqual(hermesPatcher.isPatched(), true);
  });
  hermesPatcher.restore();
  check('MIG-042-3: restore returns config byte-equivalent to original', () => {
    assert.strictEqual(fs.readFileSync(hermesConfigPath, 'utf-8'), original);
    assert.ok(!fs.existsSync(`${hermesConfigPath}.deepseek-backup`));
  });

  const missingPath = path.join(tmp, 'missing', 'config.yaml');
  process.env.HERMES_CONFIG_PATH = missingPath;
  const missingPatcher = freshRequire('../src/hermes-patcher');
  check('MIG-042-4: missing config throws a clear non-destructive error', () => {
    assert.throws(() => missingPatcher.patch({}), /找不到 Hermes config\.yaml/);
    assert.strictEqual(fs.existsSync(missingPath), false);
  });
  process.env.HERMES_CONFIG_PATH = hermesConfigPath;
  freshRequire('../src/hermes-patcher');
}

async function runLinuxAndLifecycleTests() {
  console.log('\n-- Linux systemd adapter and target lifecycle --');
  process.env.DEEPSEEK_CLAUDE_FORCE_SYSTEMD = '1';
  process.env.DEEPSEEK_CLAUDE_DISABLE_SYSTEMD = '';
  process.env.DEEPSEEK_CLAUDE_SYSTEMD_SCOPE = 'user';
  process.env.DEEPSEEK_CLAUDE_SYSTEMD_USER_DIR = path.join(tmp, 'systemd-user');
  const linux = freshRequire('../src/autostart/linux');
  const result = linux.install();
  const unit = fs.readFileSync(linux.unitPath(), 'utf-8');
  check('ADP-043-1: Linux install writes a systemd service for deployed proxy.js', () => {
    assert.strictEqual(result.installed, true);
    assert.match(unit, /DeepSeek Claude Provider Gateway/);
    assert.match(unit, new RegExp(configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(unit, /proxy\.js/);
  });
  linux.uninstall();
  check('AC-043-2: Linux uninstall removes the service file', () => {
    assert.strictEqual(fs.existsSync(linux.unitPath()), false);
  });

  process.env.DEEPSEEK_CLAUDE_FORCE_SYSTEMD = '';
  process.env.DEEPSEEK_CLAUDE_DISABLE_SYSTEMD = '1';
  const noSystemd = freshRequire('../src/autostart/linux');
  const unsupported = noSystemd.install();
  check('ADP-043-2: non-systemd returns unsupported instead of pretending success', () => {
    assert.strictEqual(unsupported.supported, false);
    assert.strictEqual(unsupported.installed, false);
    assert.match(unsupported.message, /手动运行/);
  });
  process.env.DEEPSEEK_CLAUDE_DISABLE_SYSTEMD = '';

  let stopped = false;
  let uninstalled = false;
  const proxy = { stop: async () => { stopped = true; } };
  const autostart = { uninstall: () => { uninstalled = true; } };
  const off = { isPatched: () => false };
  const hermesOn = { isPatched: () => true };
  await ui.maybeStopProxy(proxy, autostart, off, off, hermesOn);
  check('SWC-044-1: Hermes still patched keeps proxy running', () => {
    assert.strictEqual(stopped, false);
    assert.strictEqual(uninstalled, false);
  });

  await ui.maybeStopProxy(proxy, autostart, off, off, off);
  check('SWC-044-2: all targets off stops proxy and uninstalls autostart', () => {
    assert.strictEqual(stopped, true);
    assert.strictEqual(uninstalled, true);
  });

  check('ADP-044-1: targetSnapshot hides unavailable Hermes as unpatched', () => {
    const snapshot = ui.targetSnapshot(off, off, { isAvailable: () => false, isPatched: () => true });
    assert.strictEqual(snapshot.hermesAvailable, false);
    assert.strictEqual(snapshot.hermesPatched, false);
  });
}

async function run() {
  fs.mkdirSync(configDir, { recursive: true });
  proxyBundle.deployProxyBundle(configDir);
  await runProxyTests();
  runHermesPatcherTests();
  await runLinuxAndLifecycleTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

run().catch(async err => {
  console.error(err);
  try { await proxyManager.stop(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
