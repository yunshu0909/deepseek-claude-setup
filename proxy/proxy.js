/**
 * Provider Gateway 代理服务（server 核心）
 *
 * 负责：
 * - HTTP 入口分发：/__health、/v1/models、Anthropic Messages、Codex Responses、OpenAI Chat
 * - Anthropic Messages 透传 transport（含透明重试 + SSE 诊断嗅探）
 * - 维持常驻进程
 *
 * 设计约束（PRD-005-R STR 门禁）：
 * - 本文件**不出现任何 provider 专用字段名**（思考/工具流/默认模型/上游域名等具体
 *   字段全部下沉到 provider adapter（proxy/providers/*.js），经 gateway 基座驱动）。
 *   STR-1 用 grep 机器校验本文件 0 命中那批字段名。
 * - provider 选择只走 registry，不写 if provider==='xxx' 内联分支。
 * - Codex Responses 的发射器逻辑在 proxy/clients/codex-responses.js。
 *
 * @module proxy/proxy
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { responsesInputToMessages, responsesToolsToChatTools } = require('./codex-input');
const providerRegistry = require('./providers');
const runtimeConfig = require('./runtime-config');
const gateway = require('./gateway');
const codexResponses = require('./clients/codex-responses');
const { formatUsageForLog, normalizeUsage } = require('./usage');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PORT = process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861;
const SERVICE_NAME = 'deepseek-claude-proxy';

// 测试 runner 需要独立日志，避免和用户正常 17861 代理混在一起误判。
const LOG_PATH = process.env.DEEPSEEK_CLAUDE_LOG_PATH || path.join(os.tmpdir(), 'deepseek-claude-proxy.log');

// 测试专用：DEEPSEEK_CAPTURE_THINKING=1 时把模型思考(reasoning)正文落盘到 LOG 同目录的 thinking/ 下，
// 便于核验"思考是否真有意义"。默认关闭——网关也跑在真实用户机器上，不默认记录所有人的思考内容（隐私/磁盘）。
const CAPTURE_THINKING = process.env.DEEPSEEK_CAPTURE_THINKING === '1';
const THINKING_DIR = path.join(path.dirname(LOG_PATH), 'thinking');

// 把一轮思考正文写盘（仅 CAPTURE_THINKING 开启时；Anthropic 与 Codex 两条路径共用）
function writeThinking(id, text) {
  if (!CAPTURE_THINKING || !text) return;
  try {
    fs.mkdirSync(THINKING_DIR, { recursive: true });
    fs.writeFileSync(path.join(THINKING_DIR, `thinking-${id}.txt`), text);
  } catch {}
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`); } catch {}
}

function activeProviderConfig() {
  return CONFIG.providers?.[CONFIG.activeProvider] || {};
}

// provider 选择只走 registry；未知 id 兜底 deepseek（registry 级 id 兜底，非字段硬编码）
function activeProviderDefinition() {
  return providerRegistry.getProvider(CONFIG.activeProvider) || providerRegistry.getProvider('deepseek');
}

function activeCapabilities() {
  return activeProviderDefinition()?.capabilities || {};
}

function providerSupportsThinking() {
  return activeCapabilities().thinking !== false;
}

function providerSupportsThinkingEffort() {
  return activeCapabilities().thinkingEffort !== false;
}

// 默认模型来自 provider 元数据，不在 server 核心写死任何模型名
function providerDefaultModel() {
  const def = activeProviderDefinition();
  return def.defaultModel || def.models?.[0]?.id;
}

function resolvedModel(payloadModel) {
  return CONFIG.model || payloadModel || providerDefaultModel();
}

function resolvedThinking(model) {
  const requested = providerSupportsThinking() ? gateway.normalizeThinking(CONFIG.thinking || 'enabled') : 'unsupported';
  const provider = activeProviderDefinition();
  return typeof provider.resolveThinking === 'function'
    ? provider.resolveThinking({ model: model || CONFIG.model || providerDefaultModel(), thinking: requested })
    : requested;
}

function resolvedEffort() {
  return gateway.normalizeEffort(CONFIG.effort || 'max');
}

function positiveInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function resolvedResponseMaxOutputTokens(payload) {
  return positiveInteger(payload.max_output_tokens)
    || positiveInteger(payload.max_completion_tokens)
    || positiveInteger(payload.max_tokens);
}

function loggedMaxTokens(body) {
  return body.max_completion_tokens || body.max_tokens || '-';
}

function healthBody() {
  const model = CONFIG.model || providerDefaultModel();
  const thinking = resolvedThinking(model);
  return JSON.stringify({
    service: SERVICE_NAME,
    ok: true,
    provider: CONFIG.activeProvider || 'deepseek',
    model,
    thinking: thinking === 'unsupported' ? 'unsupported' : thinking,
    effort: thinking === 'enabled' && providerSupportsThinkingEffort() ? resolvedEffort() : null,
  });
}

/**
 * 处理 Codex Responses API 请求：组装 GatewayRequest → provider adapter → Codex 发射器
 */
