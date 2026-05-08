/**
 * Provider runtime 测试
 *
 * 负责：
 * - 验证 proxy 进程能读取 v0.5 Provider Gateway 结构配置
 * - 验证 provider endpoint 能驱动 Anthropic 与 Chat 两条上游路径
 * - 防止代理运行时重新退回 DeepSeek-only 硬编码 URL
 *
 * @module test/provider-runtime
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-provider-runtime-'));
const configDir = path.join(tmp, '.deepseek-claude');
const proxyPort = 21000 + Math.floor(Math.random() * 1000);

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);

const proxyBundle = require('../src/proxy-bundle');
const proxyManager = require('../src/proxy-manager');

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

function requestJson(requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
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

function makeProviderUpstream() {
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
        body: raw ? JSON.parse(raw) : null,
      });

      if (req.url === '/openai/chat/custom') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'provider chat ok' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }

      const response = JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'provider anthropic ok' }],
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
  proxyBundle.deployProxyBundle(configDir);

  const upstream = await makeProviderUpstream();
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    activeProvider: 'zai',
    thinking: 'enabled',
    effort: 'high',
    providers: {
      zai: {
        apiKey: 'zai-provider-runtime',
        model: 'glm-5.1',
        baseUrl: `http://127.0.0.1:${upstream.port}/openai`,
        chatPath: '/chat/custom',
        anthropicBaseUrl: `http://127.0.0.1:${upstream.port}/custom-anthropic`,
      },
    },
  }, null, 2));

  console.log('\n-- provider runtime proxy --');
  await proxyManager.start();
  try {
    const health = await proxyManager.getHealth();
    check('health exposes active provider and model from provider config', () => {
      assert.strictEqual(health.provider, 'zai');
      assert.strictEqual(health.model, 'glm-5.1');
      assert.strictEqual(health.effort, 'high');
    });

    const anthropic = await requestJson('/v1/messages?beta=true', {
      model: 'ignored',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }],
    });
    check('Anthropic path uses provider anthropicBaseUrl', () => {
      assert.strictEqual(anthropic.statusCode, 200);
      assert.strictEqual(upstream.calls[0].url, '/custom-anthropic/v1/messages?beta=true');
      assert.strictEqual(upstream.calls[0].headers['x-api-key'], 'zai-provider-runtime');
    });

    const responses = await requestJson('/v1/responses', {
      model: 'ignored',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
    });
    check('Responses path uses provider OpenAI Chat endpoint', () => {
      assert.strictEqual(responses.statusCode, 200);
      assert.strictEqual(upstream.calls[1].url, '/openai/chat/custom');
      assert.strictEqual(upstream.calls[1].headers.authorization, 'Bearer zai-provider-runtime');
      assert.strictEqual(upstream.calls[1].body.model, 'glm-5.1');
      assert.match(responses.body, /provider chat ok/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstream.server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(async err => {
  console.error(err);
  try { await proxyManager.stop(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
