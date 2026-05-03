const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-claude-setup-'));
const configDir = path.join(tmp, '.deepseek-claude');
const claudeDir = path.join(tmp, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const proxyPort = 19000 + Math.floor(Math.random() * 1000);

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);

const configStore = require('./src/config-store');
const settingsPatcher = require('./src/settings-patcher');
const proxyManager = require('./src/proxy-manager');

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
        'anthropic-version': '2023-06-01',
      },
      timeout: 5000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
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

function makeUpstream() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(raw),
      });
      const response = JSON.stringify({
        type: 'message',
        content: [
          { type: 'thinking', thinking: 'stub thinking' },
          { type: 'text', text: 'pong' },
        ],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(response) });
      res.end(response);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

async function run() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'proxy', 'proxy.js'), path.join(configDir, 'proxy.js'));

  const originalSettings = {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'old-model',
    },
    effortLevel: 'xhigh',
  };
  fs.writeFileSync(settingsPath, JSON.stringify(originalSettings, null, 2));

  const cfg = {
    apiKey: 'sk-test-key',
    model: 'deepseek-v4-flash',
    effort: 'high',
  };

  console.log('\n-- config-store --');
  configStore.write(cfg);
  check('writes and reads selected model/effort', () => {
    assert.deepStrictEqual(configStore.read(), cfg);
  });

  console.log('\n-- settings-patcher --');
  settingsPatcher.patch(cfg);
  const patched = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check('points Claude Code at the local proxy', () => {
    assert.strictEqual(patched.env.ANTHROPIC_BASE_URL, `http://localhost:${proxyPort}`);
  });
  check('writes Claude Code model env and top-level model', () => {
    assert.strictEqual(patched.env.ANTHROPIC_MODEL, cfg.model);
    assert.strictEqual(patched.env.ANTHROPIC_DEFAULT_OPUS_MODEL, cfg.model);
    assert.strictEqual(patched.env.ANTHROPIC_DEFAULT_SONNET_MODEL, cfg.model);
    assert.strictEqual(patched.model, cfg.model);
  });
  check('writes effort and thinking defaults', () => {
    assert.strictEqual(patched.env.CLAUDE_CODE_EFFORT_LEVEL, cfg.effort);
    assert.strictEqual(patched.effortLevel, cfg.effort);
    assert.strictEqual(patched.alwaysThinkingEnabled, true);
  });
  check('writes auth token from saved DeepSeek key', () => {
    assert.strictEqual(patched.env.ANTHROPIC_AUTH_TOKEN, cfg.apiKey);
  });
  settingsPatcher.patch({ ...cfg, model: 'deepseek-v4-pro', effort: 'max' });
  settingsPatcher.restore();
  check('restores the original settings after repeated patch calls', () => {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), originalSettings);
  });
  settingsPatcher.patch(cfg);
  fs.unlinkSync(settingsPath + '.deepseek-backup');
  settingsPatcher.restore();
  const fallbackRestored = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check('fallback restore never leaves Claude Code pointed at the stopped proxy', () => {
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_BASE_URL, settingsPatcher.DIRECT_URL);
    assert.notStrictEqual(fallbackRestored.env.ANTHROPIC_BASE_URL, settingsPatcher.PROXY_URL);
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_AUTH_TOKEN, cfg.apiKey);
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_MODEL, cfg.model);
  });

  console.log('\n-- proxy injection --');
  const upstream = await makeUpstream();
  process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL = 'http:';
  process.env.DEEPSEEK_CLAUDE_TARGET_HOST = '127.0.0.1';
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(upstream.port);
  process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX = '/anthropic';

  configStore.write(cfg);
  await proxyManager.start();
  try {
    const health = await proxyManager.getHealth();
    check('reports its selected model and effort through health check', () => {
      assert.strictEqual(health.model, cfg.model);
      assert.strictEqual(health.effort, cfg.effort);
      assert.strictEqual(health.thinking, 'enabled');
    });

    const response = await requestJson(proxyPort, '/v1/messages?beta=true', {
      model: 'deepseek-v4-pro',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'disabled', budget_tokens: 1 },
      output_config: { effort: 'max' },
    });

    check('proxy response is forwarded from upstream', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /pong/);
    });
    check('forwards to the DeepSeek Anthropic path with query string preserved', () => {
      assert.strictEqual(upstream.calls[0].url, '/anthropic/v1/messages?beta=true');
    });
    check('overrides model, thinking mode, and output_config.effort', () => {
      assert.strictEqual(upstream.calls[0].body.model, cfg.model);
      assert.deepStrictEqual(upstream.calls[0].body.thinking, { type: 'enabled', budget_tokens: 1 });
      assert.deepStrictEqual(upstream.calls[0].body.output_config, { effort: cfg.effort });
    });
    check('uses saved DeepSeek API key for upstream auth', () => {
      assert.strictEqual(upstream.calls[0].headers['x-api-key'], cfg.apiKey);
      assert.strictEqual(upstream.calls[0].headers.authorization, `Bearer ${cfg.apiKey}`);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstream.server.close(resolve));
  }

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
