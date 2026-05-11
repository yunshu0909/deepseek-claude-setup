/**
 * Provider key / 接入连通性验证
 *
 * 负责：
 * - 按 active provider 的 anthropicBaseUrl + 默认模型发最小 Anthropic Messages 请求验证 key 有效性
 * - 按 active provider 的 capabilities 决定 thinking / output_config 字段，避免向不兼容 provider 发专属字段
 * - 通过本地 gateway 验证完整接入链路（验 Claude Code 接入按钮的 spinner）
 *
 * @module src/verifier
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const providerRegistry = require('../proxy/providers');

function getProvider(providerOrId) {
  if (!providerOrId) return providerRegistry.getProvider('deepseek');
  if (typeof providerOrId === 'string') return providerRegistry.getProvider(providerOrId);
  return providerOrId;
}

/**
 * 拼出 Anthropic Messages 完整 endpoint
 * @param {string} anthropicBaseUrl - 如 https://api.deepseek.com/anthropic
 * @returns {{hostname, port, path, protocol}} url 各部分；path 已含 /v1/messages 后缀
 */
function resolveAnthropicTarget(anthropicBaseUrl) {
  const u = new URL(anthropicBaseUrl);
  const basePath = u.pathname.replace(/\/+$/, '');
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443),
    path: `${basePath}/v1/messages`,
    protocol: u.protocol,
  };
}

/**
 * 用 provider 自身 endpoint 校验 API key 是否有效
 * @param {object|string} providerOrId - provider 对象或 id；不传则按 deepseek 兼容
 * @param {string} apiKey - 用户输入的 API key
 * @returns {Promise<boolean>} true 表示 key 有效
 */
function checkApiKey(providerOrId, apiKey) {
  const provider = getProvider(providerOrId);
  if (!provider) return Promise.resolve(false);
  // 没有 Anthropic 兼容端点的 provider（如纯 OpenAI 兼容），这条路径校验不了，
  // 上层调用方应直接接受 key 不阻塞流程。
  const anthropicBaseUrl = provider.defaults?.anthropicBaseUrl;
  if (!anthropicBaseUrl) return Promise.resolve(true);

  const model = provider.models?.[0]?.id;
  const target = resolveAnthropicTarget(anthropicBaseUrl);
  const client = target.protocol === 'http:' ? http : https;

  return new Promise(resolve => {
    const body = JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = client.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      timeout: 10000,
      rejectUnauthorized: false,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString());
          resolve(res.statusCode >= 200 && res.statusCode < 300 && (r.type === 'message' || !r.error));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * 通过本地 gateway 验证完整接入链路
 * @param {object} config - 归一化后的 gateway 配置（含 activeProvider + 顶层 model/thinking/effort 兼容字段）
 * @returns {Promise<{ok: boolean, hasThinking?: boolean, error?: string}>}
 */
function verify(config = {}) {
  const provider = getProvider(config.activeProvider);
  const caps = provider?.capabilities || {};
  const model = config.model || provider?.models?.[0]?.id;
  const thinking = config.thinking === 'disabled' ? 'disabled' : 'enabled';

  return new Promise(resolve => {
    const payload = {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    };
    // thinking 字段：provider 声明支持时才发；budget_tokens 是 DeepSeek 特性，
    // 智谱不需要也不报错，但留下来对智谱无副作用，简洁起见统一只在支持 thinking 时发。
    if (caps.thinking) {
      payload.thinking = { type: thinking, budget_tokens: 32768 };
    }
    // output_config.effort 是 DeepSeek Anthropic 路径专属，按 capability 决定是否注入；
    // 智谱 thinkingEffort=false，不发；DeepSeek thinkingEffort 默认未声明，按真实生效字段发。
    if (caps.thinking && thinking === 'enabled' && caps.thinkingEffort !== false) {
      payload.output_config = { effort: config.effort || 'max' };
    }
    const body = JSON.stringify(payload);

    const req = http.request({
      hostname: '127.0.0.1',
      port: process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const r = JSON.parse(Buffer.concat(chunks).toString());
            const hasThinking = r.content && r.content.some(b => b.type === 'thinking');
            resolve({ ok: true, hasThinking });
          } catch (err) {
            resolve({ ok: false, error: `解析响应失败: ${err.message}` });
          }
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '验证超时' }); });
    req.write(body);
    req.end();
  });
}

module.exports = { verify, checkApiKey };
