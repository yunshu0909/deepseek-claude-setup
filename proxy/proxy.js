/**
 * Provider Gateway 代理服务
 *
 * 负责：
 * - Anthropic Messages 路径透传到 active provider，并按 provider 能力注入参数
 * - Codex Responses API 翻译到 active provider Chat Completions（含真流式状态机）
 * - 维持 LaunchAgent 拉起的常驻进程，提供 /__health 健康检查
 *
 * @module proxy/proxy
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { responsesInputToMessages, responsesToolsToChatTools } = require('./codex-input');
const providerRegistry = require('./providers');
const runtimeConfig = require('./runtime-config');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PORT = process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861;
const SERVICE_NAME = 'deepseek-claude-proxy';

// 测试 runner 需要独立日志，避免和用户正常 17861 代理混在一起误判。
const LOG_PATH = process.env.DEEPSEEK_CLAUDE_LOG_PATH || path.join(os.tmpdir(), 'deepseek-claude-proxy.log');

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`); } catch {}
}

function normalizeEffort(effort) {
  if (effort === 'max' || effort === 'xhigh') return 'max';
  return 'high';
}

function normalizeThinking(thinking) {
  return thinking === 'disabled' ? 'disabled' : 'enabled';
}

function generateCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`;
}

function activeProviderConfig() {
  return CONFIG.providers?.[CONFIG.activeProvider] || {};
}

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

function providerSupportsAnthropicThinking() {
  return activeCapabilities().anthropicThinking !== false;
}

function endpointFromUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'http:' ? 80 : 443),
    pathname,
  };
}

function joinPath(prefix, suffix) {
  const left = (prefix || '').replace(/\/$/, '');
  const right = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${left}${right}`;
}

function legacyEnvTarget(pathPrefix, suffix) {
  if (!process.env.DEEPSEEK_CLAUDE_TARGET_HOST) return null;
  return {
    protocol: process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL || 'https:',
    hostname: process.env.DEEPSEEK_CLAUDE_TARGET_HOST,
    port: process.env.DEEPSEEK_CLAUDE_TARGET_PORT ? Number(process.env.DEEPSEEK_CLAUDE_TARGET_PORT) : 443,
    path: joinPath(pathPrefix, suffix),
  };
}

function chatTarget() {
  const providerConfig = activeProviderConfig();
  const chatPath = providerConfig.chatPath || '/chat/completions';
  const legacy = legacyEnvTarget(process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX || '', chatPath);
  if (legacy) return legacy;
  const endpoint = endpointFromUrl(providerConfig.baseUrl || 'https://api.deepseek.com');
  return { ...endpoint, path: joinPath(endpoint.pathname, chatPath) };
}

function anthropicTarget(requestUrl) {
  const legacy = legacyEnvTarget(process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX || '/anthropic', requestUrl);
  if (legacy) return legacy;
  const endpoint = endpointFromUrl(activeProviderConfig().anthropicBaseUrl || 'https://api.deepseek.com/anthropic');
  return { ...endpoint, path: joinPath(endpoint.pathname, requestUrl) };
}

function healthBody() {
  const thinking = providerSupportsThinking() ? normalizeThinking(CONFIG.thinking || 'enabled') : 'unsupported';
  return JSON.stringify({
    service: SERVICE_NAME,
    ok: true,
    provider: CONFIG.activeProvider || 'deepseek',
    model: CONFIG.model || 'deepseek-v4-pro',
    thinking,
    effort: thinking === 'enabled' && providerSupportsThinkingEffort() ? normalizeEffort(CONFIG.effort || 'max') : null,
  });
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Codex Responses API 流式状态机 — 把 DeepSeek Chat Completions SSE 翻译成 Responses API SSE
 *
 * 关键设计：
 * - reasoning / message / function_call 各自是独立的 output_item（不共用一个 message item）
 * - 每个 item 严格走完整 6 步：
 *     output_item.added → content_part.added → *.delta+ → *.done → content_part.done → output_item.done
 *   （function_call item 不用 content_part，直接 added → arguments.delta+ → arguments.done → output_item.done）
 * - function_call item 的 id 与 call_id 同值，前缀 "call_"，避免 Codex 用前缀错配
 * - tool_calls 按 index 累积（理论上 DeepSeek 不并行，但保留扩展空间）
 *
 * @param {object} res - Codex 侧的 HTTP response
 * @param {object} chatPayload - 已注入 reasoning_effort 等的 Chat Completions 请求体
 * @param {string} streamMode - 'stream' | 'json'
 */
