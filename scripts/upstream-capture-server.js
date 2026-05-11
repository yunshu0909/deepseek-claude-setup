#!/usr/bin/env node
/**
 * 上游 capture server —— PRD-007 US-40
 *
 * 负责：
 * - 假装是 provider 上游，接收 gateway 转发的 Anthropic Messages + OpenAI Chat Completions 两路请求
 * - 每个 request 落到 JSONL（headers + body + 当前 step + 路径），写入前 redact `authorization` / `x-api-key`
 * - 永远返回最小完整 SSE 流（Anthropic 一套、Chat 一套），不模拟 5xx；错误注入归属 PRD-008
 * - 支持 runner 通过 `POST /__step` 切换当前 step 标识，跨 provider 切换时 capture server 实例**复用不重启**
 *
 * 启动方式（由 runner spawn）：
 *   PORT 通过 `CLIENT_E2E_CAPTURE_PORT` env 传入；0 表示让 OS 选随机端口
 *   输出目录通过 `CLIENT_E2E_CAPTURE_DIR` env 传入；默认 `<tmpdir>/upstream-capture`
 *
 * stdout 协议：服务就绪后打印一行 `CAPTURE_SERVER_READY port=<port> dir=<dir>` 给 runner 解析
 *
 * @module scripts/upstream-capture-server
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.CLIENT_E2E_CAPTURE_PORT || '0', 10);
const OUTPUT_DIR = process.env.CLIENT_E2E_CAPTURE_DIR || path.join(os.tmpdir(), `upstream-capture-${Date.now()}`);
const JSONL_PATH = path.join(OUTPUT_DIR, 'requests.jsonl');

// 当前 step 标识，由 runner 在每次切换前通过 POST /__step 设置
let currentStep = 'default';

function ensureOutputDir() {
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}
}

/**
 * 屏蔽 headers 里的敏感字段。runner 期待 capture JSONL 不含真实 key。
 * @param {object} headers
 * @returns {object} 已 redact 的副本
 */
function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
      out[key] = '[REDACTED_KEY]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function tryParseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    // 不是 JSON 就原样存 string，调试 capture 数据时仍可读
    return buf.toString('utf-8');
  }
}

/**
 * 写一条 capture entry 到 JSONL；append-only。
 */
function writeEntry(reqPath, headers, bodyBuf) {
  const entry = {
    step: currentStep,
    ts: new Date().toISOString(),
    path: reqPath,
    method: 'POST',
    headers: redactHeaders(headers),
    body: tryParseJson(bodyBuf),
  };
  ensureOutputDir();
  fs.appendFileSync(JSONL_PATH, JSON.stringify(entry) + '\n');
}

/**
 * Anthropic Messages 最小完整 SSE 流：
 * message_start → content_block_start → content_block_delta(text) → content_block_stop → message_delta → message_stop
 * gateway 不会因为响应不完整而挂。
 */
function anthropicSse(model) {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_capture_mock', type: 'message', role: 'assistant',
        model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * OpenAI Chat Completions 最小完整 SSE 流：
 * 一条 delta 含文本 + 一条 finish_reason=stop + [DONE]
 */
function chatSse(model) {
  const chunks = [
    {
      id: 'chatcmpl-capture-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-capture-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sendSse(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(body);
  res.end();
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;

  // 管理端点：runner 用来切换当前 step 名
  if (p === '/__step' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const json = JSON.parse(body.toString('utf-8') || '{}');
      currentStep = json.name || 'default';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, step: currentStep }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad step body' }));
    }
    return;
  }

  // 管理端点：health
  if (p === '/__health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, service: 'upstream-capture-server',
      step: currentStep, port: server.address().port, dir: OUTPUT_DIR,
    }));
    return;
  }

  // 管理端点：停止
  if (p === '/__stop' && req.method === 'POST') {
    res.writeHead(200);
    res.end('ok');
    setTimeout(() => process.exit(0), 50);
    return;
  }

  // Anthropic Messages 路径：兼容 `/v1/messages` 和 `/anthropic/v1/messages` 各种前缀
  if (req.method === 'POST' && p.endsWith('/v1/messages')) {
    const body = await readBody(req);
    writeEntry(p, req.headers, body);
    const parsed = tryParseJson(body);
    const model = (parsed && parsed.model) || 'mock';
    sendSse(res, anthropicSse(model));
    return;
  }

  // OpenAI Chat Completions 路径：兼容 `/v1/chat/completions` 和 `/chat/completions`
  if (req.method === 'POST' && p.endsWith('/chat/completions')) {
    const body = await readBody(req);
    writeEntry(p, req.headers, body);
    const parsed = tryParseJson(body);
    const model = (parsed && parsed.model) || 'mock';
    sendSse(res, chatSse(model));
    return;
  }

  // 其他都 404，runner 应该断言不出现 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: `unknown path ${p}` }));
});

server.on('error', err => {
  // 端口冲突等启动错误：用 stderr 输出原因，runner 监控 stderr 并重试新端口
  console.error(`CAPTURE_SERVER_ERROR ${err.code || ''} ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  ensureOutputDir();
  // stdout 协议行：runner 解析这一行来拿到实际端口
  console.log(`CAPTURE_SERVER_READY port=${addr.port} dir=${OUTPUT_DIR} jsonl=${JSONL_PATH}`);
});

// 优雅退出：runner 强 kill 时也清理监听
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  try { server.close(); } catch {}
  process.exit(0);
}));
