#!/usr/bin/env node
/**
 * 上游抓包服务器
 *
 * 负责：
 * - 模拟 DeepSeek Anthropic / Chat Completions 上游
 * - 记录代理实际发送的 model、thinking、effort、tool_calls 等字段
 * - 为 capture 类认证用例提供 requests.jsonl 证据
 *
 * @module scripts/upstream-capture-server
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function writeJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function redactHeaders(headers) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (/authorization|api-key|token/i.test(key)) next[key] = '[REDACTED]';
  }
  return next;
}

function chatResponse(body) {
  return JSON.stringify({
    id: 'chatcmpl_capture',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'CAPTURE_OK' }, finish_reason: 'stop' }],
  });
}

function anthropicResponse() {
  return JSON.stringify({
    id: 'msg_capture',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'CAPTURE_OK' }],
  });
}

/**
 * 启动抓包服务器。
 * @param {{port?: number, outputFile?: string, failMaxToolsOnce?: boolean}} [options] - 启动选项。
 * @returns {Promise<{server: object, port: number, outputFile: string, calls: object[]}>} server 信息。
 */
function startCaptureServer(options = {}) {
  const calls = [];
  const outputFile = options.outputFile || path.join(os.tmpdir(), `deepseek-capture-${Date.now()}.jsonl`);
  let failedOnce = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const entry = {
        method: req.method,
        url: req.url,
        headers: redactHeaders(req.headers),
        body,
        capturedAt: new Date().toISOString(),
      };
      calls.push(entry);
      writeJsonl(outputFile, entry);

      if (options.failMaxToolsOnce && !failedOnce && body?.reasoning_effort === 'max' && Array.isArray(body.tools)) {
        failedOnce = true;
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'capture forced max tool failure' } }));
        return;
      }

      const response = req.url.includes('/chat/completions') ? chatResponse(body || {}) : anthropicResponse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(response) });
      res.end(response);
    });
  });

  return new Promise(resolve => {
    server.listen(options.port || 0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, outputFile, calls });
    });
  });
}

if (require.main === module) {
  const outputFile = process.argv.find(arg => arg.startsWith('--output='))?.split('=')[1];
  startCaptureServer({ outputFile }).then(({ port }) => {
    console.log(JSON.stringify({ port, outputFile }));
  });
}

module.exports = {
  startCaptureServer,
};