function handleResponses(req, res, payload) {
  const model = resolvedModel(payload.model);
  const thinking = resolvedThinking(model);
  const messages = responsesInputToMessages(payload);
  const tools = responsesToolsToChatTools(payload.tools);

  if (tools) {
    log(`RESPONSES_TOOLS count=${tools.length} names=[${tools.map(t => t.function.name).join(',')}]`);
  }

  const gatewayRequest = gateway.makeGatewayRequest({
    model,
    messages,
    tools,
    thinking,
    effort: resolvedEffort(),
    source: 'responses',
    maxOutputTokens: resolvedResponseMaxOutputTokens(payload),
    // Codex Responses 路径上游必须流式（codex-responses 解析 SSE delta）；客户端 stream:false 由下面
    // streamMode='json' 单独聚合，绝不能把 stream:false 透传给上游（否则 DeepSeek 返回非 SSE → empty_stream）。对齐 v1.5.0。
    stream: true,
  });

  const provider = activeProviderDefinition();
  const requestSpec = provider.buildChatRequestSpec(gatewayRequest, activeProviderConfig());

  const streamMode = payload.stream !== false ? 'stream' : 'json';
  const inputTypes = (payload.input || []).map(it => it.type + (it.role ? ':' + it.role : '')).join(',');
  log(`RESPONSES stream=${streamMode} model=${requestSpec.body.model} msgs=${requestSpec.body.messages.length} tools=${!!tools} max_tokens=${loggedMaxTokens(requestSpec.body)} thinking=${thinking} effort=${requestSpec.body.reasoning_effort || '-'} input=[${inputTypes}]`);

  codexResponses.streamChatToResponses(res, requestSpec, streamMode, {
    parseChunk: parsed => provider.parseChatStreamChunk(parsed),
    log,
    captureThinking: writeThinking,
  });
}

function chatPassthroughFields(payload) {
  const fields = [
    'temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty',
    'stop', 'response_format', 'seed', 'n', 'logprobs', 'top_logprobs', 'user',
    'parallel_tool_calls', 'tool_choice',
  ];
  const picked = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) picked[field] = payload[field];
  }
  return picked;
}

/**
 * 处理 OpenAI Chat Completions 透传：Hermes 等 OpenAI SDK 客户端走这条入口。
 * @param {object} req - Node HTTP request
 * @param {object} res - Node HTTP response
 * @param {object} payload - OpenAI Chat Completions 请求体
 * @returns {void}
 */
