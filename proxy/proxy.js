const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TARGET_HOST = process.env.DEEPSEEK_CLAUDE_TARGET_HOST || 'api.deepseek.com';
const TARGET_PATH_PREFIX = process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX || '/anthropic';
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
  return JSON.stringify({
    service: SERVICE_NAME,
    ok: true,
    model: CONFIG.model || 'deepseek-v4-pro',
    thinking: normalizeThinking(CONFIG.thinking || 'enabled'),
    effort: normalizeEffort(CONFIG.effort || 'max'),
  });
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

    const incomingModel = payload.model || '?';
    payload.model = CONFIG.model || payload.model || 'deepseek-v4-pro';
    payload.thinking = { ...(payload.thinking || {}), type: normalizeThinking(CONFIG.thinking || 'enabled') };
    payload.output_config = { ...(payload.output_config || {}), effort: normalizeEffort(CONFIG.effort || 'max') };

    const bodyOut = JSON.stringify(payload);
    log(`POST ${req.url} | model=${incomingModel}->${payload.model} | thinking=${payload.thinking.type} | effort=${payload.output_config.effort}`);

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
  log(`代理启动 localhost:${PORT} model=${CONFIG.model || 'deepseek-v4-pro'} thinking=${normalizeThinking(CONFIG.thinking || 'enabled')} effort=${normalizeEffort(CONFIG.effort || 'max')}`);
});
