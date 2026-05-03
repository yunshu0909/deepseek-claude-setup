const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const PROXY_SCRIPT = path.join(CONFIG_DIR, 'proxy.js');
const PROXY_PORT = process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? Number(process.env.DEEPSEEK_CLAUDE_PROXY_PORT) : 17861;
const SERVICE_NAME = 'deepseek-claude-proxy';

function getHealth() {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PROXY_PORT,
      path: '/__health',
      method: 'GET',
      timeout: 2000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(body.service === SERVICE_NAME ? body : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function isRunning() {
  return Boolean(await getHealth());
}

function isPortOccupied() {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PROXY_PORT,
      path: '/__health',
      method: 'GET',
      timeout: 1000,
    }, res => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(true); });
    req.end();
  });
}

async function start() {
  if (await isRunning()) return;
  if (await isPortOccupied()) {
    throw new Error(`端口 ${PROXY_PORT} 已被其他服务占用`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROXY_SCRIPT], {
      detached: true,
      stdio: 'pipe',
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('exit', code => {
      if (code !== 0 && code !== null) {
        return reject(new Error(stderr.trim() || `代理进程退出 code=${code}`));
      }
    });

    child.unref();

    const startTime = Date.now();
    const check = async () => {
      if (await isRunning()) return resolve();
      if (Date.now() - startTime > 15000) {
        return reject(new Error('代理启动超时 (15s)'));
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 800);
  });
}

async function stop() {
  try {
    await new Promise(resolve => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path: '/__stop',
        method: 'POST',
        timeout: 3000,
      }, () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
  } catch {}

  for (let i = 0; i < 10; i++) {
    if (!(await isRunning())) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

module.exports = { start, stop, isRunning, getHealth };
