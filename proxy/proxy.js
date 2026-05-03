const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TARGET_HOST = process.env.DEEPSEEK_CLAUDE_TARGET_HOST || 'api.deepseek.com';
const TARGET_PATH_PREFIX = process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX || '/anthropic';
const OPENAI_TARGET_PATH_PREFIX = process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX || '';
const TARGET_PORT = process.env.DEEPSEEK_CLAUDE_TARGET_PORT ? Number(process.env.DEEPSEEK_CLAUDE_TARGET_PORT) : 443;
const TARGET_PROTOCOL = process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL || 'https:';
const PORT = process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861;
const SERVICE_NAME = 'deepseek-claude-proxy';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync('/tmp/deepseek-claude-proxy.log', `[${ts}] ${msg}\n`); } catch {}
}

function normalizeEffort(effort) {
  if (effort === 'max' || effort === 'xhigh') return 'max';
  return 'high';
}

function normalizeThinking(thinking) {
  return thinking === 'disabled' ? 'disabled' : 'enabled';
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

function responsesInputToMessages(payload) {
  const messages = [];
  if (payload.instructions) {
    messages.push({ role: 'system', content: payload.instructions });
  }
  for (const item of payload.input || []) {
    if (item.type !== 'message') continue;
    const role = item.role === 'developer' ? 'system' : item.role;
    const text = contentToText(item.content);
    if (text) messages.push({ role, content: text });
  }
  if (!messages.some(message => message.role === 'user')) {
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

function streamChatToResponses(res, chatPayload, originalPayload, streamMode) {
  const responseId = `resp_${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  let streamTerminated = false;
  let phase = 'start'; // start | reasoning | text | tool_call | completed
  let currentItem = null; // { id, type, output_index, content_index, text }
  const outputItems = [];
  let responseUsage = null;

  function emit(event) {
    if (streamMode === 'stream') sendSse(res, event);
    return event;
  }

  function emitCreated() {
    phase = 'in_progress';
    const response = {
      id: responseId, object: 'response', created_at: now, status: 'in_progress',
      model: chatPayload.model, output: [],
    };
    emit({ type: 'response.created', response });
    emit({ type: 'response.in_progress', response: { ...response } });
    return response;
  }

  function startItem(itemType, extra = {}) {
    // 关闭当前 item（如有）
    if (currentItem && !currentItem.closed) closeItem();

    const itemId = `msg_${Date.now()}_${outputIndex}`;
    currentItem = { id: itemId, type: itemType, output_index: outputIndex, content_index: 0, text: '', closed: false };
    const item = { id: itemId, type: itemType, status: 'in_progress', role: 'assistant', content: [], ...extra };
    emit({ type: 'response.output_item.added', output_index: outputIndex, item });
    if (itemType === 'message') {
      const part = { type: 'output_text', text: '', annotations: [] };
      emit({ type: 'response.content_part.added', output_index: outputIndex, item_id: itemId, content_index: 0, part });
    } else if (itemType === 'reasoning') {
      const part = { type: 'reasoning_text', text: '', annotations: [] };
      emit({ type: 'response.content_part.added', output_index: outputIndex, item_id: itemId, content_index: 0, part });
    }
    return currentItem;
  }

  function emitDelta(deltaText) {
    if (!currentItem) startItem('message');
    currentItem.text += deltaText;
    const eventType = currentItem.type === 'reasoning' ? 'response.reasoning_text.delta' : 'response.output_text.delta';
    emit({ type: eventType, output_index: currentItem.output_index, item_id: currentItem.id, content_index: 0, delta: deltaText });
  }

  function closeItem() {
    if (!currentItem || currentItem.closed) return;
    currentItem.closed = true;
    const { id, type, output_index, text } = currentItem;

    if (type === 'message') {
      emit({ type: 'response.output_text.done', output_index, item_id: id, content_index: 0, text });
      const part = { type: 'output_text', text, annotations: [] };
      emit({ type: 'response.content_part.done', output_index, item_id: id, content_index: 0, part });
    } else if (type === 'reasoning') {
      emit({ type: 'response.reasoning_text.done', output_index, item_id: id, content_index: 0, text });
      const part = { type: 'reasoning_text', text, annotations: [] };
      emit({ type: 'response.content_part.done', output_index, item_id: id, content_index: 0, part });
    }

    const item = { id, type, status: 'completed', role: 'assistant', content: [{ type: type === 'reasoning' ? 'reasoning_text' : 'output_text', text, annotations: [] }] };
    emit({ type: 'response.output_item.done', output_index, item });
    outputItems.push(item);
    outputIndex++;
    currentItem = null;
  }

  function emitToolCall(name, args) {
    if (currentItem && !currentItem.closed) closeItem();
    const itemId = `fc_${Date.now()}_${outputIndex}`;
    const item = { id: itemId, type: 'function_call', name, status: 'in_progress', arguments: '' };
    emit({ type: 'response.output_item.added', output_index: outputIndex, item });
    // 逐字符发 arguments delta（模拟流式）
    emit({ type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: itemId, delta: args });
    const doneItem = { id: itemId, type: 'function_call', name, status: 'completed', arguments: args };
    emit({ type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: itemId, name, arguments: args });
    emit({ type: 'response.output_item.done', output_index: outputIndex, item: doneItem });
    outputItems.push(doneItem);
    outputIndex++;
  }

  function emitCompleted() {
    if (streamTerminated) return;
    streamTerminated = true;
    if (currentItem && !currentItem.closed) closeItem();
    const response = {
      id: responseId, object: 'response', created_at: now, status: 'completed',
      model: chatPayload.model, output: outputItems,
      output_text: outputItems.filter(it => it.type === 'message').map(it => it.content[0]?.text || '').join(''),
      usage: responseUsage,
    };
    if (streamMode === 'json') {
      const body = JSON.stringify(response);
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      emit({ type: 'response.completed', response });
      res.end();
    }
  }

  function emitFailed(error) {
    if (streamTerminated) return;
    streamTerminated = true;
    if (streamMode === 'stream' && !res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    }
    if (streamMode === 'json') {
      const body = JSON.stringify({ id: responseId, object: 'response', status: 'failed', error });
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      emit({ type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error } });
      res.end();
    }
  }

  // --- main ---
  const bodyOut = JSON.stringify(chatPayload);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyOut),
    Authorization: `Bearer ${CONFIG.apiKey}`,
  };

  const client = TARGET_PROTOCOL === 'http:' ? http : https;
  const upstream = client.request({
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: `${OPENAI_TARGET_PATH_PREFIX}/chat/completions`,
    method: 'POST',
    headers: reqHeaders,
    rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
  }, upstreamRes => {
    if (streamMode === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    }

    emitCreated();

    if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
      let errBody = '';
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', c => { errBody += c; });
      upstreamRes.on('end', () => emitFailed({ code: 'upstream_error', message: errBody || `Upstream HTTP ${upstreamRes.statusCode}` }));
      return;
    }

    let lineBuf = '';
    let tcName = null;
    let tcArgs = '';
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
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          // reasoning
          if (delta.reasoning_content) {
            if (phase !== 'reasoning') { startItem('reasoning'); phase = 'reasoning'; }
            emitDelta(delta.reasoning_content);
          }

          // tool calls
          if (delta.tool_calls) {
            const tc = delta.tool_calls[0];
            if (tc) {
              if (phase !== 'tool_call') { if (currentItem && !currentItem.closed) closeItem(); phase = 'tool_call'; }
              if (tc.function?.name) { tcName = tc.function.name; tcArgs = ''; }
              if (tc.function?.arguments) tcArgs += tc.function.arguments;
            }
          }

          // text content (not tool call related)
          if (delta.content && phase !== 'tool_call') {
            if (phase === 'reasoning') { closeItem(); }
            if (phase !== 'text') { startItem('message'); phase = 'text'; }
            emitDelta(delta.content);
          }

          // finish
          if (choice.finish_reason) {
            if (choice.finish_reason === 'tool_calls' && tcName) {
              emitToolCall(tcName, tcArgs);
              tcName = null; tcArgs = '';
            }
            if (currentItem && !currentItem.closed) closeItem();
          }

          // usage
          if (parsed.usage) responseUsage = parsed.usage;
        } catch {}
      }
    });

    upstreamRes.on('end', () => {
      if (!streamTerminated) emitCompleted();
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
    log(`ERROR [responses]: ${err.message}`);
    if (!streamTerminated) emitFailed({ code: 'connection_error', message: err.message });
  });

  upstream.write(bodyOut);
  upstream.end();
}

function handleResponses(req, res, payload) {
  const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
  const body = {
    model: CONFIG.model || payload.model || 'deepseek-v4-pro',
    messages: responsesInputToMessages(payload),
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinking },
  };
  const tools = responsesToolsToChatTools(payload.tools);
  if (tools) body.tools = tools;
  if (thinking === 'enabled') {
    body.output_config = { effort: normalizeEffort(CONFIG.effort || 'max') };
  }

  const streamMode = payload.stream !== false ? 'stream' : 'json';
  streamChatToResponses(res, body, payload, streamMode);
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
    const upstream = client.request({
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: TARGET_PATH_PREFIX + req.url,
      method: 'POST',
      headers,
      rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
    }, upstreamRes => {
      if (res.headersSent) return;
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
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
      log(`ERROR: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    upstream.write(bodyOut);
    upstream.end();
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
