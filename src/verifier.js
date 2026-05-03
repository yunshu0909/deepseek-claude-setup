const http = require('http');
const https = require('https');

function checkApiKey(apiKey) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'deepseek-v4-pro',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
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

function verify(config = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: config.model || 'deepseek-v4-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'enabled', budget_tokens: 32768 },
      output_config: { effort: config.effort || 'max' },
    });

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
          const r = JSON.parse(Buffer.concat(chunks).toString());
          const hasThinking = r.content && r.content.some(b => b.type === 'thinking');
          resolve({ ok: true, hasThinking });
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
