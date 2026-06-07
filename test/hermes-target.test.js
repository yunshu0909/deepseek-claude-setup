/**
 * Hermes Agent 接管自动化测试
 *
 * 负责：
 * - 验证 Hermes config.yaml 被安全改写到本地 Chat Completions 代理
 * - 验证 /v1/chat/completions 入口覆盖模型、思考字段与工具请求 fallback
 * - 验证 Linux systemd adapter 能生成服务器可用 unit
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
const hermesConfigPath = path.join(tmp, 'hermes-config.yaml');
const proxyPort = 20500 + Math.floor(Math.random() * 1000);
const systemdDir = path.join(tmp, 'systemd');
const proxyLogPath = path.join(tmp, 'gateway.log');

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);
process.env.HERMES_CONFIG_PATH = hermesConfigPath;
process.env.DEEPSEEK_CLAUDE_SYSTEMD_SCOPE = 'system';
process.env.DEEPSEEK_CLAUDE_SYSTEMD_SYSTEM_DIR = systemdDir;
process.env.DEEPSEEK_CLAUDE_LOG_PATH = proxyLogPath;
process.env.DEEPSEEK_CLAUDE_DISABLE_SYSTEMD = '1';

const configStore = require('../src/config-store');
const proxyManager = require('../src/proxy-manager');
const hermesPatcher = require('../src/hermes-patcher');
const linuxAutostart = require('../src/autostart/linux');

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
        Authorization: 'Bearer local-test',
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
  const { failMaxToolsOnce = false } = options;
  const calls = [];
  let failedOnce = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (failMaxToolsOnce && !failedOnce && body.reasoning_effort === 'max' && Array.isArray(body.tools)) {
        failedOnce = true;
        res.writeHead(504, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'tool-heavy timeout' } }));
      }

      const response = JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(response) });
      res.end(response);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }));
  });
}

async function run() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'proxy'), configDir, { recursive: true });

  const cfg = {
    apiKey: 'sk-real-key-never-written-to-hermes',
    model: 'deepseek-v4-pro',
    thinking: 'enabled',
    effort: 'max',
  };
  configStore.write(cfg);

  console.log('\n-- hermes config patcher --');
  fs.writeFileSync(hermesConfigPath, [
    'model:',
    '  provider: "openrouter"',
    '  default: "old-model"',
    '  base_url: "https://old.example/v1"',
    '  api_key: "sk-old-provider-key"',
    'agent:',
    '  reasoning_effort: "medium"',
    '',
  ].join('\n'));

  hermesPatcher.patch(cfg);
  const hermesConfig = fs.readFileSync(hermesConfigPath, 'utf-8');
  check('writes Hermes to local OpenAI Chat Completions proxy', () => {
    assert.match(hermesConfig, /provider: "custom"/);
    assert.match(hermesConfig, /api_mode: "chat_completions"/);
    assert.match(hermesConfig, new RegExp(`base_url: "http://127.0.0.1:${proxyPort}/v1"`));
    assert.match(hermesConfig, /default: "deepseek-v4-pro"/);
  });
  check('does not write the real DeepSeek key into Hermes config.yaml', () => {
    assert.doesNotMatch(hermesConfig, /sk-real-key-never-written-to-hermes/);
    assert.match(hermesConfig, /api_key: "deepseek-claude-local"/);
  });
  check('maps Hermes agent effort to high while proxy keeps max', () => {
    assert.match(hermesConfig, /reasoning_effort: "high"/);
    assert.strictEqual(configStore.read().effort, 'max');
  });
  check('reports patched status without leaking api key', () => {
    const status = hermesPatcher.getStatus();
    assert.strictEqual(status.patched, true);
    assert.strictEqual(status.model.api_key, '****');
  });
  hermesPatcher.restore();
  check('restores original Hermes config from backup', () => {
    const restored = fs.readFileSync(hermesConfigPath, 'utf-8');
    assert.match(restored, /provider: "openrouter"/);
    assert.match(restored, /api_key: "sk-old-provider-key"/);
  });

  console.log('\n-- chat completions endpoint --');
  const upstream = await makeChatUpstream();
  process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL = 'http:';
  process.env.DEEPSEEK_CLAUDE_TARGET_HOST = '127.0.0.1';
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(upstream.port);
  process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX = '';
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'hermes-local-model',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false,
      stream_options: { include_usage: true },
      output_config: { effort: 'should-not-pass-through' },
    });
    check('accepts Hermes/OpenAI Chat Completions requests', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /OK/);
    });
    check('forwards Chat Completions to DeepSeek OpenAI-compatible path', () => {
      assert.strictEqual(upstream.calls[0].url, '/chat/completions');
    });
    check('overrides model and injects DeepSeek thinking fields', () => {
      assert.strictEqual(upstream.calls[0].body.model, cfg.model);
      assert.deepStrictEqual(upstream.calls[0].body.thinking, { type: 'enabled' });
      assert.strictEqual(upstream.calls[0].body.reasoning_effort, 'max');
      assert.strictEqual(upstream.calls[0].body.output_config, undefined);
    });
    check('does not forward stream_options when stream=false', () => {
      assert.strictEqual(upstream.calls[0].body.stream, false);
      assert.strictEqual(upstream.calls[0].body.stream_options, undefined);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstream.server.close(resolve));
  }

  console.log('\n-- tool-heavy fallback --');
  const retryUpstream = await makeChatUpstream({ failMaxToolsOnce: true });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(retryUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/chat/completions', {
      model: 'hermes-local-model',
      messages: [{ role: 'user', content: 'use tools' }],
      tools: [{ type: 'function', function: { name: 'exec', parameters: { type: 'object', properties: {} } } }],
      stream: false,
    });
    check('falls back from max to high on tool-heavy 5xx before replying to client', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(retryUpstream.calls.length, 2);
      assert.strictEqual(retryUpstream.calls[0].body.reasoning_effort, 'max');
      assert.strictEqual(retryUpstream.calls[1].body.reasoning_effort, 'high');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => retryUpstream.server.close(resolve));
  }

  console.log('\n-- linux systemd adapter --');
  check('systemd unit uses system target for root/server scope', () => {
    const unit = linuxAutostart.buildServiceUnit();
    assert.match(unit, /WantedBy=multi-user\.target/);
    assert.match(unit, /ExecStart="/);
    assert.match(unit, /DEEPSEEK_CLAUDE_CONFIG_DIR=/);
    assert.match(unit, /DEEPSEEK_CLAUDE_LOG_PATH=/);
  });
  check('unsupported Linux environment returns explicit status', () => {
    assert.strictEqual(linuxAutostart.isSystemdAvailable(), false);
    assert.strictEqual(linuxAutostart.status().supported, false);
  });
}

run().catch(err => {
  failed++;
  console.error(err);
}).finally(() => {
  console.log(`\nHermes target tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
