/**
 * DeepSeek 代理服务
 *
 * 负责：
 * - Anthropic Messages 路径透传到 DeepSeek，并覆盖 model/thinking/output_config.effort
 * - Codex Responses API 翻译到 DeepSeek Chat Completions（含真流式状态机）
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

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TARGET_HOST = process.env.DEEPSEEK_CLAUDE_TARGET_HOST || 'api.deepseek.com';
const TARGET_PATH_PREFIX = process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX || '/anthropic';
const OPENAI_TARGET_PATH_PREFIX = process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX || '';
const TARGET_PORT = process.env.DEEPSEEK_CLAUDE_TARGET_PORT ? Number(process.env.DEEPSEEK_CLAUDE_TARGET_PORT) : 443;
const TARGET_PROTOCOL = process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL || 'https:';
const PORT = process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861;
const SERVICE_NAME = 'deepseek-claude-proxy';

// 日志路径用 os.tmpdir() 跨平台（macOS: /var/folders/.../T/，Win: %TEMP%，Linux: /tmp/）
const LOG_PATH = path.join(os.tmpdir(), 'deepseek-claude-proxy.log');

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

function healthBody() {
  const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
  return JSON.stringify({
    service: SERVICE_NAME,
    ok: true,
    model: CONFIG.model || 'deepseek-v4-pro',
    thinking,
    effort: thinking === 'enabled' ? normalizeEffort(CONFIG.effort || 'max') : null,
  });
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part.text || part.content || '').filter(Boolean).join('\n');
}

/**
 * 把 Codex Responses API 的 input 数组翻译成 OpenAI Chat Completions 的 messages
 *
 * 处理四类 input item：
 * - message：常规对话（user/assistant/developer）
 * - reasoning：Codex 在前轮响应里产生的思考记录，需要在工具调用轮次回传给 DeepSeek
 * - function_call：assistant 调用工具的历史记录
 * - function_call_output：工具结果回填
 *
 * DeepSeek 文档要求：
 * - 进行了工具调用的轮次，必须完整回传 reasoning_content，否则 400 报错
 * - 未进行工具调用的 assistant 轮次的 reasoning_content 会被忽略
 *
 * 翻译策略：累积 pendingReasoning，遇到 function_call 时附加到 assistant 消息；
 * 遇到普通 message 时清空（不带去下一轮）
 *
 * @param {object} payload - Responses API 请求体
 * @returns {Array<object>} Chat Completions messages
 */
