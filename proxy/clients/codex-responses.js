/**
 * Codex Responses 客户端发射器 + transport
 *
 * 负责：
 * - 把 provider adapter 归一出的 GatewayEvent 流翻译成 OpenAI Responses API SSE
 * - 持有上游 Chat Completions 的 transport（连接/透明重试/超时）
 *
 * 设计要点（与 v0.5 proxy.js streamChatToResponses 行为字节等价，仅位置下沉）：
 * - reasoning / message / function_call 各自是独立 output_item，严格走完整 6 步
 * - function_call item 的 id 与 call_id 同值，前缀 "call_"
 * - tool_calls 按 index 累积
 * - 只消费 GatewayEvent，不直接解析 provider SSE（解析由 provider.parseChatStreamChunk 负责）
 * - transport 留在本 client（非 provider），provider 文件不做网络 IO
 *
 * @module proxy/clients/codex-responses
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function generateCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`;
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * 启动一次 Codex Responses 流式响应
 *
 * @param {object} res - Codex 侧 HTTP response
 * @param {object} requestSpec - provider.buildChatRequestSpec 输出 { target, body, apiKey }
 * @param {string} streamMode - 'stream' | 'json'
 * @param {object} deps - { parseChunk, log }
 *   - parseChunk(parsedJson) → GatewayEvent[]   provider.parseChatStreamChunk
 *   - log(msg)                                  诊断日志
 */
function streamChatToResponses(res, requestSpec, streamMode, deps) {
  const { target, body: chatPayload, apiKey } = requestSpec;
  const { parseChunk, log, captureThinking } = deps;

  const responseId = `resp_${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  let seq = 0;
  let streamTerminated = false;
  let phase = 'idle'; // idle | reasoning | message | tool_call
  let currentItem = null;
  const toolCallsByIndex = new Map();
  const outputItems = [];
  let responseUsage = null;
  let sawAnyDelta = false;
  let reasoningChars = 0;
  let reasoningText = '';
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
    if (captureThinking) reasoningText += deltaText;
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
      const respBody = JSON.stringify(response);
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
      res.end(respBody);
    } else {
      emit({ type: 'response.completed', response });
      res.end();
    }

    const tcCount = outputItems.filter(it => it.type === 'function_call').length;
    const elapsed = Date.now() - reqStartTs;
    log(
      `RESPONSES_DONE id=${responseId} effort=${chatPayload.reasoning_effort} `
      + `thinking=${reasoningChars > 0 ? `Y(${reasoningChars}chars)` : 'N'} `
      + `text=${textChars}chars tools=${tcCount} `
      + `usage=${usage ? `${usage.input_tokens}/${usage.output_tokens}` : 'none'} `
      + `${elapsed}ms`
    );
    if (captureThinking && reasoningText) captureThinking(responseId, reasoningText);
  }

  function emitFailed(error) {
    if (streamTerminated) return;
    streamTerminated = true;
    log(`RESPONSES_FAILED ${error.code || 'unknown'}: ${(error.message || '').slice(0, 200)}`);
    if (streamMode === 'json') {
      const respBody = JSON.stringify({ id: responseId, object: 'response', status: 'failed', error });
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(respBody) });
      res.end(respBody);
    } else {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      emit({ type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error } });
      res.end();
    }
  }

  // -------- 消费 GatewayEvent --------
  function consume(events) {
    for (const ev of events) {
      if (ev.kind === 'usage') { responseUsage = ev.usage; continue; }
      if (ev.kind === 'reasoning') {
        transitionTo('reasoning');
        appendReasoning(ev.text);
      } else if (ev.kind === 'tool_call') {
        if (phase !== 'tool_call') { closeCurrent(); phase = 'tool_call'; }
        const tcRecord = ensureToolCall(ev.index, ev.id, ev.name);
        if (ev.name && !tcRecord.opened) openToolCallItem(tcRecord);
        if (ev.argsDelta) appendToolCallArgs(tcRecord, ev.argsDelta);
      } else if (ev.kind === 'text') {
        if (phase !== 'tool_call') {
          transitionTo('message');
          appendMessage(ev.text);
        }
      } else if (ev.kind === 'finish') {
        if (ev.reason === 'tool_calls' && toolCallsByIndex.size === 0) {
          log(`WARN: finish_reason=tool_calls but no tool_calls accumulated`);
        }
      }
    }
  }

  // -------- 上游请求（transport，留在 client 核心，provider 不碰网络） --------
  const bodyOut = JSON.stringify(chatPayload);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyOut),
    Authorization: `Bearer ${apiKey}`,
  };
  const client = target.protocol === 'http:' ? http : https;
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
      upstreamConnected = true;
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
          // choices 信封是 gateway 与 provider 间的中立线格式；
          // 是否有 choice 决定 sawAnyDelta（保持 v0.5 empty_stream 判定不变）
          if (parsed.choices?.[0]) sawAnyDelta = true;
          consume(parseChunk(parsed));
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

module.exports = { streamChatToResponses };
