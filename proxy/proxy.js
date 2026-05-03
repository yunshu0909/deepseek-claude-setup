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

function responseMessageEvents(text, model) {
  const now = Math.floor(Date.now() / 1000);
  const responseId = `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;
  const item = {
    id: messageId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: responseId,
    object: 'response',
    created_at: now,
    status: 'completed',
    model,
    output: [item],
    output_text: text,
    usage: null,
  };

  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: messageId, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: messageId, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: messageId, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: messageId, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
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
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
  return functions.length ? functions : undefined;
}

function writeResponsesFromText(res, payload, text) {
  if (payload.stream === false) {
    const events = responseMessageEvents(text, payload.model);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events.at(-1).response));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of responseMessageEvents(text, payload.model)) sendSse(res, event);
  res.end();
}

function handleResponses(req, res, payload) {
  const thinking = normalizeThinking(CONFIG.thinking || 'enabled');
  const body = {
    model: CONFIG.model || payload.model || 'deepseek-v4-pro',
    messages: responsesInputToMessages(payload),
    stream: true,
    thinking: { type: thinking },
  };
  const tools = responsesToolsToChatTools(payload.tools);
  if (tools) body.tools = tools;
  if (thinking === 'enabled') {
    body.output_config = { effort: normalizeEffort(CONFIG.effort || 'max') };
  }

  const bodyOut = JSON.stringify(body);
  const headers = {
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
    headers,
    rejectUnauthorized: process.env.DEEPSEEK_CLAUDE_STRICT_TLS === '1',
  }, upstreamRes => {
    let collected = '';
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', chunk => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) collected += delta.reasoning_content;
          if (delta?.content) collected += delta.content;
        } catch {}
      }
    });
    upstreamRes.on('end', () => {
      if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
        res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: collected || `Upstream HTTP ${upstreamRes.statusCode}` } }));
        return;
      }
      writeResponsesFromText(res, { ...payload, model: body.model }, collected || '');
    });
  });

  upstream.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  });
  upstream.write(bodyOut);
  upstream.end();
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
