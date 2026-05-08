#!/usr/bin/env node
/**
 * Provider 真实接口 smoke 测试脚本
 *
 * 负责：
 * - 用临时配置目录启动本地 Provider Gateway
 * - 通过当前 provider 的真实 API Key 测 Anthropic 与 Responses 两条路径
 * - 不写入用户真实 ~/.deepseek-claude、~/.claude 或 ~/.codex 配置
 *
 * @module scripts/provider-smoke
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const providerId = process.env.PROVIDER_SMOKE_PROVIDER || 'zai';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-provider-smoke-'));
const configDir = path.join(tmp, '.deepseek-claude');
const proxyPort = 22000 + Math.floor(Math.random() * 1000);

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);

const providerRegistry = require('../src/providers');
const proxyBundle = require('../src/proxy-bundle');
const proxyManager = require('../src/proxy-manager');

const API_KEY_ENV = {
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_CLAUDE_API_KEY'],
  zai: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'DEEPSEEK_CLAUDE_ZAI_API_KEY'],
};

function apiKeyForProvider(id) {
  for (const name of API_KEY_ENV[id] || []) {
    if (process.env[name]) return process.env[name];
  }
  return process.env.PROVIDER_SMOKE_API_KEY || '';
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
      timeout: 60000,
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

function assertOk(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`);
  }
  console.log(`  OK ${name}`);
}

async function run() {
  const provider = providerRegistry.getProvider(providerId);
  if (!provider) {
    throw new Error(`unknown provider: ${providerId}`);
  }

  const apiKey = apiKeyForProvider(providerId);
  if (!apiKey) {
    const names = [...(API_KEY_ENV[providerId] || []), 'PROVIDER_SMOKE_API_KEY'];
    console.error(`Missing API key. Set one of: ${names.join(', ')}`);
    process.exit(2);
  }

  const model = process.env.PROVIDER_SMOKE_MODEL || provider.models[0]?.id;
  const providerConfig = provider.normalizeConfig({
    apiKey,
    model,
    baseUrl: process.env.PROVIDER_SMOKE_BASE_URL,
    anthropicBaseUrl: process.env.PROVIDER_SMOKE_ANTHROPIC_BASE_URL,
  });
  const thinking = process.env.PROVIDER_SMOKE_THINKING
    || (provider.capabilities?.thinking === false ? 'disabled' : 'enabled');
  fs.mkdirSync(configDir, { recursive: true });
  proxyBundle.deployProxyBundle(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    activeProvider: providerId,
    thinking,
    effort: 'high',
    providers: {
      [providerId]: providerConfig,
    },
  }, null, 2));

  console.log(`\n-- live provider smoke: ${provider.displayName} (${model}) --`);
  await proxyManager.start();
  try {
    const health = await proxyManager.getHealth();
    assertOk('gateway health', health?.provider === providerId && health?.model === model, JSON.stringify(health));

    const anthropic = await requestJson('/v1/messages', {
      model: 'ignored-by-gateway',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    });
    assertOk('Anthropic Messages path HTTP 2xx', anthropic.statusCode >= 200 && anthropic.statusCode < 300, anthropic.body.slice(0, 300));
    assertOk('Anthropic Messages path non-empty body', anthropic.body.length > 0);

    const responses = await requestJson('/v1/responses', {
      model: 'ignored-by-gateway',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: pong' }] }],
      stream: false,
    });
    assertOk('Responses bridge HTTP 2xx', responses.statusCode >= 200 && responses.statusCode < 300, responses.body.slice(0, 300));
    const parsed = JSON.parse(responses.body);
    assertOk('Responses bridge completed', parsed.status === 'completed', responses.body.slice(0, 300));
    assertOk('Responses bridge output_text present', typeof parsed.output_text === 'string' && parsed.output_text.length > 0);
  } finally {
    await proxyManager.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run().catch(async err => {
  console.error(err.message);
  try { await proxyManager.stop(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