function handleChatCompletions(req, res, payload) {
  const model = resolvedModel(payload.model);
  const thinking = resolvedThinking(model);
  const provider = activeProviderDefinition();
  const gatewayRequest = gateway.makeGatewayRequest({
    model,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    tools: payload.tools,
    thinking,
    effort: resolvedEffort(),
    source: 'chat',
    stream: payload.stream !== false,
  });
  const requestSpec = provider.buildChatRequestSpec(gatewayRequest, activeProviderConfig());
  requestSpec.body = {
    ...requestSpec.body,
    ...chatPassthroughFields(payload),
    model: gatewayRequest.model,
    messages: gatewayRequest.conversation.messages,
    stream: payload.stream !== false,
  };
  if (payload.tools) requestSpec.body.tools = payload.tools;
  if (payload.tool_choice) requestSpec.body.tool_choice = payload.tool_choice;

  const target = requestSpec.target;
  const baseHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!['host', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      baseHeaders[key] = value;
    }
  }
  baseHeaders['Content-Type'] = 'application/json';
  baseHeaders.authorization = `Bearer ${requestSpec.apiKey}`;

  const client = target.protocol === 'http:' ? http : https;
  const started = Date.now();
  let retriesLeft = 1;
  let connected = false;

  function canDowngradeToolEffort(body) {
    return body.reasoning_effort === 'max' && Array.isArray(body.tools) && body.tools.length > 0;
  }

  function attempt(body, allowEffortDowngrade) {
    const bodyOut = JSON.stringify(body);
    const headers = {
      ...baseHeaders,
      'Content-Length': Buffer.byteLength(bodyOut),
    };
    const upstream = client.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'POST',
      headers,
      rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
    }, upstreamRes => {
      connected = true;
      if (res.headersSent) return;
      if (upstreamRes.statusCode >= 500 && allowEffortDowngrade && canDowngradeToolEffort(body)) {
        upstreamRes.resume();
        upstreamRes.on('end', () => {
          const downgraded = { ...body, reasoning_effort: 'high' };
          connected = false;
          log(`CHAT_RETRY model=${body.model} tools=${body.tools.length} status=${upstreamRes.statusCode} effort=max->high`);
          attempt(downgraded, false);
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      const isStream = (upstreamRes.headers['content-type'] || '').includes('event-stream');
      let rawUsage = null;
      let lineBuf = '';
      let jsonBuf = '';
      upstreamRes.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (isStream) {
          lineBuf += text;
          const lines = lineBuf.split(/\r?\n/);
          lineBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              if (evt.usage) rawUsage = { ...(rawUsage || {}), ...evt.usage };
            } catch {}
          }
        } else if (jsonBuf.length < 2 * 1024 * 1024) {
          jsonBuf += text;
        }
      });
      upstreamRes.on('end', () => {
        if (!isStream && jsonBuf) {
          try {
            const j = JSON.parse(jsonBuf);
            if (j.usage) rawUsage = { ...(rawUsage || {}), ...j.usage };
          } catch {}
        }
        const normalizedUsage = normalizeUsage(rawUsage);
        const elapsed = Date.now() - started;
        const level = upstreamRes.statusCode >= 400 ? 'CHAT_FAILED' : 'CHAT_DONE';
        log(`${level} model=${body.model} stream=${body.stream !== false} status=${upstreamRes.statusCode} ${formatUsageForLog(normalizedUsage)} ${elapsed}ms`);
      });
      upstreamRes.pipe(res);
    });

    upstream.setTimeout(300000, () => {
      upstream.destroy();
      if (!res.headersSent) {
        log(`CHAT_FAILED model=${body.model} stream=${body.stream !== false} status=504 timeout`);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      }
    });

    upstream.on('error', err => {
      const canRetry = !connected && !res.headersSent && retriesLeft > 0;
      log(`CHAT_ERROR: ${err.message}${canRetry ? ' (retry in 500ms)' : ''}`);
      if (canRetry) {
        retriesLeft--;
        setTimeout(attempt, 500);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    upstream.write(bodyOut);
    upstream.end();
  }

  log(
    `CHAT_POST ${req.url} model=${payload.model || '?'}->${requestSpec.body.model} `
    + `msgs=${requestSpec.body.messages.length} tools=${Array.isArray(requestSpec.body.tools) ? requestSpec.body.tools.length : 0} `
    + `max_tokens=${loggedMaxTokens(requestSpec.body)} thinking=${thinking} effort=${requestSpec.body.reasoning_effort || '-'}`
  );
  attempt(requestSpec.body, true);
}

/**
 * 处理 Anthropic Messages 透传：provider adapter 决定 mutation + target，core 负责 transport
 */
function handleAnthropic(req, res, payload) {
  const incomingModel = payload.model || '?';
  const model = resolvedModel(payload.model);
  const thinking = resolvedThinking(model);
  const provider = activeProviderDefinition();
  const { target, payload: mutated } = provider.buildAnthropicRequestSpec(
    payload,
    activeProviderConfig(),
    { model, thinking, effort: resolvedEffort(), requestUrl: req.url },
  );

  const bodyOut = JSON.stringify(mutated);
  // 日志用 core 请求 adapter 注入的 effort 意图（不窥探 provider 专用字段名）
  const loggedEffort = thinking === 'enabled' && providerSupportsThinkingEffort() ? resolvedEffort() : 'off';
  log(`POST ${req.url} | model=${incomingModel}->${mutated.model} | thinking=${thinking} | effort=${loggedEffort}`);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!['host', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      headers[key] = value;
    }
  }
  const apiKey = activeProviderConfig().apiKey;
  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = Buffer.byteLength(bodyOut);
  headers['x-api-key'] = apiKey;
  headers.authorization = `Bearer ${apiKey}`;
  headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';

  const client = target.protocol === 'http:' ? http : https;
  const reqStartTs = Date.now();
  let anthropicRetriesLeft = 1;
  let anthropicConnected = false;

  function anthropicAttempt() {
    const upstream = client.request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'POST',
      headers,
      rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
    }, upstreamRes => {
      anthropicConnected = true;
      if (res.headersSent) return;
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

      // 嗅探 SSE 流统计 thinking/text 字符数（仅诊断，不影响透传；Anthropic 协议中立）
      const isStream = (upstreamRes.headers['content-type'] || '').includes('event-stream');
      let thinkingChars = 0;
      let thinkingText = '';
      let textChars = 0;
      let rawUsage = null;
      let lineBuf = '';
      let jsonBuf = '';

      upstreamRes.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (isStream) {
          lineBuf += text;
          const lines = lineBuf.split(/\r?\n/);
          lineBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === 'content_block_delta') {
                if (evt.delta?.type === 'thinking_delta') { thinkingChars += (evt.delta.thinking || '').length; if (CAPTURE_THINKING) thinkingText += (evt.delta.thinking || ''); }
                if (evt.delta?.type === 'text_delta') textChars += (evt.delta.text || '').length;
              }
              if (evt.type === 'message_delta' && evt.usage) {
                rawUsage = { ...(rawUsage || {}), ...evt.usage };
              }
              if (evt.type === 'message_start' && evt.message?.usage) {
                rawUsage = { ...(rawUsage || {}), ...evt.message.usage };
              }
            } catch {}
          }
        } else {
          jsonBuf += text;
        }
      });

      upstreamRes.on('end', () => {
        if (!isStream && jsonBuf) {
          try {
            const j = JSON.parse(jsonBuf);
            for (const block of j.content || []) {
              if (block.type === 'thinking') { thinkingChars += (block.thinking || '').length; if (CAPTURE_THINKING) thinkingText += (block.thinking || ''); }
              if (block.type === 'text') textChars += (block.text || '').length;
            }
            if (j.usage) rawUsage = { ...(rawUsage || {}), ...j.usage };
          } catch {}
        }
        const normalizedUsage = normalizeUsage(rawUsage);
        const elapsed = Date.now() - reqStartTs;
        log(
          `MSG_DONE model=${mutated.model} `
          + `thinking=${thinkingChars > 0 ? `Y(${thinkingChars}chars)` : 'N'} `
          + `text=${textChars}chars stream=${isStream} `
          + `${formatUsageForLog(normalizedUsage)} ${elapsed}ms`
        );
        // 测试开关开启时，把本轮思考正文落盘（默认关闭，不影响真实用户与默认测试行为）
        writeThinking(reqStartTs, thinkingText);
      });

      upstreamRes.pipe(res);
    });

    upstream.setTimeout(300000, () => {
      upstream.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      }
    });

    upstream.on('error', err => {
      const canRetry = !anthropicConnected && !res.headersSent && anthropicRetriesLeft > 0;
      log(`ERROR: ${err.message}${canRetry ? ' (retry in 500ms)' : ''}`);
      if (canRetry) {
        anthropicRetriesLeft--;
        setTimeout(anthropicAttempt, 500);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    upstream.write(bodyOut);
    upstream.end();
  }
  anthropicAttempt();
}

// 测试用 require-smoke：DEEPSEEK_CLAUDE_SMOKE=1 时只验 require 链路 + deepseek adapter 可解析，
// 不读 config、不 listen（US-03 原子部署的 staging 校验依赖此守卫）。
if (process.env.DEEPSEEK_CLAUDE_SMOKE === '1') {
  if (!providerRegistry.getProvider('deepseek')) {
    console.error('SMOKE_FAIL: deepseek adapter missing');
    process.exit(3);
  }
  console.log('SMOKE_OK');
  process.exit(0);
}

let CONFIG;
try {
  CONFIG = runtimeConfig.readConfig(CONFIG_PATH);
} catch (e) {
  log(`FATAL: 配置加载失败 - ${e.message}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__health') {
    const body = healthBody();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (req.url === '/__stop') {
    log('收到停止信号');
    res.writeHead(200);
    res.end('ok');
    server.close(() => process.exit(0));
    return;
  }

  // Codex 启动时拉取模型列表
  // supported_reasoning_levels 必填且是 ReasoningEffortPreset 结构体数组（不是字符串）。
  // 结构体格式我们不确定，给空数组绕过解析（codex 有 fallback 到 -c 配置）
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    const modelId = CONFIG.model || providerDefaultModel();
    const modelEntry = {
      id: modelId, object: 'model', created: 1700000000, owned_by: CONFIG.activeProvider || 'deepseek',
      slug: modelId, display_name: modelId,
      supported_reasoning_levels: [],
    };
    const body = JSON.stringify({
      object: 'list',
      data: [modelEntry],
      models: [modelEntry],
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }

  if (req.method !== 'POST') {
    res.writeHead(501);
    return res.end('POST only');
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString());
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }));
    }

    if (req.url.startsWith('/v1/responses') || req.url.startsWith('/responses')) {
      return handleResponses(req, res, payload);
    }
    if (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/chat/completions')) {
      return handleChatCompletions(req, res, payload);
    }
    return handleAnthropic(req, res, payload);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用`);
    process.exit(1);
  }
  log(`FATAL: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const model = CONFIG.model || providerDefaultModel();
  const thinking = resolvedThinking(model);
  const effort = thinking === 'enabled' && providerSupportsThinkingEffort() ? resolvedEffort() : 'off';
  log(`代理启动 localhost:${PORT} provider=${CONFIG.activeProvider || 'deepseek'} model=${model} thinking=${thinking} effort=${effort}`);
});
