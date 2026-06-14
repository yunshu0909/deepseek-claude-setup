/**
 * 认证 runner 公共工具
 *
 * 负责：
 * - 提供跨平台 spawn 包装
 * - 提供 HTTP JSON 请求工具
 * - 提供随机端口与临时目录清理辅助
 *
 * @module scripts/certification/runner-utils
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function randomPort() {
  return 22000 + Math.floor(Math.random() * 20000);
}

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
}

/**
 * 执行子进程并收集输出。
 * @param {string} command - 命令。
 * @param {string[]} args - 参数。
 * @param {object} [options] - spawn 选项。
 * @returns {Promise<object>} 执行结果。
 */
function runCommand(command, args = [], options = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let timedOut = false;
    let settled = false;
    let exitFallback = null;
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    function finish(status, destroyPipes = false) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (exitFallback) clearTimeout(exitFallback);
      if (destroyPipes) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const exitStatus = timedOut ? 124 : status;
      resolve({ status: exitStatus, code: exitStatus, durationMs: Date.now() - started, stdout, stderr, timedOut });
    }

    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
        stderr += `\nTIMEOUT after ${options.timeoutMs}ms`;
      }, options.timeoutMs)
      : null;
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      if (timeout) clearTimeout(timeout);
      if (exitFallback) clearTimeout(exitFallback);
      if (settled) return;
      settled = true;
      resolve({ status: 127, code: 127, durationMs: Date.now() - started, stdout, stderr: `${stderr}\n${err.message}`.trim(), error: err });
    });
    child.on('exit', status => {
      // Some CLI test commands spawn grandchildren that inherit stdio; their main process exits, but Node's
      // `close` can wait for those inherited pipes indefinitely. Use `close` when it arrives, and fall back to
      // the process exit code after a short drain window so certification does not false-timeout.
      exitFallback = setTimeout(() => finish(status, true), options.exitGraceMs || 1000);
    });
    child.on('close', status => finish(status));
  });
}

function requestJson({ port, requestPath, method = 'POST', body, headers = {}, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: text, json: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`request timeout: ${requestPath}`));
    });
    if (raw) req.write(raw);
    req.end();
  });
}

module.exports = {
  makeTempRoot,
  randomPort,
  removeIfExists,
  requestJson,
  runCommand,
};