function responsesInputToMessages(payload) {
  const messages = [];
  if (payload.instructions) {
    messages.push({ role: 'system', content: payload.instructions });
  }

  let pendingReasoning = '';      // 当前轮次内累积、待消化的新 reasoning
  let lastReasoning = '';         // 最近消化过的 reasoning，作为后续 assistant 行为的 fallback
  let pendingToolCalls = [];      // 连续 function_call 累积，合并成一条 assistant 消息

  // DeepSeek 规则：含工具调用的轮次（两 user 之间）所有 assistant 的 reasoning_content 必须回传。
  // codex 的 input 里 reasoning 与 assistant 行为不一定 1:1（一段 reasoning 后可能跟
  // assistant message + function_call 多个 assistant 行为），所以 reasoning 被消化后
  // 也要保留作为 fallback，让后续没有自己 reasoning 的 assistant 行为复用。
  // user 消息出现时清空两个状态（开启新轮次）。
  function consumeReasoning() {
    if (pendingReasoning) {
      lastReasoning = pendingReasoning;
      const v = pendingReasoning;
      pendingReasoning = '';
      return v;
    }
    return lastReasoning;
  }

  function flushToolCalls() {
    if (pendingToolCalls.length === 0) return;
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls,
    };
    const reasoning = consumeReasoning();
    if (reasoning) msg.reasoning_content = reasoning;
    messages.push(msg);
    pendingToolCalls = [];
  }

  for (const item of payload.input || []) {
    if (item.type === 'reasoning') {
      // Codex 的 reasoning item 可能用 content[{type:'reasoning_text'}] 或 summary[{type:'summary_text'}]
      const fromContent = (item.content || [])
        .filter(c => c.type === 'reasoning_text' || c.type === 'reasoning')
        .map(c => c.text || '')
        .join('');
      const fromSummary = (item.summary || [])
        .filter(c => c.type === 'summary_text')
        .map(c => c.text || '')
        .join('');
      pendingReasoning += fromContent || fromSummary;
      continue;
    }

    if (item.type === 'function_call') {
      const callId = item.call_id || item.id;
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
      continue;
    }

    // 遇到非 function_call 项：先把累积的 tool_calls flush 成 assistant 消息
    flushToolCalls();

    if (item.type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      const text = contentToText(item.content);
      if (role === 'user') {
        // 新轮次开始：清空所有 reasoning 状态
        pendingReasoning = '';
        lastReasoning = '';
        if (text) messages.push({ role: 'user', content: text });
        continue;
      }
      if (text) {
        const msg = { role, content: text };
        if (role === 'assistant') {
          const reasoning = consumeReasoning();
          if (reasoning) msg.reasoning_content = reasoning;
        }
        messages.push(msg);
      } else if (role === 'assistant') {
        const reasoning = consumeReasoning();
        if (reasoning) {
          messages.push({ role: 'assistant', content: null, reasoning_content: reasoning });
        }
      }
      continue;
    }

    if (item.type === 'function_call_output') {
      const tcId = item.call_id || item.tool_call_id || '';
      let content = '';
      if (item.output !== undefined) {
        content = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      } else if (item.content !== undefined) {
        content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
      }
      messages.push({ role: 'tool', tool_call_id: tcId, content });
      continue;
    }
  }

  flushToolCalls();

  if (!messages.some(m => m.role === 'user' || m.role === 'tool')) {
    messages.push({ role: 'user', content: 'Continue.' });
  }
  return messages;
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const functions = tools
    .filter(tool => tool.type === 'function' && tool.name)
    .map(tool => {
      const params = {};
      for (const [k, v] of Object.entries(tool.parameters || { type: 'object', properties: {} })) {
        if (k === 'additionalProperties' || k === 'strict') continue; // DeepSeek 不接受
        params[k] = v;
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: params,
        },
      };
    });
  return functions.length ? functions : undefined;
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

  const client = TARGET_PROTOCOL === 'http:' ? http : https;
  // 透明重试：connect/TLS handshake 阶段失败时静默 retry 1 次。
  // 安全前提：还没向 codex 客户端发任何 SSE 事件（res.headersSent=false 且
  // 还没进 upstreamRes 回调）。一旦数据流开始就不能 retry，否则客户端会重复看到部分输出。
  const MAX_RETRIES = 1;
  const RETRY_DELAY_MS = 500;
  let retriesLeft = MAX_RETRIES;
  let upstreamConnected = false;

  function attemptRequest() {
  const upstream = client.request({
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: `${OPENAI_TARGET_PATH_PREFIX}/chat/completions`,
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
 * 处理 Codex Responses API 请求
 *
 * 按 DeepSeek 官方文档：
 * - 思考模式开关：`thinking: {type: enabled/disabled}`，OpenAI 和 Anthropic 路径都支持
 * - 思考强度（仅 enabled 时有效）：Chat Completions 路径用 `reasoning_effort`（high/max）；
 *   Anthropic 路径用 `output_config.effort`
 * - thinking=disabled 时 DeepSeek 真的不会输出 reasoning_content，代理无需在客户端侧拦截
 */
function handleResponses(req, res, payload) {
  const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
  const body = {
    model: CONFIG.model || payload.model || 'deepseek-v4-pro',
    messages: responsesInputToMessages(payload),
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinking },
  };
  if (thinking === 'enabled') {
    body.reasoning_effort = normalizeEffort(CONFIG.effort || 'max');
  }

  const tools = responsesToolsToChatTools(payload.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
    log(`RESPONSES_TOOLS count=${tools.length} names=[${tools.map(t => t.function.name).join(',')}]`);
  }

  const streamMode = payload.stream !== false ? 'stream' : 'json';
  const inputTypes = (payload.input || []).map(it => it.type + (it.role ? ':' + it.role : '')).join(',');
  log(`RESPONSES stream=${streamMode} msgs=${body.messages.length} tools=${!!tools} thinking=${thinking} effort=${body.reasoning_effort || '-'} input=[${inputTypes}]`);
  streamChatToResponses(res, body, streamMode);
}

let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  if (!CONFIG.apiKey) throw new Error('缺少 apiKey');
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
      id: modelId, object: 'model', created: 1700000000, owned_by: 'deepseek',
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
    const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
    payload.model = CONFIG.model || payload.model || 'deepseek-v4-pro';
    payload.thinking = { ...(payload.thinking || {}), type: thinking };
    if (thinking === 'enabled') {
      payload.output_config = { ...(payload.output_config || {}), effort: normalizeEffort(CONFIG.effort || 'max') };
    } else {
      delete payload.output_config;
    }

    const bodyOut = JSON.stringify(payload);
    log(`POST ${req.url} | model=${incomingModel}->${payload.model} | thinking=${payload.thinking.type} | effort=${payload.output_config?.effort || 'off'}`);

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

    const client = TARGET_PROTOCOL === 'http:' ? http : https;
    const reqStartTs = Date.now();
    // 与 Codex 路径同样的透明重试：connect/TLS 阶段失败时静默 retry 1 次
    let anthropicRetriesLeft = 1;
    let anthropicConnected = false;
    function anthropicAttempt() {
    const upstream = client.request({
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: TARGET_PATH_PREFIX + req.url,
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
  const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
  log(`代理启动 localhost:${PORT} model=${CONFIG.model || 'deepseek-v4-pro'} thinking=${thinking} effort=${thinking === 'enabled' ? normalizeEffort(CONFIG.effort || 'max') : 'off'}`);
});