function streamChatToResponses(res, chatPayload, streamMode) {
  const responseId = `resp_${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  let seq = 0;
  let streamTerminated = false;
  // phase: idle | reasoning | message | tool_call
  let phase = 'idle';
  let currentItem = null;
  // 多 tool_call 累积：Map<index, {callId, name, args, output_index}>
  const toolCallsByIndex = new Map();
  const outputItems = [];
  let responseUsage = null;
  let sawAnyDelta = false;
  // 思考验证统计：reasoningChars=0 说明 DeepSeek 实际没启用思考（不论请求里发了什么 effort）
  let reasoningChars = 0;
  let textChars = 0;
  const reqStartTs = Date.now();

  function emit(event) {
    event.sequence_number = seq++;
    if (streamMode === 'stream') sendSse(res, event);
  }

  function emitCreated() {
    const response = {
      id: responseId, object: 'response', created_at: createdAt, status: 'in_progress',
      model: chatPayload.model, output: [],
    };
    emit({ type: 'response.created', response });
    emit({ type: 'response.in_progress', response: { ...response } });
  }

  // -------- reasoning item --------

  function startReasoningItem() {
    const itemId = `rs_${Date.now()}_${outputIndex}`;
    currentItem = { id: itemId, type: 'reasoning', output_index: outputIndex, text: '' };
    const item = { id: itemId, type: 'reasoning', status: 'in_progress', summary: [], content: [] };
    emit({ type: 'response.output_item.added', output_index: outputIndex, item });
    const part = { type: 'reasoning_text', text: '' };
    emit({ type: 'response.content_part.added', output_index: outputIndex, item_id: itemId, content_index: 0, part });
  }

  function appendReasoning(deltaText) {
    currentItem.text += deltaText;
    reasoningChars += deltaText.length;
    emit({
      type: 'response.reasoning_text.delta',
      output_index: currentItem.output_index, item_id: currentItem.id, content_index: 0,
      delta: deltaText,
    });
  }

  function closeReasoningItem() {
    const { id, output_index, text } = currentItem;
    emit({ type: 'response.reasoning_text.done', output_index, item_id: id, content_index: 0, text });
    const part = { type: 'reasoning_text', text };
    emit({ type: 'response.content_part.done', output_index, item_id: id, content_index: 0, part });
    const item = { id, type: 'reasoning', status: 'completed', summary: [], content: [{ type: 'reasoning_text', text }] };
    emit({ type: 'response.output_item.done', output_index, item });
    outputItems.push(item);
    outputIndex++;
    currentItem = null;
  }

  // -------- message item --------

  function startMessageItem() {
    const itemId = `msg_${Date.now()}_${outputIndex}`;
    currentItem = { id: itemId, type: 'message', output_index: outputIndex, text: '' };
    const item = { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    emit({ type: 'response.output_item.added', output_index: outputIndex, item });
    const part = { type: 'output_text', text: '', annotations: [] };
    emit({ type: 'response.content_part.added', output_index: outputIndex, item_id: itemId, content_index: 0, part });
  }

  function appendMessage(deltaText) {
    currentItem.text += deltaText;
    textChars += deltaText.length;
    emit({
      type: 'response.output_text.delta',
      output_index: currentItem.output_index, item_id: currentItem.id, content_index: 0,
      delta: deltaText,
    });
  }

  function closeMessageItem() {
    const { id, output_index, text } = currentItem;
    emit({ type: 'response.output_text.done', output_index, item_id: id, content_index: 0, text });
    const part = { type: 'output_text', text, annotations: [] };
    emit({ type: 'response.content_part.done', output_index, item_id: id, content_index: 0, part });
    const item = { id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    emit({ type: 'response.output_item.done', output_index, item });
    outputItems.push(item);
    outputIndex++;
    currentItem = null;
  }

  // -------- function_call item --------

  function ensureToolCall(index, upstreamId, name) {
    let tc = toolCallsByIndex.get(index);
    if (!tc) {
      const callId = upstreamId && /^call_/.test(upstreamId) ? upstreamId : generateCallId();
      tc = { callId, name: name || '', args: '', output_index: outputIndex, opened: false };
      toolCallsByIndex.set(index, tc);
      outputIndex++; // 提前占位，避免后续 reasoning/message 抢同一个 output_index
    }
    if (name && !tc.name) tc.name = name;
    return tc;
  }

  function openToolCallItem(tc) {
    if (tc.opened) return;
    tc.opened = true;
    const item = { id: tc.callId, type: 'function_call', call_id: tc.callId, name: tc.name, arguments: '', status: 'in_progress' };
    emit({ type: 'response.output_item.added', output_index: tc.output_index, item });
  }

  function appendToolCallArgs(tc, deltaText) {
    if (!tc.opened) openToolCallItem(tc);
    tc.args += deltaText;
    emit({
      type: 'response.function_call_arguments.delta',
      output_index: tc.output_index, item_id: tc.callId,
      delta: deltaText,
    });
  }

  function closeToolCallItem(tc) {
    if (!tc.opened) openToolCallItem(tc);
    emit({
      type: 'response.function_call_arguments.done',
      output_index: tc.output_index, item_id: tc.callId,
      arguments: tc.args,
    });
    const item = { id: tc.callId, type: 'function_call', call_id: tc.callId, name: tc.name, arguments: tc.args, status: 'completed' };
    emit({ type: 'response.output_item.done', output_index: tc.output_index, item });
    outputItems.push(item);
  }

  // -------- phase 切换 --------

  function closeCurrent() {
    if (!currentItem) return;
    if (currentItem.type === 'reasoning') closeReasoningItem();
    else if (currentItem.type === 'message') closeMessageItem();
  }

  function transitionTo(nextPhase) {
    if (phase === nextPhase) return;
    closeCurrent();
    if (nextPhase === 'reasoning') startReasoningItem();
    else if (nextPhase === 'message') startMessageItem();
    phase = nextPhase;
  }

  // -------- 终止 --------

  function emitCompleted() {
    if (streamTerminated) return;
    streamTerminated = true;
    closeCurrent();
    // 关闭所有未关闭的 tool_calls（按 index 升序）
    const sortedTcs = [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b);
    for (const [, tc] of sortedTcs) closeToolCallItem(tc);

    const usage = responseUsage ? {
      input_tokens: responseUsage.prompt_tokens || 0,
      output_tokens: responseUsage.completion_tokens || 0,
      total_tokens: responseUsage.total_tokens || 0,
    } : null;
    const messageOutputs = outputItems.filter(it => it.type === 'message');
    const response = {
      id: responseId, object: 'response', created_at: createdAt, status: 'completed',
      model: chatPayload.model, output: outputItems,
      output_text: messageOutputs.flatMap(it => it.content.filter(c => c.type === 'output_text').map(c => c.text)).join(''),
      usage,
    };
    if (streamMode === 'json') {
      const body = JSON.stringify(response);
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      emit({ type: 'response.completed', response });
      res.end();
    }

    // 关键诊断日志：thinking=Y/N 直接看 DeepSeek 实际有没有返回 reasoning
    const tcCount = outputItems.filter(it => it.type === 'function_call').length;
    const elapsed = Date.now() - reqStartTs;
    log(
      `RESPONSES_DONE id=${responseId} effort=${chatPayload.reasoning_effort} `
      + `thinking=${reasoningChars > 0 ? `Y(${reasoningChars}chars)` : 'N'} `
      + `text=${textChars}chars tools=${tcCount} `
      + `usage=${usage ? `${usage.input_tokens}/${usage.output_tokens}` : 'none'} `
      + `${elapsed}ms`
    );
  }

  function emitFailed(error) {
    if (streamTerminated) return;
    streamTerminated = true;
    log(`RESPONSES_FAILED ${error.code || 'unknown'}: ${(error.message || '').slice(0, 200)}`);
    if (streamMode === 'json') {
      const body = JSON.stringify({ id: responseId, object: 'response', status: 'failed', error });
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      emit({ type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error } });
      res.end();
    }
  }

  // -------- 上游请求 --------

  const bodyOut = JSON.stringify(chatPayload);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyOut),
    Authorization: `Bearer ${CONFIG.apiKey}`,
  };

  const target = chatTarget();
  const client = target.protocol === 'http:' ? http : https;
  // 透明重试：connect/TLS handshake 阶段失败时静默 retry 1 次。
  // 安全前提：还没向 codex 客户端发任何 SSE 事件（res.headersSent=false 且
  // 还没进 upstreamRes 回调）。一旦数据流开始就不能 retry，否则客户端会重复看到部分输出。
  const MAX_RETRIES = 1;
  const RETRY_DELAY_MS = 500;
  let retriesLeft = MAX_RETRIES;
  let upstreamConnected = false;

  function attemptRequest() {
  const upstream = client.request({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: 'POST',
    headers: reqHeaders,
    rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
  }, upstreamRes => {
    upstreamConnected = true;  // 进入此回调代表 connect+TLS 都成功，禁止重试
    if (streamMode === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    }
    emitCreated();

    if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
      let errBody = '';
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', c => { errBody += c; });
      upstreamRes.on('end', () => emitFailed({ code: 'upstream_error', message: errBody.slice(0, 500) || `Upstream HTTP ${upstreamRes.statusCode}` }));
      return;
    }

    let lineBuf = '';
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', chunk => {
      if (streamTerminated) return;
      // 行缓冲：HTTP chunk 可能在 JSON 中间断开，不合并就会丢 delta
      lineBuf += chunk;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop();
      for (const line of lines) {
        if (streamTerminated) return;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        // include_usage 的最后一个 chunk 是 {choices:[], usage:{...}}
        if (parsed.usage) responseUsage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        sawAnyDelta = true;

        // reasoning（独立 item，与 message 分离）
        if (delta.reasoning_content) {
          transitionTo('reasoning');
          appendReasoning(delta.reasoning_content);
        }

        // tool_calls（按 index 累积；首 chunk 带 name+id，后续 chunk 带 args 增量）
        if (Array.isArray(delta.tool_calls)) {
          // 切换 phase 前关掉 reasoning/message item（tool_call 不通过 currentItem 管理）
          if (phase !== 'tool_call') { closeCurrent(); phase = 'tool_call'; }
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const fnName = tc.function?.name;
            const tcRecord = ensureToolCall(idx, tc.id, fnName);
            if (fnName && !tcRecord.opened) openToolCallItem(tcRecord);
            const argsDelta = tc.function?.arguments;
            if (argsDelta) appendToolCallArgs(tcRecord, argsDelta);
          }
        }

        // 文本内容（注意：与 reasoning/tool_call 互斥切换）
        if (delta.content && phase !== 'tool_call') {
          transitionTo('message');
          appendMessage(delta.content);
        }

        // 完成
        if (choice.finish_reason) {
          if (choice.finish_reason === 'tool_calls' && toolCallsByIndex.size === 0) {
            // PRD §3.2.6.c flagged 风险：DeepSeek 偶发 fall-through，
            // finish_reason=tool_calls 但流式没发 delta.tool_calls。
            // 当前实现仅记录日志；后续若用户实测命中再补 fallback retry。
            log(`WARN: finish_reason=tool_calls but no tool_calls accumulated`);
          }
        }
      }
    });

    upstreamRes.on('end', () => {
      if (!streamTerminated) {
        if (!sawAnyDelta) {
          emitFailed({ code: 'empty_stream', message: 'upstream closed without any delta' });
        } else {
          emitCompleted();
        }
      }
    });

    upstreamRes.on('error', err => {
      if (!streamTerminated) emitFailed({ code: 'stream_error', message: err.message });
    });
  });

  upstream.setTimeout(300000, () => {
    upstream.destroy();
    if (!streamTerminated) emitFailed({ code: 'timeout', message: 'upstream timeout after 300s' });
  });

  upstream.on('error', err => {
    const canRetry = !upstreamConnected && !res.headersSent && retriesLeft > 0;
    log(`ERROR [responses]: ${err.message}${canRetry ? ` (retry in ${RETRY_DELAY_MS}ms, ${retriesLeft} left)` : ''}`);
    if (canRetry) {
      retriesLeft--;
      setTimeout(attemptRequest, RETRY_DELAY_MS);
      return;
    }
    if (!streamTerminated) emitFailed({ code: 'connection_error', message: err.message });
  });

  upstream.write(bodyOut);
  upstream.end();
  }

  attemptRequest();
}

/**
 * 构造 provider-specific Chat Completions 扩展参数
 * @param {object[]} messages - 已翻译的 Chat messages
 * @param {object[]|undefined} tools - 已翻译的 Chat tools
 * @param {string} thinking - enabled | disabled | unsupported
 * @returns {object} 需要合并到 Chat Completions 请求体的扩展字段
 */
function chatProviderOptions(messages, tools, thinking) {
  const caps = activeCapabilities();
  const options = {};
  if (caps.chatStreamOptions !== false) options.stream_options = { include_usage: true };
  if (thinking !== 'unsupported') {
    options.thinking = { type: thinking };
    if (thinking === 'enabled' && caps.preservedThinking === 'clear_thinking' && messages.some(m => m.reasoning_content)) {
      options.thinking.clear_thinking = false;
    }
  }
  if (thinking === 'enabled' && providerSupportsThinkingEffort()) {
    options.reasoning_effort = normalizeEffort(CONFIG.effort || 'max');
  }
  if (tools && caps.toolStreamParam) options[caps.toolStreamParam] = true;
  return options;
}

/**
 * 处理 Codex Responses API 请求
 */
function handleResponses(req, res, payload) {
  const thinking = providerSupportsThinking() ? normalizeThinking(CONFIG.thinking || 'enabled') : 'unsupported';
  const messages = responsesInputToMessages(payload);
  const tools = responsesToolsToChatTools(payload.tools);
  const body = {
    model: CONFIG.model || payload.model || 'deepseek-v4-pro',
    messages,
    stream: true,
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
    log(`RESPONSES_TOOLS count=${tools.length} names=[${tools.map(t => t.function.name).join(',')}]`);
  }
  Object.assign(body, chatProviderOptions(messages, tools, thinking));

  const streamMode = payload.stream !== false ? 'stream' : 'json';
  const inputTypes = (payload.input || []).map(it => it.type + (it.role ? ':' + it.role : '')).join(',');
  log(`RESPONSES stream=${streamMode} msgs=${body.messages.length} tools=${!!tools} thinking=${thinking} effort=${body.reasoning_effort || '-'} input=[${inputTypes}]`);
  streamChatToResponses(res, body, streamMode);
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
    const modelId = CONFIG.model || 'deepseek-v4-pro';
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

    // Anthropic Messages 路径透传（Claude Code 走这里）
    const incomingModel = payload.model || '?';
    const thinking = providerSupportsThinking() ? normalizeThinking(CONFIG.thinking || 'enabled') : 'unsupported';
    const anthropicThinking = thinking !== 'unsupported' && providerSupportsAnthropicThinking();
    payload.model = CONFIG.model || payload.model || 'deepseek-v4-pro';
    if (anthropicThinking) {
      payload.thinking = { ...(payload.thinking || {}), type: thinking };
    } else {
      delete payload.thinking;
    }
    if (thinking === 'enabled' && anthropicThinking && providerSupportsThinkingEffort()) {
      payload.output_config = { ...(payload.output_config || {}), effort: normalizeEffort(CONFIG.effort || 'max') };
    } else {
      delete payload.output_config;
    }

    const bodyOut = JSON.stringify(payload);
    log(`POST ${req.url} | model=${incomingModel}->${payload.model} | thinking=${thinking} | effort=${payload.output_config?.effort || 'off'}`);

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyOut);
    headers['x-api-key'] = CONFIG.apiKey;
    headers.authorization = `Bearer ${CONFIG.apiKey}`;
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';

    const target = anthropicTarget(req.url);
    const client = target.protocol === 'http:' ? http : https;
    const reqStartTs = Date.now();
    // 与 Codex 路径同样的透明重试：connect/TLS 阶段失败时静默 retry 1 次
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

      // 嗅探 SSE 流统计 thinking/text 字符数（仅诊断，不影响透传）
      const isStream = (upstreamRes.headers['content-type'] || '').includes('event-stream');
      let thinkingChars = 0;
      let textChars = 0;
      let inputTokens = 0;
      let outputTokens = 0;
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
              // Anthropic SSE: content_block_delta with thinking_delta or text_delta
              if (evt.type === 'content_block_delta') {
                if (evt.delta?.type === 'thinking_delta') thinkingChars += (evt.delta.thinking || '').length;
                if (evt.delta?.type === 'text_delta') textChars += (evt.delta.text || '').length;
              }
              if (evt.type === 'message_delta' && evt.usage) {
                outputTokens = evt.usage.output_tokens || outputTokens;
              }
              if (evt.type === 'message_start' && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens || 0;
                outputTokens = evt.message.usage.output_tokens || 0;
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
              if (block.type === 'thinking') thinkingChars += (block.thinking || '').length;
              if (block.type === 'text') textChars += (block.text || '').length;
            }
            inputTokens = j.usage?.input_tokens || 0;
            outputTokens = j.usage?.output_tokens || 0;
          } catch {}
        }
        const elapsed = Date.now() - reqStartTs;
        log(
          `MSG_DONE model=${payload.model} `
          + `thinking=${thinkingChars > 0 ? `Y(${thinkingChars}chars)` : 'N'} `
          + `text=${textChars}chars stream=${isStream} `
          + `usage=${inputTokens}/${outputTokens} ${elapsed}ms`
        );
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
  const thinking = providerSupportsThinking() ? normalizeThinking(CONFIG.thinking || 'enabled') : 'unsupported';
  const effort = thinking === 'enabled' && providerSupportsThinkingEffort() ? normalizeEffort(CONFIG.effort || 'max') : 'off';
  log(`代理启动 localhost:${PORT} provider=${CONFIG.activeProvider || 'deepseek'} model=${CONFIG.model || 'deepseek-v4-pro'} thinking=${thinking} effort=${effort}`);
});
