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
require('./lib/load-env'); // 先加载仓库根 .env（不覆盖已 export 的环境变量）
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const providerRegistry = require('../src/providers');
const proxyBundle = require('../src/proxy-bundle');
const autostart = require('../src/autostart');
const capabilityAsserts = require('./lib/capability-asserts');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT_DIR = path.join(PROJECT_ROOT, '自动化测试', 'V0.5');
const DEFAULT_REPORT_BASENAME = 'CLIENT_E2E_REPORT_LATEST';
// PRD-007 SEQUENCE 模式专用报告目录（V0.6）
const MATRIX_REPORT_DIR = path.join(PROJECT_ROOT, '自动化测试', 'V0.6');
const MATRIX_REPORT_BASENAME = 'CLIENT_E2E_MATRIX_LATEST';
const CAPTURE_PORT_RANGE = [24000, 26000];

const API_KEY_ENV = {
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_CLAUDE_API_KEY'],
  zai: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'DEEPSEEK_CLAUDE_ZAI_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_CLAUDE_KIMI_API_KEY'],
};
const DEFAULT_TARGETS = ['claude-text', 'claude-tool', 'codex-tool'];
const CLAUDE_FLAGS = ['--bare', '--settings', '--no-session-persistence', '--permission-mode', '--model', '--print'];
const CODEX_FLAGS = ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', '--cd', '--output-last-message', '--json'];
// 用户真实配置文件清单 —— 只列 runner 自己有可能写、且 release gate 真正在意的路径。
//
// 已经从清单里**移除**的几类：
// - 跨平台自启资源：`~/Library/LaunchAgents/...` 等用 autostart.isInstalled() fingerprint 替代，
//   见 snapshotUserConfigs 里的 __autostart 字段。
// - `os.tmpdir()/deepseek-claude-proxy.log`：用户正常 17861 代理一直在写，必误报；
//   E2E 已用 DEEPSEEK_CLAUDE_LOG_PATH 隔离到 <tmp>/logs/gateway.log。
// - `~/.claude.json`：Claude Code 用户级状态/统计文件，runner 从不写它（settings-patcher
//   只改 `~/.claude/settings.json`），但外部 Claude 会话每分钟都在写它，监控它必误报。
function userConfigPaths() {
  return [
    '~/.claude/settings.json',
    '~/.claude/settings.json.deepseek-backup',
    '~/.codex/config.toml',
    '~/.codex/config.toml.deepseek-backup',
    '~/.codex/auth.json',
    '~/.deepseek-claude/config.json',
    '~/.deepseek-claude/proxy.js',
    '~/.deepseek-claude/proxy',
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
  // 跨平台自启 fingerprint：复用 src/autostart 抽象（mac=plist 文件存在，
  // win32=schtasks 任务存在 + Startup VBS fallback，linux=永远 false）。
  // 用 isInstalled() 的布尔值即可——E2E 关心的是"自启状态有没有被改"，不是绝对值。
  try {
    result['__autostart'] = { exists: true, type: 'fingerprint', sha256: autostart.isInstalled() ? '1' : '0' };
  } catch {
    result['__autostart'] = { exists: false };
  }
  return result;
}

// 只比较 sha256 + exists + type，忽略 size/mtime。
// 原因：codex 在 --ignore-user-config 下仍会 touch ~/.codex/config.toml 的 mtime，
// 但内容未变；如果 stringify 整字段比较，touch-only 会被误报为污染。
function diffSnapshots(before, after) {
  const changes = [];
  for (const key of Object.keys(before)) {
    const b = before[key] || {};
    const a = after[key] || {};
    if (b.exists !== a.exists || b.type !== a.type || b.sha256 !== a.sha256) {
      changes.push(key);
    }
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
  // 测试开关：把"思考落盘"开关透传给网关/客户端子进程（默认未设则不传，行为不变）
  if (process.env.DEEPSEEK_CAPTURE_THINKING) env.DEEPSEEK_CAPTURE_THINKING = process.env.DEEPSEEK_CAPTURE_THINKING;
  // Windows 下 Node child_process 缺 SYSTEMROOT 会挂；找可执行文件需要 PATHEXT；
  // 一些子进程会读 APPDATA / LOCALAPPDATA / USERPROFILE 取用户配置。
  if (process.platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
                       'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
      if (process.env[key]) env[key] = process.env[key];
    }
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
    // PRD-007 US-41: 切换序列模式入口
    sequence: process.env.CLIENT_E2E_SEQUENCE || '',
    matrix: process.env.CLIENT_E2E_MATRIX || '',
    captureUpstream: process.env.CLIENT_E2E_CAPTURE_UPSTREAM !== '0', // 默认开
  };
}

// PRD-007 US-41: 解析 SEQUENCE 字符串到 step 数组
// 格式：'ds:pro:on:max → ds:flash:off:- → zai:5.1:on:-'
// 分隔符：→ 或 > 或 ,
// 字段：provider:model:thinking:effort
//   - provider: 'ds'|'deepseek'|'zai'|'zhipu'|'kimi'...（匹配 provider id 或别名）
//   - model: 完整 id 或 suffix（'pro' → 'deepseek-v4-pro'，'5.1' → 'glm-5.1'）
//   - thinking: 'on'|'enabled'|'off'|'disabled'
//   - effort: 'high'|'max'|'-'（'-' = placeholder，capability 不支持时用）
const PROVIDER_ALIASES = { ds: 'deepseek', zhipu: 'zai', glm: 'zai' };

function normalizeProviderId(id) {
  return PROVIDER_ALIASES[id.toLowerCase()] || id.toLowerCase();
}

function resolveModelId(provider, modelHint) {
  if (!modelHint || modelHint === '-') return provider.models?.[0]?.id;
  const models = provider.models || [];
  // 完整匹配优先
  const exact = models.find(m => m.id === modelHint);
  if (exact) return exact.id;
  // suffix 匹配（'pro' 匹配 'deepseek-v4-pro'；'5.1' 匹配 'glm-5.1'）
  const suffix = models.find(m => m.id.endsWith('-' + modelHint) || m.id.endsWith(modelHint));
  if (suffix) return suffix.id;
  // contains 兜底
  const contains = models.find(m => m.id.includes(modelHint));
  return contains ? contains.id : modelHint;
}

function normalizeThinkingValue(v) {
  if (v === 'on' || v === 'enabled') return 'enabled';
  if (v === 'off' || v === 'disabled') return 'disabled';
  return 'enabled';
}

function parseSequence(input) {
  if (!input) return [];
  const steps = input.split(/[→>,]/).map(s => s.trim()).filter(Boolean);
  return steps.map((step, idx) => {
    const parts = step.split(':');
    if (parts.length < 2) throw new Error(`Invalid SEQUENCE step '${step}'：需要 provider:model[:thinking[:effort]]`);
    const [pid, modelHint, thinkingHint, effortHint] = parts;
    const providerId = normalizeProviderId(pid);
    const provider = providerRegistry.getProvider(providerId);
    if (!provider) throw new Error(`SEQUENCE step '${step}' 用了未注册 provider '${providerId}'`);
    const model = resolveModelId(provider, modelHint);
    return {
      index: idx + 1,
      raw: step,
      provider,
      providerId,
      model,
      thinking: normalizeThinkingValue(thinkingHint || 'on'),
      effort: (effortHint && effortHint !== '-') ? effortHint : '-',
    };
  });
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
  fs.writeFileSync(path.join(dirs.root, 'empty-mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
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

async function commandText(command, args, timeoutMs, env) {
  const result = await runCommand(command, args, { timeoutMs, env });
  return { ok: result.code === 0, text: `${result.stdout}\n${result.stderr}`, result };
}

async function preflight(options) {
  const errors = [];
  const versions = {};
  const needsClaude = options.targets.some(t => t.startsWith('claude'));
  const needsCodex = options.targets.some(t => t.startsWith('codex'));
  let claudePermissionMode = 'permission-mode';
  const preflightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-client-e2e-preflight-'));

  try {
    if (needsClaude) {
      const claudeHome = path.join(preflightRoot, 'claude-home');
      fs.mkdirSync(claudeHome, { recursive: true });
      const env = {
        ...baseEnv(claudeHome),
        CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
        DISABLE_AUTOUPDATER: '1',
      };
      const version = await commandText(options.claudeBin, ['--version'], 10000, env);
      const help = await commandText(options.claudeBin, ['--help'], 10000, env);
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
      const codexHome = path.join(preflightRoot, 'codex-home');
      fs.mkdirSync(codexHome, { recursive: true });
      const env = { ...baseEnv(codexHome), CODEX_HOME: codexHome };
      const version = await commandText(options.codexBin, ['--version'], 10000, env);
      const help = await commandText(options.codexBin, ['exec', '--help'], 10000, env);
      versions.codex = tail(version.text, 500).trim();
      if (!version.ok || !help.ok) errors.push('Codex CLI 不存在或不可执行');
      for (const flag of CODEX_FLAGS) {
        if (!help.text.includes(flag)) errors.push(`Codex CLI 缺少必要参数 ${flag}`);
      }
      if (!help.text.includes('-c, --config')) errors.push('Codex CLI 缺少 -c/--config 覆盖能力');
    }
  } finally {
    fs.rmSync(preflightRoot, { recursive: true, force: true });
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

/**
 * PRD-007 US-39: 五字段 health 校验
 *
 * 字段语义：
 * - service / provider / model：三字段必须严格相等
 * - thinking：provider capability.thinking=false 时 health 返回 'unsupported'，否则按 ctx.options.thinking 比对
 * - effort：provider capability.thinkingEffort=false 时 health 返回 null，否则按 ctx.options.effort 比对
 *
 * @param {object} body - GET /__health 响应体
 * @param {object} ctx - runner context（含 options.providerId / thinking / effort / provider.capabilities）
 * @param {string} model - 当前 step 的 model id
 * @returns {boolean} true 表示 health 一致
 */
function healthMatches(body, ctx, model) {
  if (!body) return false;
  if (body.service !== 'deepseek-claude-proxy') return false;
  if (body.provider !== ctx.options.providerId) return false;
  if (body.model !== model) return false;

  const caps = ctx.options.provider?.capabilities || {};

  // thinking 字段：provider 不支持 → 必须为 'unsupported'；支持 → 必须等于 ctx.options.thinking
  if (caps.thinking === false) {
    if (body.thinking !== 'unsupported') return false;
  } else {
    if (body.thinking !== ctx.options.thinking) return false;
  }

  // effort 字段：provider 声明 thinkingEffort=false → 必须为 null；
  // 否则在 thinking=enabled 时按 ctx.options.effort 比对；thinking=disabled 时也应为 null
  if (caps.thinkingEffort === false) {
    if (body.effort !== null) return false;
  } else if (ctx.options.thinking === 'enabled') {
    if (body.effort !== ctx.options.effort) return false;
  } else {
    if (body.effort !== null) return false;
  }

  return true;
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
    // Windows 上 spawn detached + windowsHide:true 才能不弹黑窗；mac 上 windowsHide 是 noop。
    const child = spawn(process.execPath, [proxyScript], {
      env, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const health = await requestJson(port, '/__health');
      // PRD-007 US-39 升级：health 校验从三字段扩到五字段。
      // - thinking 字段：provider 不支持思考时 healthBody 返回 'unsupported'；
      //   支持时按 ctx.options.thinking 比对。
      // - effort 字段：provider 声明 thinkingEffort=false 时 healthBody 返回 null；
      //   支持时按 ctx.options.effort 比对，且仅在 thinking=enabled 时校验非 null。
      // 配错任何一项会被这道闸抓住，而不是等到真请求才暴露。
      if (healthMatches(health.body, ctx, model)) {
        redactGatewayConfig(ctx);
        return { port, child, health: health.body };
      }
      await new Promise(r => setTimeout(r, 400));
    }
    lastError = stderr || `gateway health timeout on port ${port}`;
    // 不指定 signal：Node 在 Windows 用 TerminateProcess、mac 用 SIGTERM，自动适配。
    try { child.kill(); } catch {}
  }
  throw new Error(lastError);
}

async function stopGateway(gateway) {
  if (!gateway?.port) return;
  await requestJson(gateway.port, '/__stop', 'POST');
  await new Promise(r => setTimeout(r, 500));
  // 不指定 signal：跨平台兜台 kill。
  try { gateway.child?.kill(); } catch {}
}

// =============== PRD-007 SEQUENCE 切换矩阵模式 ===============

/**
 * PRD-007 §2.5 测试用例总账
 *
 * 每条 case 表达为一个 SEQUENCE 字符串。runner 跑序列时每步都断言；
 * state leak（X-4 / X-5）跟普通切换共用 SEQUENCE 引擎，只在报告中额外标记。
 * probe 字段决定跑哪些路径：
 *   - 'claude'（默认）：只发 Anthropic Messages（覆盖 anthropic path 断言）
 *   - 'codex'：只发 OpenAI Responses（覆盖 chat path 断言）
 *   - 'both'：两条路径都跑（DS-T/E、跨切等都需要双路径才能完整覆盖）
 */
const MATRIX_CASES = {
  DS: [
    { id: 'DS-M1', desc: 'model v4-pro → v4-flash', seq: 'ds:pro:on:max → ds:flash:on:max', probe: 'both' },
    { id: 'DS-M2', desc: 'model v4-flash → v4-pro', seq: 'ds:flash:on:max → ds:pro:on:max', probe: 'both' },
    { id: 'DS-T1', desc: 'thinking on → off', seq: 'ds:pro:on:max → ds:pro:off:max', probe: 'both' },
    { id: 'DS-T2', desc: 'thinking off → on', seq: 'ds:pro:off:max → ds:pro:on:max', probe: 'both' },
    { id: 'DS-E1', desc: 'effort high → max', seq: 'ds:pro:on:high → ds:pro:on:max', probe: 'both' },
    { id: 'DS-E2', desc: 'effort max → high', seq: 'ds:pro:on:max → ds:pro:on:high', probe: 'both' },
  ],
  ZAI: [
    { id: 'ZAI-M1', desc: 'model glm-5.1 → glm-5', seq: 'zai:5.1:on:- → zai:5:on:-', probe: 'both' },
    { id: 'ZAI-M2', desc: 'model glm-5 → glm-5-turbo', seq: 'zai:5:on:- → zai:5-turbo:on:-', probe: 'both' },
    { id: 'ZAI-M3', desc: 'model glm-5-turbo → glm-4.7', seq: 'zai:5-turbo:on:- → zai:4.7:on:-', probe: 'both' },
    { id: 'ZAI-M4', desc: 'model glm-4.7 → glm-5.1', seq: 'zai:4.7:on:- → zai:5.1:on:-', probe: 'both' },
    { id: 'ZAI-T1', desc: 'thinking on → off', seq: 'zai:5.1:on:- → zai:5.1:off:-', probe: 'both' },
    { id: 'ZAI-T2', desc: 'thinking off → on', seq: 'zai:5.1:off:- → zai:5.1:on:-', probe: 'both' },
    { id: 'ZAI-E1', desc: 'effort 切换应被忽略', seq: 'zai:5.1:on:high → zai:5.1:on:max', probe: 'both' },
  ],
  CROSS: [
    { id: 'X-1', desc: 'cross DS → zai', seq: 'ds:pro:on:max → zai:5.1:on:-', probe: 'both' },
    { id: 'X-2', desc: 'cross zai → DS', seq: 'zai:5.1:on:- → ds:pro:on:max', probe: 'both' },
    { id: 'X-3', desc: 'DS→zai→DS 配置保留', seq: 'ds:flash:on:high → zai:5.1:on:- → ds:flash:on:high', probe: 'both' },
    { id: 'X-4', desc: 'state leak zai → DS', seq: 'zai:5.1:on:- → ds:pro:on:max', probe: 'both', stateLeak: true },
    { id: 'X-5', desc: 'state leak DS → zai', seq: 'ds:pro:on:max → zai:5.1:on:-', probe: 'both', stateLeak: true },
    { id: 'X-6', desc: 'zai→DS→zai 配置保留', seq: 'zai:5.1:off:- → ds:pro:on:max → zai:5.1:off:-', probe: 'both' },
    { id: 'X-7', desc: '跨切同时改 thinking', seq: 'ds:pro:on:max → zai:5.1:off:-', probe: 'both' },
    { id: 'X-8', desc: '5 步循环切换', seq: 'ds:pro:on:max → zai:5.1:on:- → ds:flash:on:high → zai:5-turbo:off:- → ds:pro:on:max', probe: 'claude' },
    { id: 'X-9', desc: '跨切 + 工具调用', seq: 'ds:pro:on:max → zai:5.1:on:-', probe: 'codex' },
  ],
  // PRD-007 US-49 模板化复利验证：接 Kimi 作为新 provider 后矩阵自动展开。
  // v0.7 PRD-008 US-44 据实修正后 Kimi caps：thinking=true / thinkingEffort=false /
  // anthropicThinking=true / claudeCode='anthropic_forward'（v0.6 的 null 是错的）。
  // 故 probe 改 'both'（Anthropic 端点真实存在）；模型 ID 用修正后的 k2.6/k2.5/thinking。
  // 注意：Kimi capability 无 preservedThinking/toolStreamParam 且 thinkingEffort=false，
  // capability-asserts 对 Kimi 推导出的 mustHave 近空 → 矩阵对 Kimi 仍偏同义反复
  // （PRD-007 runConfig 写死遗留，§7.4 已诚实标注，v0.7 待修；真实可用以 happy-path 真测为准）。
  KIMI: [
    { id: 'KIMI-M1', desc: 'model k2.6 → k2.5', seq: 'kimi:k2.6:on:- → kimi:k2.5:on:-', probe: 'both' },
    { id: 'KIMI-M2', desc: 'model k2.5 → k2-thinking', seq: 'kimi:k2.5:on:- → kimi:k2-thinking:on:-', probe: 'both' },
    { id: 'KIMI-M3', desc: 'model k2-thinking → k2.6', seq: 'kimi:k2-thinking:on:- → kimi:k2.6:on:-', probe: 'both' },
    { id: 'KIMI-T1', desc: 'thinking on → off', seq: 'kimi:k2.6:on:- → kimi:k2.6:off:-', probe: 'both' },
    { id: 'KIMI-T2', desc: 'thinking off → on', seq: 'kimi:k2.6:off:- → kimi:k2.6:on:-', probe: 'both' },
    { id: 'KIMI-E1', desc: 'effort 切换应被忽略', seq: 'kimi:k2.6:on:high → kimi:k2.6:on:max', probe: 'both' },
  ],
  CROSS_KIMI: [
    { id: 'XK-1', desc: 'cross DS → kimi', seq: 'ds:pro:on:max → kimi:k2.6:on:-', probe: 'both' },
    { id: 'XK-2', desc: 'cross kimi → DS', seq: 'kimi:k2.6:on:- → ds:pro:on:max', probe: 'both' },
    { id: 'XK-3', desc: 'cross zai → kimi', seq: 'zai:5.1:on:- → kimi:k2.6:on:-', probe: 'both' },
    { id: 'XK-4', desc: 'cross kimi → zai', seq: 'kimi:k2.6:on:- → zai:5.1:on:-', probe: 'both' },
  ],
};

function expandMatrix(matrixType) {
  if (!matrixType) return [];
  const m = String(matrixType).toLowerCase();
  // switch：DS + ZAI + 双向跨切（22 条）
  if (m === 'switch') return [...MATRIX_CASES.DS, ...MATRIX_CASES.ZAI, ...MATRIX_CASES.CROSS];
  // all：含 Kimi 在内的全矩阵（30 条）
  if (m === 'all') return [
    ...MATRIX_CASES.DS, ...MATRIX_CASES.ZAI, ...MATRIX_CASES.CROSS,
    ...MATRIX_CASES.KIMI, ...MATRIX_CASES.CROSS_KIMI,
  ];
  if (m === 'ds' || m === 'deepseek') return MATRIX_CASES.DS;
  if (m === 'zai' || m === 'zhipu') return MATRIX_CASES.ZAI;
  if (m === 'kimi' || m === 'moonshot') return [...MATRIX_CASES.KIMI, ...MATRIX_CASES.CROSS_KIMI];
  if (m === 'cross') return MATRIX_CASES.CROSS;
  throw new Error(`unknown matrix '${matrixType}'：支持 switch / all / ds / zai / kimi / cross`);
}


/**
 * 启动 capture server 子进程，监听 stdout 等 CAPTURE_SERVER_READY 行；
 * 端口冲突或启动失败时换端口重试，最多 5 次。
 */
async function startCaptureServer(ctx) {
  const captureDir = path.join(ctx.dirs.root, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const captureScript = path.resolve(__dirname, 'upstream-capture-server.js');

  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = CAPTURE_PORT_RANGE[0] + Math.floor(Math.random() * (CAPTURE_PORT_RANGE[1] - CAPTURE_PORT_RANGE[0]));
    const env = {
      ...baseEnv(ctx.dirs.root),
      CLIENT_E2E_CAPTURE_PORT: String(port),
      CLIENT_E2E_CAPTURE_DIR: captureDir,
    };
    const child = spawn(process.execPath, [captureScript], {
      env, detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    let actualPort = 0;
    child.stdout.on('data', d => {
      stdout += d.toString();
      const m = stdout.match(/CAPTURE_SERVER_READY port=(\d+)/);
      if (m && !ready) { ready = true; actualPort = Number(m[1]); }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const started = Date.now();
    while (Date.now() - started < 5000 && !ready && !child.killed) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (ready) {
      return { port: actualPort, child, dir: captureDir, jsonl: path.join(captureDir, 'requests.jsonl') };
    }
    lastError = stderr || stdout || `capture server timeout on port ${port}`;
    try { child.kill(); } catch {}
  }
  throw new Error(`capture-server-port-exhaust: ${lastError}`);
}

async function stopCaptureServer(server) {
  if (!server?.port) return;
  await requestJson(server.port, '/__stop', 'POST').catch(() => {});
  await new Promise(r => setTimeout(r, 200));
  try { server.child?.kill(); } catch {}
}

async function captureSetStep(server, stepName) {
  return new Promise(resolve => {
    const body = JSON.stringify({ name: stepName });
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: '/__step', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

/**
 * 构建 multi-stanza gateway config：所有 provider 都写进去，每个 provider 的 baseUrl /
 * anthropicBaseUrl 都指向 capture server。activeProvider + thinking + effort 跟随当前 step。
 */
function writeMatrixGatewayConfig(ctx, step, apiKeyMap, captureUrl) {
  const allProviders = providerRegistry.listProviders();
  const providersConfig = {};
  for (const p of allProviders) {
    const providerConfig = p.normalizeConfig({
      apiKey: apiKeyMap[p.id] || 'dummy-matrix-key',
      // 当前 step 的 provider 用其指定 model，其余 provider 用默认 model
      model: p.id === step.providerId ? step.model : p.models?.[0]?.id,
      baseUrl: captureUrl,
      anthropicBaseUrl: captureUrl,
    });
    providersConfig[p.id] = providerConfig;
  }

  fs.mkdirSync(ctx.dirs.gatewayConfig, { recursive: true });
  proxyBundle.deployProxyBundle(ctx.dirs.gatewayConfig);
  const configPath = path.join(ctx.dirs.gatewayConfig, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    activeProvider: step.providerId,
    thinking: step.thinking,
    effort: step.effort === '-' ? 'high' : step.effort,
    providers: providersConfig,
  }, null, 2));
  try { fs.chmodSync(configPath, 0o600); } catch {}
}

/**
 * 启动 matrix gateway：跟 startGateway 类似，但用 step 而不是 model，且五字段 health 校验
 */
async function startMatrixGateway(ctx, step, apiKeyMap, captureServer) {
  const captureUrl = `http://127.0.0.1:${captureServer.port}`;
  writeMatrixGatewayConfig(ctx, step, apiKeyMap, captureUrl);
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
    const child = spawn(process.execPath, [proxyScript], {
      env, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.unref();
    const started = Date.now();
    // 用 step.provider 构造一个临时 ctx-like 对象给 healthMatches 用
    const matchCtx = {
      options: {
        providerId: step.providerId,
        provider: step.provider,
        thinking: step.thinking,
        effort: step.effort === '-' ? null : step.effort,
      },
    };
    while (Date.now() - started < 15000) {
      const health = await requestJson(port, '/__health');
      if (healthMatches(health.body, matchCtx, step.model)) {
        return { port, child, health: health.body };
      }
      await new Promise(r => setTimeout(r, 300));
    }
    lastError = stderr || `matrix-gateway health timeout port ${port} step=${step.raw}`;
    try { child.kill(); } catch {}
  }
  throw new Error(lastError);
}

/**
 * 跑一个最小 Claude 请求（仅触发 gateway 转发到 capture server）
 * capture server 返回完整 SSE，Claude 接到 "ok" 后立即退出
 */
async function probeClaudeForStep(ctx, gateway, step, permissionMode) {
  const ws = prepareWorkspace(ctx, `matrix-${step.index}`, 'claude-probe');
  const prompt = `Reply exactly: PROBE_STEP_${step.index}_OK`;
  const args = claudeArgs(ctx, step.model, prompt, permissionMode, false);
  const env = claudeEnv(ctx, gateway.port);
  return runCommand(ctx.options.claudeBin, args, { cwd: ws.dir, env, timeoutMs: 60000 });
}

/**
 * 跑一个最小 Codex 请求（触发 gateway 把 Responses 翻译成 Chat Completions 发到 capture server）
 */
async function probeCodexForStep(ctx, gateway, step) {
  const ws = prepareWorkspace(ctx, `matrix-${step.index}`, 'codex-probe');
  await initGit(ws.dir);
  const outputFile = path.join(ctx.dirs.logs, `codex-probe-${step.index}.txt`);
  const prompt = `Reply exactly: CODEX_PROBE_STEP_${step.index}_OK`;
  const args = codexArgs(ctx, gateway, step.model, ws.dir, outputFile, prompt, false);
  const env = { ...baseEnv(ctx.dirs.codexHome), CODEX_HOME: ctx.dirs.codexHome };
  return runCommand(ctx.options.codexBin, args, { cwd: ws.dir, env, timeoutMs: 60000 });
}

/**
 * PRD-007 SEQUENCE 矩阵主流程
 *
 * @param {object} ctx - runner context
 * @param {object} apiKeyMap - { providerId: apiKey } 当前 active provider 有真 key，其他用 dummy
 * @param {object} preflightInfo
 * @param {Function} redact
 * @param {Array<{id, desc, seq, probe, stateLeak}>} matrixCases - 若提供则跑完整矩阵；否则用 ctx.options.sequence 单条
 */
async function runSequenceMatrix(ctx, apiKeyMap, preflightInfo, redact, matrixCases) {
  console.log(`[matrix] 启动 capture server...`);
  const captureServer = await startCaptureServer(ctx);
  console.log(`[matrix] capture server ready on :${captureServer.port}, dir=${captureServer.dir}`);
  ctx.captureServer = { port: captureServer.port, dir: captureServer.dir, jsonl: captureServer.jsonl };

  // 把 case 转成 { caseId, probe, stateLeak, steps[] } 数组，runner 内部逐 case 跑
  const caseList = matrixCases && matrixCases.length
    ? matrixCases.map(c => ({ ...c, steps: parseSequence(c.seq) }))
    : [{ id: 'CUSTOM', desc: 'CLIENT_E2E_SEQUENCE', seq: ctx.options.sequence, probe: 'claude', steps: parseSequence(ctx.options.sequence) }];

  let gateway = null;
  try {
    for (const c of caseList) {
      console.log(`[matrix] === ${c.id} | ${c.desc} (probe=${c.probe || 'claude'}${c.stateLeak ? ' / state-leak' : ''}) ===`);

      let previousStep = null;
      for (const step of c.steps) {
        const stepName = `${c.id}.step-${step.index}-${step.raw.replace(/[^a-z0-9.-]+/gi, '_')}`;
        console.log(`[matrix] ▶ ${stepName} (${step.providerId}:${step.model}:${step.thinking}:${step.effort})`);

        await captureSetStep(captureServer, stepName);

        if (gateway) await stopGateway(gateway);
        gateway = await startMatrixGateway(ctx, step, apiKeyMap, captureServer);

        // 决定跑哪些 probe
        const probes = [];
        if (c.probe === 'claude' || c.probe === 'both' || !c.probe) probes.push('claude');
        if (c.probe === 'codex' || c.probe === 'both') probes.push('codex');

        const probeResults = [];
        for (const probe of probes) {
          let result;
          if (probe === 'claude') {
            result = await probeClaudeForStep(ctx, gateway, step, preflightInfo.claudePermissionMode);
          } else {
            result = await probeCodexForStep(ctx, gateway, step);
          }
          probeResults.push({ probe, code: result.code, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr });
        }

        const probeOk = probeResults.every(r => r.code === 0);

        // 断言时按 case 推断 hasReasoningContent / hasToolCall
        // codex probe 不带 tool call，但 capture server mock 的 SSE 会让 gateway 走 chat path，
        // 这一步只验"该发的发了 / 不该发的不发"，不验证 tool_stream（PRD §2 US-40 说 capture
        // 永远返回相同响应，不模拟错误）。要测 tool_stream 注入要靠真实 codex-tool case（X-9）。
        const runConfig = {
          thinking: step.thinking,
          effort: step.effort,
          hasReasoningContent: false,
          hasToolCall: false,
        };
        const assertResult = capabilityAsserts.assertCapture(captureServer.jsonl, stepName, step.provider, runConfig);

        // PRD-007 US-48 state leak 真探针：c.stateLeak=true 时，对当前 step 的首请求
        // 额外断言 from-provider 专属字段不残留。违反时 rule='state-leak'（区别于普通 mustNotHave）。
        // 仅在 step.index >= 2 时启用（首个 step 没有 from）；跨 provider 才有 leak 意义。
        let stateLeakResult = { passed: true, firstEntries: 0, violations: [] };
        if (c.stateLeak && previousStep && previousStep.providerId !== step.providerId) {
          stateLeakResult = capabilityAsserts.assertStateLeak(captureServer.jsonl, stepName, previousStep.provider);
        }

        const allViolations = [...assertResult.violations, ...stateLeakResult.violations];
        const allPassed = assertResult.passed && stateLeakResult.passed;

        const stepCase = {
          name: stepName,
          caseId: c.id,
          caseDesc: c.desc,
          model: step.model,
          provider: step.providerId,
          probe: probes.join('+'),
          stateLeak: !!c.stateLeak,
          stateLeakProbeRun: c.stateLeak && previousStep && previousStep.providerId !== step.providerId,
          status: probeOk && allPassed ? 'PASS' : 'FAIL',
          durationMs: probeResults.reduce((s, r) => s + (r.durationMs || 0), 0),
          captureEntries: assertResult.entries,
          violations: allViolations,
          probeResults: probeResults.map(r => ({ probe: r.probe, code: r.code, durationMs: r.durationMs, stdout: redact(tail(r.stdout, 200)), stderr: redact(tail(r.stderr, 200)) })),
          errorType: probeOk
            ? (allPassed ? '' : (stateLeakResult.violations.length ? 'state-leak' : 'capability-violations'))
            : 'probe-failed',
        };
        ctx.cases.push(stepCase);
        const vSummary = allViolations.length
          ? allViolations.slice(0, 3).map(v => `${v.rule}:${v.field}`).join(',')
          : '';
        const leakTag = stepCase.stateLeakProbeRun ? ' state-leak-probe' : '';
        console.log(`[matrix]   ${stepCase.status}  probes=${probes.join('+')} capture-entries=${assertResult.entries} violations=${allViolations.length}${leakTag}${vSummary ? ' [' + vSummary + ']' : ''}`);

        previousStep = step;
      }
    }
  } finally {
    if (gateway) await stopGateway(gateway);
    await stopCaptureServer(captureServer);
  }
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
    CLAUDE_CONFIG_DIR: ctx.dirs.claudeHome,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'client-e2e-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
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
  if (useBash) args.push('--tools=Bash');
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
  // 长链路用 Node 内置 http + assert 跑测试，不依赖 bash/curl，跨平台一致。
  const prompt = [
    '写一个 Node.js HTTP 文件管理服务，只使用 Node 内置模块。',
    '1. 创建 server.js，支持 GET /、GET /files、GET /files/:name、POST /files/:name、DELETE /files/:name。',
    '2. 文件存到 ./data。',
    '3. 创建 test.js（不是 test.sh），只用 Node 内置 http 和 assert 模块跑 7 个断言，最后用 console.log 输出一行：ALL 7 TESTS PASS。',
    '4. 实际运行 `node test.js`，修到测试通过。',
  ].join('\n');
  const start = logSize(ctx);
  const env = { ...baseEnv(ctx.dirs.codexHome), CODEX_HOME: ctx.dirs.codexHome };
  const result = await runCommand(ctx.options.codexBin, codexArgs(ctx, gateway, model, ws.dir, outputFile, prompt, true), {
    cwd: ws.dir,
    env,
    timeoutMs: ctx.options.longTimeoutMs,
  });
  // 二次跑测试：runner 自己执行一次，确认模型不是只在最终消息里 echo "ALL 7 TESTS PASS" 字符串。
  const verify = fs.existsSync(path.join(ws.dir, 'test.js'))
    ? await runCommand(process.execPath, ['test.js'], { cwd: ws.dir, timeoutMs: 120000 })
    : { code: 1, stdout: '', stderr: 'missing test.js', durationMs: 0 };
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
  const blockingChanges = blockingConfigChanges(ctx);
  const status = failed.length || blockingChanges.length || ctx.secretScan.length || cleanupFailed ? 'FAIL' : 'PASS';
  return { status, passed: passed.length, failed: failed.length, skipped: skipped.length, blockingConfigChanges: blockingChanges };
}

function blockingConfigChanges(ctx) {
  const hasClaude = ctx.options.targets.some(t => t.startsWith('claude'));
  const hasCodex = ctx.options.targets.some(t => t.startsWith('codex'));
  return ctx.configChanges.filter(item => {
    if (item.startsWith('~/.claude') || item === '~/.claude.json') return hasClaude;
    if (item.startsWith('~/.codex')) return hasCodex;
    return true;
  });
}

function markdownReport(ctx) {
  const summary = reportSummary(ctx);
  const isMatrix = !!ctx.matrixMode;
  const title = isMatrix ? `Client E2E Switching Matrix Report (PRD-007)` : 'Client E2E Report';
  const lines = [
    `# ${title}`,
    '',
    `- Status: ${summary.status}`,
    `- Run ID: ${ctx.runId}`,
    `- Started: ${ctx.startedAt}`,
    `- Mode: ${isMatrix ? `matrix=${ctx.matrixMode}` : 'happy-path'}`,
    `- Provider: ${ctx.options.providerId}`,
    `- Models: ${ctx.options.models.join(', ')}`,
    `- Targets: ${ctx.options.targets.join(', ') || '(none)'}`,
    `- Claude Code: ${ctx.toolVersions.claude || '(not required)'}`,
    `- Codex CLI: ${ctx.toolVersions.codex || '(not required)'}`,
    `- Temp root: ${ctx.options.keepTmp ? ctx.dirs.root : '(removed)'}`,
    '',
  ];

  if (isMatrix) {
    // 按 case 分组聚合
    const byCase = new Map();
    for (const item of ctx.cases) {
      const key = item.caseId || item.name;
      if (!byCase.has(key)) byCase.set(key, { caseId: key, desc: item.caseDesc || '', stateLeak: item.stateLeak, steps: [] });
      byCase.get(key).steps.push(item);
    }
    lines.push('| Case | Desc | Steps | PASS / FAIL | Violations |');
    lines.push('|------|------|-------|-------------|------------|');
    for (const c of byCase.values()) {
      const pass = c.steps.filter(s => s.status === 'PASS').length;
      const fail = c.steps.filter(s => s.status === 'FAIL').length;
      const totalViolations = c.steps.reduce((s, x) => s + (x.violations?.length || 0), 0);
      const tag = c.stateLeak ? ' 🛰️' : '';
      lines.push(`| ${c.caseId}${tag} | ${c.desc} | ${c.steps.length} | ${pass} / ${fail} | ${totalViolations} |`);
    }
    lines.push('', '## Step Detail（每步独立 capture 断言）', '');
    lines.push('| Case | Step | Provider:Model:Thinking:Effort | Probe | Status | Captures | Violations |');
    lines.push('|------|------|---------------------------------|-------|--------|----------|------------|');
    for (const item of ctx.cases) {
      const vSummary = (item.violations || []).slice(0, 3).map(v => `${v.rule}:${v.field}`).join('<br>') || '-';
      lines.push(`| ${item.caseId || ''} | ${item.name.split('.').slice(1).join('.') || item.name} | ${item.provider}:${item.model}:${ctx.matrixMode ? '' : ''} | ${item.probe || ''} | ${item.status} | ${item.captureEntries || 0} | ${vSummary} |`);
    }
    if (ctx.cases.some(c => (c.violations || []).length)) {
      lines.push('', '## Violations 详情', '');
      for (const c of ctx.cases) {
        if (!(c.violations || []).length) continue;
        lines.push(`### ${c.name}`);
        for (const v of c.violations) {
          lines.push(`- **${v.rule}** \`${v.field}\` — ${v.reason}${v.expected !== undefined ? ` (expected: \`${JSON.stringify(v.expected)}\`)` : ''}${v.actual !== undefined ? ` (actual: \`${JSON.stringify(v.actual)}\`)` : ''}`);
        }
      }
    }
  } else {
    lines.push('| Model | Case | Status | Duration | Error |');
    lines.push('|-------|------|--------|----------|-------|');
    for (const item of ctx.cases) {
      lines.push(`| ${item.model} | ${item.name} | ${item.status} | ${item.durationMs || 0}ms | ${item.errorType || item.reason || ''} |`);
    }
  }

  lines.push('', '## Safety Checks', '');
  lines.push(`- User config changes: ${ctx.configChanges.length ? ctx.configChanges.join(', ') : 'none'}`);
  lines.push(`- Blocking config changes: ${summary.blockingConfigChanges.length ? summary.blockingConfigChanges.join(', ') : 'none'}`);
  lines.push(`- Secret scan hits: ${ctx.secretScan.length ? ctx.secretScan.join(', ') : 'none'}`);
  lines.push(`- Cleanup: ${ctx.cleanup}`);
  return lines.join('\n') + '\n';
}

function scanForSecret(root, secret) {
  if (!secret || secret.length < 12) return [];
  const hits = [];
  const skip = new Set(['.git', 'node_modules']);
  // .env / .env.* 是 .gitignore 的有意本地密钥库（永不进 git）——
  // 与 ~/.claude.json 同理，标它"泄漏"是误报。仍照常扫报告/tracked 文件。
  const isGitignoredEnv = name => name === '.env' || name.startsWith('.env.');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      if (entry.isFile() && isGitignoredEnv(entry.name)) continue;
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
  const json = redact(JSON.stringify({ ...ctx, summary: reportSummary(ctx) }, null, 2));
  const md = redact(markdownReport(ctx));

  // 1) 默认 latest 报告落到项目目录，不会随 tmp 一起被删——满足 PRD 1.5"自动生成报告"。
  //    PRD-007: matrix 模式走 V0.6 路径，跟 PRD-006 happy path 互不污染
  const isMatrix = !!ctx.matrixMode;
  const reportDir = isMatrix ? MATRIX_REPORT_DIR : DEFAULT_REPORT_DIR;
  const basename = isMatrix ? MATRIX_REPORT_BASENAME : DEFAULT_REPORT_BASENAME;
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${basename}.md`), md);
    fs.writeFileSync(path.join(reportDir, `${basename}.json`), json);
  } catch (err) {
    console.error(`[client-e2e] 默认报告写入失败: ${err.message}`);
  }

  // 2) 临时目录里留一份（keepTmp=1 时调试用；如果 cleanup 已经把 tmp 删了就跳过）
  try {
    if (ctx.dirs?.root && fs.existsSync(ctx.dirs.root)) {
      fs.writeFileSync(path.join(ctx.dirs.root, 'report.json'), json);
      fs.writeFileSync(path.join(ctx.dirs.root, 'report.md'), md);
    }
  } catch {}

  // 3) 用户通过 CLIENT_E2E_REPORT 显式指定的额外路径（叠加，不替换默认）
  if (ctx.options.reportPath) {
    try {
      const target = path.resolve(ctx.options.reportPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, md);
    } catch (err) {
      console.error(`[client-e2e] CLIENT_E2E_REPORT 写入失败: ${err.message}`);
    }
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
    // PRD-007 SEQUENCE / MATRIX 切换矩阵入口
    if (options.matrix || options.sequence) {
      const apiKeyMap = { [options.providerId]: apiKey };
      const matrixCases = options.matrix ? expandMatrix(options.matrix) : null;
      ctx.matrixMode = options.matrix || 'sequence';
      await runSequenceMatrix(ctx, apiKeyMap, preflightInfo, redact, matrixCases);
    } else {
      for (const model of options.models) {
        await runModel(ctx, model, apiKey, preflightInfo, redact);
      }
    }
    redactGatewayConfig(ctx);
    ctx.configChanges = diffSnapshots(before, snapshotUserConfigs());
    ctx.secretScan = [
      ...scanForSecret(process.cwd(), apiKey).map(p => `project:${p}`),
      ...scanForSecret(ctx.dirs.root, apiKey).map(p => `tmp:${p}`),
    ];
    // 顺序：先 cleanup（设 ctx.cleanup 值 + 真删 tmp），再 writeReports。
    // 这样报告里的 cleanup 字段和 reportSummary 计算 status 时拿到的是最终值。
    if (options.keepTmp) {
      ctx.cleanup = 'kept';
    } else {
      try {
        fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
        ctx.cleanup = 'ok';
      } catch (err) {
        ctx.cleanup = `failed: ${err.message}`;
      }
    }
    // writeReports：默认 latest 写到项目目录；tmp 内部报告如果 tmp 已删则跳过。
    writeReports(ctx, redact);
    process.exit(reportSummary(ctx).status === 'PASS' ? 0 : 1);
  } catch (err) {
    ctx.configChanges = diffSnapshots(before, snapshotUserConfigs());
    ctx.cases.push({ name: 'runner', model: '-', status: 'FAIL', errorType: 'runner-error', error: redact(err.message) });
    try { redactGatewayConfig(ctx); } catch {}
    ctx.secretScan = [
      ...scanForSecret(process.cwd(), apiKey).map(p => `project:${p}`),
      ...(ctx.dirs?.root ? scanForSecret(ctx.dirs.root, apiKey).map(p => `tmp:${p}`) : []),
    ];
    if (options.keepTmp) {
      ctx.cleanup = 'kept';
    } else if (ctx.dirs?.root) {
      try {
        fs.rmSync(ctx.dirs.root, { recursive: true, force: true });
        ctx.cleanup = 'ok';
      } catch (err) {
        ctx.cleanup = `failed: ${err.message}`;
      }
    }
    writeReports(ctx, redact);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
