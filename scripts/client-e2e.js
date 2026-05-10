#!/usr/bin/env node
/**
 * Claude Code / Codex 隔离式真实 E2E runner
 *
 * 负责：
 * - 创建临时 gateway、工作区、CODEX_HOME 和独立日志
 * - 真实调用 Claude Code 与 Codex CLI 验证客户端闭环
 * - 生成脱敏报告，并校验用户真实配置未被污染
 *
 * @module scripts/client-e2e
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const providerRegistry = require('../src/providers');
const proxyBundle = require('../src/proxy-bundle');

const API_KEY_ENV = {
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_CLAUDE_API_KEY'],
  zai: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'DEEPSEEK_CLAUDE_ZAI_API_KEY'],
};
const DEFAULT_TARGETS = ['claude-text', 'claude-tool', 'codex-tool'];
const CLAUDE_FLAGS = ['--bare', '--settings', '--no-session-persistence', '--permission-mode', '--model', '--print'];
const CODEX_FLAGS = ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', '--cd', '--output-last-message', '--json'];
function userConfigPaths() {
  return [
    '~/.claude/settings.json',
    '~/.claude/settings.json.deepseek-backup',
    '~/.claude.json',
    '~/.codex/config.toml',
    '~/.codex/config.toml.deepseek-backup',
    '~/.codex/auth.json',
    '~/.deepseek-claude/config.json',
    '~/.deepseek-claude/proxy.js',
    '~/.deepseek-claude/proxy',
    '~/Library/LaunchAgents/com.deepseek.claude-proxy.plist',
    path.join(os.tmpdir(), 'deepseek-claude-proxy.log'),
  ];
}

function nowIso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function tail(text, max = 3000) {
  const s = String(text || '');
  return s.length > max ? s.slice(-max) : s;
}

function expandHome(file) {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

function hashPath(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      const hash = crypto.createHash('sha256');
      function walk(dir, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const rel = path.join(prefix, entry.name);
          const full = path.join(dir, entry.name);
          const itemStat = fs.statSync(full);
          hash.update(`${rel}:${itemStat.size}:${itemStat.mtimeMs}\n`);
          if (entry.isDirectory()) walk(full, rel);
          else if (entry.isFile() && itemStat.size < 2 * 1024 * 1024) hash.update(fs.readFileSync(full));
        }
      }
      walk(file);
      return { exists: true, type: 'dir', sha256: hash.digest('hex') };
    }
    const buf = fs.readFileSync(file);
    return {
      exists: true,
      type: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    return { exists: false };
  }
}

function snapshotUserConfigs() {
  const result = {};
  for (const label of userConfigPaths()) {
    result[label] = hashPath(expandHome(label));
  }
  return result;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(key);
  }
  return changes;
}

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || baseEnv(os.homedir()),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs || 120000);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ command, args, code: 127, stdout, stderr: err.message, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ command, args, code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function baseEnv(homeDir) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: homeDir,
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function requestJson(port, requestPath, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      timeout: 2000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
        } catch {
          resolve({ statusCode: res.statusCode, body: null });
        }
      });
    });
    req.on('error', err => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end();
  });
}

function apiKeyForProvider(providerId) {
  for (const name of API_KEY_ENV[providerId] || []) {
    if (process.env[name]) return { key: process.env[name], source: name };
  }
  if (process.env.CLIENT_E2E_API_KEY) return { key: process.env.CLIENT_E2E_API_KEY, source: 'CLIENT_E2E_API_KEY' };
  return { key: '', source: '' };
}

function parseList(value, fallback) {
  if (!value) return fallback;
  const list = value.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function readOptions() {
  const providerId = process.env.CLIENT_E2E_PROVIDER || process.env.PROVIDER_SMOKE_PROVIDER || 'zai';
  const provider = providerRegistry.getProvider(providerId);
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  const defaultModel = provider.models?.[0]?.id;
  const models = parseList(process.env.CLIENT_E2E_MODELS, [process.env.CLIENT_E2E_MODEL || defaultModel]).filter(Boolean);
  const targets = parseList(process.env.CLIENT_E2E_TARGETS, DEFAULT_TARGETS);
  if (process.env.CLIENT_E2E_LONG === '1' && !targets.includes('codex-long')) targets.push('codex-long');
  return {
    providerId,
    provider,
    models,
    targets: targets.includes('all')
      ? ['claude-text', 'claude-tool', 'codex-tool', 'codex-long']
      : targets.filter(t => t !== 'none'),
    thinking: process.env.CLIENT_E2E_THINKING || 'enabled',
    effort: process.env.CLIENT_E2E_EFFORT || 'high',
    keepTmp: process.env.CLIENT_E2E_KEEP_TMP === '1',
    reportPath: process.env.CLIENT_E2E_REPORT || '',
    claudeBin: process.env.CLIENT_E2E_CLAUDE_BIN || 'claude',
    codexBin: process.env.CLIENT_E2E_CODEX_BIN || 'codex',
    longTimeoutMs: Number(process.env.CLIENT_E2E_LONG_TIMEOUT_MS || 900000),
    retry: process.env.CLIENT_E2E_RETRY === '1',
  };
}

function makeContext(options, apiKeySource) {
  const runId = `${Date.now()}-${process.pid}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `deepseek-client-e2e-${runId}-`));
  const dirs = {
    root,
    gatewayConfig: path.join(root, 'gateway-config'),
    logs: path.join(root, 'logs'),
    workspaces: path.join(root, 'workspaces'),
    codexHome: path.join(root, 'codex-home'),
    claudeHome: path.join(root, 'claude-home'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dirs.root, 'claude-settings.json'), JSON.stringify({
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  }, null, 2));
  fs.writeFileSync(path.join(dirs.root, 'empty-mcp.json'), '{}\n');
  return {
    runId,
    startedAt: nowIso(),
    options,
    apiKeySource,
    dirs,
    logPath: path.join(dirs.logs, 'gateway.log'),
    cases: [],
    models: [],
    cleanup: 'pending',
    configChanges: [],
    secretScan: [],
    toolVersions: {},
  };
}

function redactor(secrets) {
  const active = secrets.filter(Boolean);
  return text => {
    let out = String(text || '');
    for (const secret of active) {
      out = out.split(secret).join('[REDACTED_KEY]');
      if (secret.length > 12) {
        out = out.split(secret.slice(0, 8)).join('[REDACTED_KEY_PREFIX]');
        out = out.split(secret.slice(-8)).join('[REDACTED_KEY_SUFFIX]');
      }
    }
    return out;
  };
}

async function commandText(command, args, timeoutMs) {
  const result = await runCommand(command, args, { timeoutMs });
  return { ok: result.code === 0, text: `${result.stdout}\n${result.stderr}`, result };
}

async function preflight(options) {
  const errors = [];
  const versions = {};
  const needsClaude = options.targets.some(t => t.startsWith('claude'));
  const needsCodex = options.targets.some(t => t.startsWith('codex'));
  let claudePermissionMode = 'permission-mode';

  if (needsClaude) {
    const version = await commandText(options.claudeBin, ['--version'], 10000);
    const help = await commandText(options.claudeBin, ['--help'], 10000);
    versions.claude = tail(version.text, 500).trim();
    if (!version.ok || !help.ok) errors.push('Claude Code CLI 不存在或不可执行');
    for (const flag of CLAUDE_FLAGS) {
      if (!help.text.includes(flag)) errors.push(`Claude Code 缺少必要参数 ${flag}`);
    }
    if (!help.text.includes('bypassPermissions')) {
      if (help.text.includes('--dangerously-skip-permissions')) claudePermissionMode = 'dangerously-skip-permissions';
      else errors.push('Claude Code 缺少 bypassPermissions 或 dangerously-skip-permissions');
    }
  }

  if (needsCodex) {
    const version = await commandText(options.codexBin, ['--version'], 10000);
    const help = await commandText(options.codexBin, ['exec', '--help'], 10000);
    versions.codex = tail(version.text, 500).trim();
    if (!version.ok || !help.ok) errors.push('Codex CLI 不存在或不可执行');
    for (const flag of CODEX_FLAGS) {
      if (!help.text.includes(flag)) errors.push(`Codex CLI 缺少必要参数 ${flag}`);
    }
    if (!help.text.includes('-c, --config')) errors.push('Codex CLI 缺少 -c/--config 覆盖能力');
  }

  return { ok: errors.length === 0, errors, versions, claudePermissionMode };
}

function writeGatewayConfig(ctx, model, apiKey) {
  const { provider, providerId, thinking, effort } = ctx.options;
  const providerConfig = provider.normalizeConfig({
    apiKey,
    model,
    baseUrl: process.env.CLIENT_E2E_BASE_URL || process.env.PROVIDER_SMOKE_BASE_URL,
    anthropicBaseUrl: process.env.CLIENT_E2E_ANTHROPIC_BASE_URL || process.env.PROVIDER_SMOKE_ANTHROPIC_BASE_URL,
  });
  fs.mkdirSync(ctx.dirs.gatewayConfig, { recursive: true });
  proxyBundle.deployProxyBundle(ctx.dirs.gatewayConfig);
  const configPath = path.join(ctx.dirs.gatewayConfig, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    activeProvider: providerId,
    thinking,
    effort,
    providers: { [providerId]: providerConfig },
  }, null, 2));
  try { fs.chmodSync(configPath, 0o600); } catch {}
}

async function startGateway(ctx, model, apiKey) {
  writeGatewayConfig(ctx, model, apiKey);
  const proxyScript = path.join(ctx.dirs.gatewayConfig, 'proxy.js');
  let lastError = '';
  for (let i = 0; i < 5; i++) {
    const port = 22000 + Math.floor(Math.random() * 2000);
    const env = {
      ...baseEnv(ctx.dirs.root),
      DEEPSEEK_CLAUDE_CONFIG_DIR: ctx.dirs.gatewayConfig,
      DEEPSEEK_CLAUDE_PROXY_PORT: String(port),
      DEEPSEEK_CLAUDE_LOG_PATH: ctx.logPath,
    };
    const child = spawn(process.execPath, [proxyScript], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const health = await requestJson(port, '/__health');
      if (health.body?.service === 'deepseek-claude-proxy') {
        redactGatewayConfig(ctx);
        return { port, child, health: health.body };
      }
      await new Promise(r => setTimeout(r, 400));
    }
    lastError = stderr || `gateway health timeout on port ${port}`;
    try { child.kill('SIGTERM'); } catch {}
  }
  throw new Error(lastError);
}

async function stopGateway(gateway) {
  if (!gateway?.port) return;
  await requestJson(gateway.port, '/__stop', 'POST');
  await new Promise(r => setTimeout(r, 500));
  try { gateway.child?.kill('SIGTERM'); } catch {}
}

function prepareWorkspace(ctx, model, kind) {
  const name = `client-e2e-${safeName(model)}-${ctx.runId}`.slice(0, 80);
  const dir = path.join(ctx.dirs.workspaces, safeName(model), kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }, null, 2));
  return { dir, packageName: name };
}

function claudeEnv(ctx, port) {
  const env = {
    ...baseEnv(ctx.dirs.claudeHome),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'client-e2e-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  return env;
}

function claudeArgs(ctx, model, prompt, mode, useBash) {
  const args = [
    '--bare',
    '-p',
    '--no-session-persistence',
    '--model', model,
    '--settings', path.join(ctx.dirs.root, 'claude-settings.json'),
    '--setting-sources', 'local',
    '--strict-mcp-config',
    '--mcp-config', path.join(ctx.dirs.root, 'empty-mcp.json'),
    '--output-format', 'text',
  ];
  if (mode === 'dangerously-skip-permissions') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'bypassPermissions');
  if (useBash) args.push('--tools', 'Bash');
  args.push(prompt);
  return args;
}

function logSlice(ctx, start) {
  try {
    const text = fs.readFileSync(ctx.logPath, 'utf-8');
    return text.slice(start);
  } catch {
    return '';
  }
}

function logSize(ctx) {
  try { return fs.statSync(ctx.logPath).size; } catch { return 0; }
}

async function runClaudeCase(ctx, gateway, model, caseName, permissionMode, redact) {
  const ws = prepareWorkspace(ctx, model, caseName);
  const marker = caseName === 'claude-text'
    ? 'CLAUDE_TEXT_PASS'
    : `CLAUDE_TOOL_PASS:${ws.packageName}`;
  const prompt = caseName === 'claude-text'
    ? `Reply exactly: ${marker}`
    : 'Use Bash to read ./package.json, extract its name field, write the exact name to bash-proof.txt, then reply exactly: CLAUDE_TOOL_PASS:<name>';
  const start = logSize(ctx);
  const result = await runCommand(ctx.options.claudeBin, claudeArgs(ctx, model, prompt, permissionMode, caseName !== 'claude-text'), {
    cwd: ws.dir,
    env: claudeEnv(ctx, gateway.port),
    timeoutMs: 180000,
  });
  const caseLog = logSlice(ctx, start);
  const proofPath = path.join(ws.dir, 'bash-proof.txt');
  const proof = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, 'utf-8').trim() : '';
  const proofOk = caseName === 'claude-text' || proof === ws.packageName;
  const passed = result.code === 0 && result.stdout.includes(marker) && proofOk && caseLog.includes('MSG_DONE');
  return {
    name: caseName,
    model,
    status: passed ? 'PASS' : 'FAIL',
    durationMs: result.durationMs,
    marker,
    errorType: passed ? '' : (result.code !== 0 ? 'claude-exit' : proofOk ? 'marker-or-log-missing' : 'claude-tool-not-executed'),
    stdout: redact(tail(result.stdout)),
    stderr: redact(tail(result.stderr)),
    proof: redact(proof),
    logSummary: redact(tail(caseLog, 1500)),
  };
}

function codexArgs(ctx, gateway, model, workDir, outputFile, prompt, longMode) {
  const sandbox = process.env.CLIENT_E2E_CODEX_SANDBOX || (longMode ? 'workspace-write' : 'workspace-write');
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--json',
    '--sandbox', sandbox,
    '--cd', workDir,
    '--output-last-message', outputFile,
    '-c', `model=${JSON.stringify(model)}`,
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="gateway_e2e"',
    '-c', 'model_providers.gateway_e2e.name="Gateway E2E"',
    '-c', `model_providers.gateway_e2e.base_url=${JSON.stringify(`http://127.0.0.1:${gateway.port}/v1`)}`,
    '-c', 'model_providers.gateway_e2e.wire_api="responses"',
    '-c', 'model_providers.gateway_e2e.experimental_bearer_token="client-e2e-token"',
    '-c', 'model_providers.gateway_e2e.request_max_retries=0',
    '-c', 'model_providers.gateway_e2e.stream_max_retries=0',
    '-c', 'model_providers.gateway_e2e.stream_idle_timeout_ms=600000',
    prompt,
  ];
}

async function initGit(workDir) {
  await runCommand('git', ['init', '-q'], { cwd: workDir, timeoutMs: 10000 });
}

async function runCodexTool(ctx, gateway, model, redact) {
  const ws = prepareWorkspace(ctx, model, 'codex-tool');
  await initGit(ws.dir);
  const marker = `CODEX_TOOL_PASS:${ws.packageName}`;
  const outputFile = path.join(ctx.dirs.logs, `codex-tool-${safeName(model)}.txt`);
  const prompt = 'Use shell to read ./package.json and reply exactly: CODEX_TOOL_PASS:<the package name from file>';
  const start = logSize(ctx);
  const env = { ...baseEnv(ctx.dirs.codexHome), CODEX_HOME: ctx.dirs.codexHome };
  const result = await runCommand(ctx.options.codexBin, codexArgs(ctx, gateway, model, ws.dir, outputFile, prompt, false), {
    cwd: ws.dir,
    env,
    timeoutMs: 240000,
  });
  const last = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '';
  const caseLog = logSlice(ctx, start);
  const passed = result.code === 0 && last.includes(marker)
    && caseLog.includes('RESPONSES_DONE') && /tools=[1-9]/.test(caseLog) && !caseLog.includes('RESPONSES_FAILED');
  return {
    name: 'codex-tool',
    model,
    status: passed ? 'PASS' : 'FAIL',
    durationMs: result.durationMs,
    marker,
    errorType: passed ? '' : (caseLog.includes('RESPONSES_FAILED') ? 'responses-failed' : 'codex-tool-failure'),
    stdout: redact(tail(result.stdout)),
    stderr: redact(tail(result.stderr)),
    lastMessage: redact(tail(last)),
    logSummary: redact(tail(caseLog, 2000)),
  };
}

async function runCodexLong(ctx, gateway, model, redact) {
  const ws = prepareWorkspace(ctx, model, 'codex-long');
  await initGit(ws.dir);
  const outputFile = path.join(ctx.dirs.logs, `codex-long-${safeName(model)}.txt`);
  const prompt = [
    '写一个 Node.js HTTP 文件管理服务，只使用 Node 内置模块。',
    '1. 创建 server.js，支持 GET /、GET /files、GET /files/:name、POST /files/:name、DELETE /files/:name。',
    '2. 文件存到 ./data。',
    '3. 创建 test.sh，用 curl 跑 7 个断言，最后输出 ALL 7 TESTS PASS。',
    '4. 实际运行 bash test.sh，修到测试通过。',
  ].join('\n');
  const start = logSize(ctx);
  const env = { ...baseEnv(ctx.dirs.codexHome), CODEX_HOME: ctx.dirs.codexHome };
  const result = await runCommand(ctx.options.codexBin, codexArgs(ctx, gateway, model, ws.dir, outputFile, prompt, true), {
    cwd: ws.dir,
    env,
    timeoutMs: ctx.options.longTimeoutMs,
  });
  const verify = fs.existsSync(path.join(ws.dir, 'test.sh'))
    ? await runCommand('bash', ['test.sh'], { cwd: ws.dir, timeoutMs: 120000 })
    : { code: 1, stdout: '', stderr: 'missing test.sh', durationMs: 0 };
  const caseLog = logSlice(ctx, start);
  const passed = result.code === 0
    && fs.existsSync(path.join(ws.dir, 'server.js'))
    && verify.code === 0
    && verify.stdout.includes('ALL 7 TESTS PASS')
    && !caseLog.includes('RESPONSES_FAILED');
  return {
    name: 'codex-long',
    model,
    status: passed ? 'PASS' : 'FAIL',
    durationMs: result.durationMs + verify.durationMs,
    marker: 'ALL 7 TESTS PASS',
    errorType: passed ? '' : (caseLog.includes('RESPONSES_FAILED') ? 'responses-failed' : 'codex-long-failure'),
    stdout: redact(tail(result.stdout)),
    stderr: redact(tail(result.stderr)),
    verifyStdout: redact(tail(verify.stdout)),
    verifyStderr: redact(tail(verify.stderr)),
    logSummary: redact(tail(caseLog, 2500)),
  };
}

function unsupportedCase(name, model, reason) {
  return { name, model, status: 'SKIPPED_UNSUPPORTED', durationMs: 0, reason };
}

async function runTarget(ctx, gateway, model, target, preflightInfo, redact) {
  const caps = ctx.options.provider.capabilities || {};
  if (target.startsWith('claude') && !caps.claudeCode) return unsupportedCase(target, model, 'provider has no Claude Code capability');
  if (target.startsWith('codex') && !caps.codex) return unsupportedCase(target, model, 'provider has no Codex capability');
  if (target === 'claude-text' || target === 'claude-tool') {
    return runClaudeCase(ctx, gateway, model, target, preflightInfo.claudePermissionMode, redact);
  }
  if (target === 'codex-tool') return runCodexTool(ctx, gateway, model, redact);
  if (target === 'codex-long') return runCodexLong(ctx, gateway, model, redact);
  return { name: target, model, status: 'SKIPPED_UNKNOWN', durationMs: 0, reason: 'unknown target' };
}

async function runModel(ctx, model, apiKey, preflightInfo, redact) {
  const modelResult = { model, status: 'PASS', health: null, cases: [] };
  let gateway = null;
  try {
    gateway = await startGateway(ctx, model, apiKey);
    modelResult.health = gateway.health;
    for (const target of ctx.options.targets) {
      let result;
      try {
        result = await runTarget(ctx, gateway, model, target, preflightInfo, redact);
      } catch (err) {
        result = { name: target, model, status: 'FAIL', durationMs: 0, errorType: 'target-runner-error', error: redact(err.message) };
      }
      modelResult.cases.push(result);
      ctx.cases.push(result);
      if (result.status === 'FAIL') modelResult.status = 'FAIL';
    }
  } catch (err) {
    modelResult.status = 'FAIL';
    const result = { name: 'gateway', model, status: 'FAIL', errorType: 'gateway-start', error: redact(err.message) };
    modelResult.cases.push(result);
    ctx.cases.push(result);
  } finally {
    await stopGateway(gateway);
  }
  ctx.models.push(modelResult);
}

function reportSummary(ctx) {
  const failed = ctx.cases.filter(c => c.status === 'FAIL');
  const passed = ctx.cases.filter(c => c.status === 'PASS');
  const skipped = ctx.cases.filter(c => String(c.status).startsWith('SKIPPED'));
  const cleanupFailed = ctx.cleanup && ctx.cleanup !== 'ok' && ctx.cleanup !== 'kept';
  const status = failed.length || ctx.configChanges.length || ctx.secretScan.length || cleanupFailed ? 'FAIL' : 'PASS';
  return { status, passed: passed.length, failed: failed.length, skipped: skipped.length };
}

function markdownReport(ctx) {
  const summary = reportSummary(ctx);
  const lines = [
    '# Client E2E Report',
    '',
    `- Status: ${summary.status}`,
    `- Run ID: ${ctx.runId}`,
    `- Started: ${ctx.startedAt}`,
    `- Provider: ${ctx.options.providerId}`,
    `- Models: ${ctx.options.models.join(', ')}`,
    `- Targets: ${ctx.options.targets.join(', ') || '(none)'}`,
    `- Claude Code: ${ctx.toolVersions.claude || '(not required)'}`,
    `- Codex CLI: ${ctx.toolVersions.codex || '(not required)'}`,
    `- Temp root: ${ctx.options.keepTmp ? ctx.dirs.root : '(removed)'}`,
    '',
    '| Model | Case | Status | Duration | Error |',
    '|-------|------|--------|----------|-------|',
  ];
  for (const item of ctx.cases) {
    lines.push(`| ${item.model} | ${item.name} | ${item.status} | ${item.durationMs || 0}ms | ${item.errorType || item.reason || ''} |`);
  }
  lines.push('', '## Safety Checks', '');
  lines.push(`- User config changes: ${ctx.configChanges.length ? ctx.configChanges.join(', ') : 'none'}`);
  lines.push(`- Secret scan hits: ${ctx.secretScan.length ? ctx.secretScan.join(', ') : 'none'}`);
  lines.push(`- Cleanup: ${ctx.cleanup}`);
  return lines.join('\n') + '\n';
}

function scanForSecret(root, secret) {
  if (!secret || secret.length < 12) return [];
  const hits = [];
  const skip = new Set(['.git', 'node_modules']);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile()) {
        try {
          if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
          if (fs.readFileSync(full, 'utf-8').includes(secret)) hits.push(path.relative(root, full));
        } catch {}
      }
    }
  }
  walk(root);
  return hits;
}

function redactGatewayConfig(ctx) {
  const configPath = path.join(ctx.dirs.gatewayConfig, 'config.json');
  try {
    const json = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const value of Object.values(json.providers || {})) {
      if (value && typeof value === 'object' && value.apiKey) value.apiKey = '[REDACTED_KEY]';
    }
    fs.writeFileSync(configPath, JSON.stringify(json, null, 2));
  } catch {}
}

function writeReports(ctx, redact) {
  fs.mkdirSync(ctx.dirs.root, { recursive: true });
  const json = redact(JSON.stringify({ ...ctx, summary: reportSummary(ctx) }, null, 2));
  const md = redact(markdownReport(ctx));
  fs.writeFileSync(path.join(ctx.dirs.root, 'report.json'), json);
  fs.writeFileSync(path.join(ctx.dirs.root, 'report.md'), md);
  if (ctx.options.reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(ctx.options.reportPath)), { recursive: true });
    fs.writeFileSync(ctx.options.reportPath, md);
  }
  console.log(md);
}

async function main() {
  const before = snapshotUserConfigs();
  const options = readOptions();
  const { key: apiKey, source } = apiKeyForProvider(options.providerId);
  const redact = redactor([apiKey]);
  if (!apiKey) throw new Error(`Missing API key for ${options.providerId}; set ${(API_KEY_ENV[options.providerId] || []).concat('CLIENT_E2E_API_KEY').join(', ')}`);

  const preflightInfo = await preflight(options);
  if (!preflightInfo.ok) throw new Error(preflightInfo.errors.join('\n'));

  const ctx = makeContext(options, source);
  ctx.toolVersions = preflightInfo.versions;
  try {
    for (const model of options.models) {
      await runModel(ctx, model, apiKey, preflightInfo, redact);
    }
    redactGatewayConfig(ctx);
    ctx.configChanges = diffSnapshots(before, snapshotUserConfigs());
    ctx.secretScan = [
      ...scanForSecret(process.cwd(), apiKey).map(p => `project:${p}`),
      ...scanForSecret(ctx.dirs.root, apiKey).map(p => `tmp:${p}`),
    ];
    if (options.keepTmp) ctx.cleanup = 'kept';
    else {
      fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
      ctx.cleanup = 'ok';
    }
    if (options.keepTmp) writeReports(ctx, redact);
    else {
      fs.mkdirSync(ctx.dirs.root, { recursive: true });
      writeReports(ctx, redact);
      fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
    }
    process.exit(reportSummary(ctx).status === 'PASS' ? 0 : 1);
  } catch (err) {
    ctx.configChanges = diffSnapshots(before, snapshotUserConfigs());
    ctx.cases.push({ name: 'runner', model: '-', status: 'FAIL', errorType: 'runner-error', error: redact(err.message) });
    try { redactGatewayConfig(ctx); } catch {}
    ctx.secretScan = [
      ...scanForSecret(process.cwd(), apiKey).map(p => `project:${p}`),
      ...scanForSecret(ctx.dirs.root, apiKey).map(p => `tmp:${p}`),
    ];
    if (options.keepTmp) ctx.cleanup = 'kept';
    else {
      fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
      ctx.cleanup = 'ok';
    }
    writeReports(ctx, redact);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
