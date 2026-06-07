#!/usr/bin/env node
/**
 * 客户端 E2E / capture runner
 *
 * 负责：
 * - 使用隔离 gateway、Claude/Codex home 和 workspace 跑真实 CLI
 * - 使用 capture server 验证 model/thinking/effort 字段矩阵
 * - 输出脱敏报告，并防止用户真实配置被污染
 *
 * @module scripts/client-e2e
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getProviderProfile } = require('./certification/provider-profiles');
const { makeTempRoot, randomPort, removeIfExists, requestJson, runCommand } = require('./certification/runner-utils');
const { redactText, scanForSecrets } = require('./certification/report-writer');
const { startCaptureServer } = require('./upstream-capture-server');

const DEFAULT_REPORT_DIR = path.join(process.cwd(), '自动化测试', 'V1.5.0');
// 2 = 高效 agent 的合理最小轮数（一个 heredoc 写完 todo.js+test.js+跑测 → 看结果后确认，本就 ≥2 轮，
// 且 LONG_PROMPT 明确要求高效「优先一次 heredoc 写完/≤10 次」）。真实性靠 blackbox 独立校验+静态检查兜底，不靠轮数。
const LONG_TASK_MIN_TOOL_ROUNDS = 2;
const LONG_TASK_MAX_TOOL_ROUNDS = 10;
const LONG_PROMPT = [
  '在当前目录用 Node.js 完成一个命令行待办工具，下面要求全部做完：',
  '1. 不要探索环境，优先用一次 Bash heredoc 写完 todo.js 和 test.js，再运行 node test.js；总工具调用尽量控制在 10 次以内。',
  '2. todo.js 必须是可执行 CLI，支持 add/list/done 三个子命令，数据写到当前目录 todo.json。',
  '3. list 输出必须包含序号、任务文本、未完成标记和已完成标记，方便黑盒脚本验证。',
  '4. test.js 只用 Node 内置 assert，覆盖 add 两条、list 顺序、done 第 1 条，同时读取 todo.js 和 todo.json。',
  '5. 若测试失败，只做必要修改并重试；直到最后一行精确打印：ALL TESTS PASS。',
  '6. 一旦 node test.js 通过，立即停止工具调用，最终回复只输出：ALL TESTS PASS。不要继续检查、优化或解释。',
].join('\n');

function tail(text, max = 2500) {
  const s = String(text || '');
  return s.length > max ? s.slice(-max) : s;
}

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function expandHome(file) {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

function hashPath(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return { exists: true, type: 'dir', sha256: 'dir' };
    return { exists: true, type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  } catch {
    return { exists: false };
  }
}

function snapshotUserConfigs() {
  const labels = [
    '~/.claude/settings.json',
    '~/.claude/settings.json.deepseek-backup',
    '~/.codex/config.toml',
    '~/.codex/config.toml.deepseek-backup',
    '~/.codex/auth.json',
    '~/.deepseek-claude/config.json',
    '~/.deepseek-claude/proxy.js',
  ];
  return Object.fromEntries(labels.map(label => [label, hashPath(expandHome(label))]));
}

function diffSnapshots(before, after) {
  return Object.keys(before).filter(key => {
    const b = before[key] || {};
    const a = after[key] || {};
    return b.exists !== a.exists || b.type !== a.type || b.sha256 !== a.sha256;
  });
}

function snapshotWorkspace(workspaceDir) {
  return fs.readdirSync(workspaceDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const data = fs.readFileSync(path.join(workspaceDir, entry.name));
      return {
        file: entry.name,
        bytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        text: /\.(?:js|json|txt)$/i.test(entry.name) ? data.toString('utf8').slice(0, 20000) : undefined,
      };
    });
}

function baseEnv(homeDir) {
  const env = { ...process.env, HOME: homeDir, NO_COLOR: '1' };
  if (process.platform === 'win32') {
    env.USERPROFILE = homeDir;
    env.APPDATA = path.join(homeDir, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(homeDir, 'AppData', 'Local');
    env.TEMP = env.TMP = os.tmpdir();
  }
  return env;
}

function parseSequence(input) {
  const raw = input || process.env.CLIENT_E2E_SEQUENCE || '';
  if (!raw) return [];
  return raw.split(/\s*->\s*/).filter(Boolean).map(step => {
    const [target, model, thinking, effort] = step.split(':');
    return {
      target: target === 'ds' ? 'codex' : target,
      model: model === 'flash' ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
      thinking: thinking === 'off' ? 'disabled' : 'enabled',
      effort: effort && effort !== '-' ? effort : 'max',
      raw: step,
    };
  });
}

function trueTargets(input) {
  const raw = input || process.env.CLIENT_E2E_TARGETS || 'claude-text,claude-tool,codex-tool';
  return raw.split(',').map(x => x.trim()).filter(Boolean);
}

function selectedModel() {
  return process.env.CLIENT_E2E_MODEL || 'deepseek-v4-pro';
}

function selectedThinking() {
  const raw = process.env.CLIENT_E2E_THINKING || 'enabled';
  return raw === 'off' || raw === 'disabled' ? 'disabled' : 'enabled';
}

function selectedEffort() {
  const raw = process.env.CLIENT_E2E_EFFORT || 'max';
  return raw === '-' ? 'max' : raw;
}

async function linuxClientUser() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.CLIENT_E2E_NO_PRIVDROP === '1') return null;
  const users = [
    process.env.CLIENT_E2E_RUN_AS_USER,
    'yunshu',
    'ubuntu',
    'hermes',
    'webapp',
  ].filter(Boolean);
  for (const user of [...new Set(users)]) {
    const result = await runCommand('id', ['-u', user], { timeoutMs: 5000 });
    const uid = Number(String(result.stdout || '').trim());
    if (result.status === 0 && uid > 0) return user;
  }
  return null;
}

async function runTrueKeyClientAsUser(provider, options, context) {
  const reportDir = options.evidenceDir || DEFAULT_REPORT_DIR;
  fs.mkdirSync(reportDir, { recursive: true });
  // Linux root 只能用 Claude Code acceptEdits，长任务会出现无效循环；客户端认证降权到普通用户更接近真实开发者环境。
  try { fs.chmodSync(reportDir, 0o777); } catch {}
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const jsonPath = path.join(reportDir, `CLIENT_E2E_REPORT_${suffix}.json`);
  const mdPath = path.join(reportDir, `CLIENT_E2E_REPORT_${suffix}.md`);
  const hasLong = context.targets.some(target => target.endsWith('-long'));
  const timeoutMs = context.targets.length * (hasLong ? context.longTimeoutMs : context.shortTimeoutMs) + 120000;
  const env = {
    ...process.env,
    [provider.apiKeyEnv]: context.apiKey,
    CLIENT_E2E_NO_PRIVDROP: '1',
    CLIENT_E2E_PROVIDER: provider.id,
    CLIENT_E2E_TARGETS: context.targets.join(','),
    CLIENT_E2E_MODEL: context.model,
    CLIENT_E2E_THINKING: context.thinking,
    CLIENT_E2E_EFFORT: context.effort,
    CLIENT_E2E_REPORT_JSON: jsonPath,
    CLIENT_E2E_REPORT: mdPath,
  };
  const command = await runCommand('runuser', ['-u', context.user, '--', process.execPath, path.join(__dirname, 'client-e2e.js')], {
    env,
    timeoutMs,
  });
  if (fs.existsSync(jsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    parsed.executedAsUser = context.user;
    parsed.privilegeDrop = { fromRoot: true, user: context.user, commandStatus: command.status };
    return parsed;
  }
  return {
    providerId: provider.id,
    mode: 'true-key',
    status: 'FAIL',
    passed: false,
    failureClass: 'client',
    message: `client E2E as ${context.user} did not write a report; status=${command.status}`,
    stdout: redactText(tail(command.stdout), [context.apiKey]),
    stderr: redactText(tail(command.stderr), [context.apiKey]),
    positiveAssertions: 0,
    cases: [],
  };
}

async function startProxy({ tmpRoot, port, config, capturePort, logPath }) {
  const configDir = path.join(tmpRoot, '.deepseek-claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'proxy'), configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  const env = {
    ...process.env,
    DEEPSEEK_CLAUDE_CONFIG_DIR: configDir,
    DEEPSEEK_CLAUDE_PROXY_PORT: String(port),
    DEEPSEEK_CLAUDE_LOG_PATH: logPath,
  };
  if (capturePort) {
    Object.assign(env, {
      DEEPSEEK_CLAUDE_TARGET_PROTOCOL: 'http:',
      DEEPSEEK_CLAUDE_TARGET_HOST: '127.0.0.1',
      DEEPSEEK_CLAUDE_TARGET_PORT: String(capturePort),
      DEEPSEEK_CLAUDE_TARGET_PREFIX: '',
      DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX: '',
    });
  }
  const child = spawn(process.execPath, [path.join(configDir, 'proxy.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const health = await requestJson({ port, requestPath: '/__health', method: 'GET', timeoutMs: 1000 });
      if (health.json?.service === 'deepseek-claude-proxy') return { child, health: health.json, configDir };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(stderr.trim() || 'proxy start timeout');
}

async function stopProxy(proxy, port) {
  if (!proxy) return;
  try { await requestJson({ port, requestPath: '/__stop', method: 'POST', timeoutMs: 1000 }); } catch {}
  if (!proxy.child.killed) proxy.child.kill();
}

async function runCaptureStep(step, config) {
  const tmpRoot = makeTempRoot('deepseek-client-e2e-');
  const port = randomPort();
  const logPath = path.join(tmpRoot, 'gateway.log');
  const capture = await startCaptureServer({ outputFile: path.join(tmpRoot, 'requests.jsonl') });
  let proxy = null;
  try {
    proxy = await startProxy({ tmpRoot, port, capturePort: capture.port, config, logPath });
    if (proxy.health.model !== config.model || proxy.health.thinking !== config.thinking) {
      throw new Error(`health mismatch for ${step.raw}`);
    }
    const body = step.target === 'claude'
      ? { model: 'ignored', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with CAPTURE_OK' }] }
      : {
        model: 'ignored',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with CAPTURE_OK' }] }],
        stream: false,
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
      };
    await requestJson({
      port,
      requestPath: step.target === 'claude' ? '/v1/messages' : '/v1/responses',
      headers: step.target === 'claude' ? { 'anthropic-version': '2023-06-01' } : {},
      body,
    });
    const requests = fs.readFileSync(capture.outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return { step: step.raw, target: step.target, health: proxy.health, requests, positiveAssertions: 3 + requests.length, status: 'PASS' };
  } finally {
    if (proxy) await stopProxy(proxy, port);
    await new Promise(resolve => capture.server.close(resolve));
    removeIfExists(tmpRoot);
  }
}

/**
 * 在同一临时配置根目录内依序切换配置并重启 gateway。
 * @param {object[]} steps - 配置切换步骤。
 * @returns {Promise<object[]>} 每一步的首批抓包结果。
 */
async function runCaptureSequence(steps) {
  const tmpRoot = makeTempRoot('deepseek-client-e2e-switch-');
  const port = randomPort();
  const logPath = path.join(tmpRoot, 'gateway.log');
  const capture = await startCaptureServer({ outputFile: path.join(tmpRoot, 'requests.jsonl') });
  const results = [];
  let proxy = null;
  try {
    for (const step of steps) {
      proxy = await startProxy({
        tmpRoot,
        port,
        capturePort: capture.port,
        logPath,
        config: { apiKey: 'sk-capture-placeholder', model: step.model, thinking: step.thinking, effort: step.effort },
      });
      const before = fs.existsSync(capture.outputFile)
        ? fs.readFileSync(capture.outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
        : 0;
      const body = step.target === 'claude'
        ? { model: 'ignored', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with CAPTURE_OK' }] }
        : {
          model: 'ignored',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with CAPTURE_OK' }] }],
          stream: false,
          tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
        };
      await requestJson({
        port,
        requestPath: step.target === 'claude' ? '/v1/messages' : '/v1/responses',
        headers: step.target === 'claude' ? { 'anthropic-version': '2023-06-01' } : {},
        body,
      });
      const allRequests = fs.readFileSync(capture.outputFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      results.push({ step: step.raw, target: step.target, health: proxy.health, requests: allRequests.slice(before), switchedConfigRoot: true, status: 'PASS' });
      await stopProxy(proxy, port);
      proxy = null;
    }
    return results;
  } finally {
    if (proxy) await stopProxy(proxy, port);
    await new Promise(resolve => capture.server.close(resolve));
    removeIfExists(tmpRoot);
  }
}

function assertCaptureStep(stepResult, expected) {
  const first = stepResult.requests[0]?.body || {};
  const checks = [
    first.model === expected.model,
    first.thinking?.type === expected.thinking,
  ];
  if (expected.target === 'claude') {
    checks.push(expected.thinking === 'enabled' ? first.output_config?.effort === expected.effort : first.output_config === undefined);
  } else {
    checks.push(expected.thinking === 'enabled' ? first.reasoning_effort === expected.effort : first.reasoning_effort === undefined);
  }
  if (!checks.every(Boolean)) throw new Error(`capture assertion failed for ${expected.raw}: ${JSON.stringify(first)}`);
  return checks.length;
}

async function runCaptureMatrix(options = {}) {
  const steps = parseSequence(options.sequence).length ? parseSequence(options.sequence) : parseSequence('codex:pro:on:max');
  const provider = getProviderProfile(options.providerId || process.env.CLIENT_E2E_PROVIDER || 'deepseek');
  if (!provider) throw new Error('unknown provider');
  const results = await runCaptureSequence(steps);
  let positiveAssertions = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const stepResult = results[index];
    positiveAssertions += assertCaptureStep(stepResult, step);
  }
  return { providerId: provider.id, mode: 'capture', status: 'PASS', passed: true, positiveAssertions, steps: results };
}

async function preflight(targets, bins) {
  const errors = [];
  const versions = {};
  const tmp = makeTempRoot('deepseek-client-preflight-');
  try {
    if (targets.some(t => t.startsWith('claude'))) {
      const env = { ...baseEnv(path.join(tmp, 'claude-home')), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-home') };
      const version = await runCommand(bins.claude, ['--version'], { env, timeoutMs: 10000 });
      const help = await runCommand(bins.claude, ['--help'], { env, timeoutMs: 10000 });
      versions.claude = tail(version.stdout || version.stderr, 500).trim();
      if (version.status !== 0 || help.status !== 0) errors.push('Claude Code CLI 不存在或不可执行');
      for (const flag of ['--bare', '--settings', '--no-session-persistence', '--model']) {
        if (!help.stdout.includes(flag) && !help.stderr.includes(flag)) errors.push(`Claude Code 缺少必要参数 ${flag}`);
      }
    }
    if (targets.some(t => t.startsWith('codex'))) {
      const env = { ...baseEnv(path.join(tmp, 'codex-home')), CODEX_HOME: path.join(tmp, 'codex-home') };
      const version = await runCommand(bins.codex, ['--version'], { env, timeoutMs: 10000 });
      const help = await runCommand(bins.codex, ['exec', '--help'], { env, timeoutMs: 10000 });
      versions.codex = tail(version.stdout || version.stderr, 500).trim();
      if (version.status !== 0 || help.status !== 0) errors.push('Codex CLI 不存在或不可执行');
      for (const flag of ['--ignore-user-config', '--ephemeral', '--sandbox', '--cd', '--json']) {
        if (!help.stdout.includes(flag) && !help.stderr.includes(flag)) errors.push(`Codex CLI 缺少必要参数 ${flag}`);
      }
    }
  } finally {
    removeIfExists(tmp);
  }
  return { ok: errors.length === 0, errors, versions };
}

function workspace(ctx, target) {
  const dir = path.join(ctx.tmpRoot, 'workspaces', safeName(target));
  fs.rmSync(dir, { recursive: true, force: true }); // 每次（含重试）全新工作区，避免上次残留（todo.js / 空 proof）污染
  fs.mkdirSync(dir, { recursive: true });
  const packageName = `client-e2e-${safeName(target)}-${ctx.runId}`;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: packageName }, null, 2));
  return { dir, packageName };
}

function logText(ctx, start = 0) {
  try { return fs.readFileSync(ctx.logPath, 'utf8').slice(start); } catch { return ''; }
}

function logSize(ctx) {
  try { return fs.statSync(ctx.logPath).size; } catch { return 0; }
}

function countLogEntries(text, marker) {
  return (String(text).match(new RegExp(marker, 'g')) || []).length;
}

function expectedHealth(ctx) {
  return {
    model: ctx.model,
    thinking: ctx.thinking,
    effort: ctx.thinking === 'disabled' ? null : ctx.effort,
  };
}

function healthMatches(ctx, health) {
  const expected = expectedHealth(ctx);
  return expected.model === health?.model
    && expected.thinking === health?.thinking
    && expected.effort === (health?.effort ?? null);
}

function claudeArgs(ctx, model, prompt, useBash) {
  const permissionMode = process.getuid?.() === 0 ? 'acceptEdits' : 'bypassPermissions';
  const args = [
    '--bare', '-p', '--no-session-persistence', '--model', model,
    '--settings', path.join(ctx.tmpRoot, 'claude-settings.json'),
    '--setting-sources', 'local',
    '--strict-mcp-config',
    '--mcp-config', path.join(ctx.tmpRoot, 'empty-mcp.json'),
    '--output-format', 'text',
    '--permission-mode', permissionMode,
  ];
  if (useBash) args.push('--tools=Bash');
  args.push(prompt);
  return args;
}

function codexArgs(ctx, model, workDir, outputFile, prompt, longMode) {
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--json',
    '--sandbox', process.env.CLIENT_E2E_CODEX_SANDBOX || (longMode ? 'workspace-write' : 'workspace-write'),
    '--cd', workDir,
    '--output-last-message', outputFile,
    '-c', `model=${JSON.stringify(model)}`,
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="gateway_e2e"',
    '-c', 'model_providers.gateway_e2e.name="Gateway E2E"',
    '-c', `model_providers.gateway_e2e.base_url=${JSON.stringify(`http://127.0.0.1:${ctx.port}/v1`)}`,
    '-c', 'model_providers.gateway_e2e.wire_api="responses"',
    '-c', 'model_providers.gateway_e2e.experimental_bearer_token="client-e2e-token"',
    '-c', 'model_providers.gateway_e2e.request_max_retries=0',
    '-c', 'model_providers.gateway_e2e.stream_max_retries=0',
    '-c', 'model_providers.gateway_e2e.stream_idle_timeout_ms=600000',
    prompt,
  ];
}

async function initGit(dir) {
  await runCommand('git', ['init', '-q'], { cwd: dir, timeoutMs: 10000 });
}

function redactFor(ctx, value) {
  return redactText(value, [ctx.apiKey]);
}

function expectedEffort(ctx) {
  if (ctx.thinking === 'disabled') return 'off';
  // 无 effort 档 provider（zai/kimi，thinkingEffort:false）：网关不发 reasoning_effort → 日志记 effort=-
  if (ctx.effortTiers && ctx.effortTiers.length === 0) return '-';
  return ctx.effort;
}

function gatewayFieldsMatch(ctx, log, client) {
  const modelPattern = client === 'claude'
    ? new RegExp(`model=[^\\s|]+->${ctx.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    : new RegExp(`model=${ctx.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return modelPattern.test(log)
    && log.includes(`thinking=${ctx.thinking}`)
    && log.includes(`effort=${ctx.thinking === 'disabled' && client === 'codex' ? '-' : expectedEffort(ctx)}`);
}

async function verifyCommandTask(workspaceDir, marker) {
  const helloPath = path.join(workspaceDir, 'hello.js');
  const testPath = path.join(workspaceDir, 'test.js');
  if (!fs.existsSync(helloPath) || !fs.existsSync(testPath)) {
    return { passed: false, filesExist: false, dependsOnHello: false, status: 1, stdout: '', stderr: 'missing hello.js or test.js' };
  }
  const normal = await runCommand(process.execPath, ['test.js'], { cwd: workspaceDir, timeoutMs: 30000 });
  const hidden = `${helloPath}.certification-hidden`;
  fs.renameSync(helloPath, hidden);
  let withoutHello;
  try {
    withoutHello = await runCommand(process.execPath, ['test.js'], { cwd: workspaceDir, timeoutMs: 30000 });
  } finally {
    fs.renameSync(hidden, helloPath);
  }
  const dependsOnHello = withoutHello.status !== 0 || !withoutHello.stdout.includes(marker);
  return {
    passed: normal.status === 0 && normal.stdout.includes(marker) && dependsOnHello,
    filesExist: true,
    dependsOnHello,
    status: normal.status,
    stdout: tail(normal.stdout),
    stderr: tail(normal.stderr),
  };
}

async function runClaudeTarget(ctx, target) {
  const ws = workspace(ctx, target);
  const isText = target === 'claude-text';
  const isLong = target === 'claude-long';
  const marker = isText ? 'TEXT_OK' : isLong ? 'ALL TESTS PASS' : target === 'claude-command' ? 'CLAUDE COMMAND PASS' : `CLAUDE_TOOL_PASS:${ws.packageName}`;
  const prompt = isText
    ? `Copy the exact text between tags as your entire reply. <answer>${marker}</answer>`
    : isLong
      ? LONG_PROMPT
      : target === 'claude-command'
        ? `Create hello.js and test.js. test.js must use assert, run hello.js, and print exactly ${marker}. Run node test.js before final answer.`
        : 'Use Bash to read ./package.json, extract its name field, write the exact name to bash-proof.txt, then reply exactly as CLAUDE_TOOL_PASS:<the extracted name>.';
  const start = logSize(ctx);
  const env = {
    ...baseEnv(ctx.claudeHome),
    CLAUDE_CONFIG_DIR: ctx.claudeHome,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.port}`,
    ANTHROPIC_API_KEY: 'client-e2e-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  const result = await runCommand(ctx.bins.claude, claudeArgs(ctx, ctx.model, prompt, !isText), { cwd: ws.dir, env, timeoutMs: isLong ? ctx.longTimeoutMs : ctx.shortTimeoutMs });
  const caseLog = logText(ctx, start);
  const gatewayFieldsMatched = gatewayFieldsMatch(ctx, caseLog, 'claude');
  let assertions = Number(result.status === 0) + Number(caseLog.includes('MSG_DONE')) + Number(ctx.gatewayHealthPassed) + Number(gatewayFieldsMatched);
  let extra = {};
  if (target === 'claude-tool') {
    const proofPath = path.join(ws.dir, 'bash-proof.txt');
    const proof = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, 'utf8').trim() : '';
    assertions += Number(proof === ws.packageName);
    extra.proof = proof;
  }
  if (target === 'claude-command') {
    const verify = await verifyCommandTask(ws.dir, marker);
    assertions += Number(verify.passed) + Number(verify.filesExist) + Number(verify.dependsOnHello);
    extra.verify = verify;
  }
  if (isLong) {
    extra.modelSelfTest = fs.existsSync(path.join(ws.dir, 'test.js')) ? await runCommand(process.execPath, ['test.js'], { cwd: ws.dir, timeoutMs: 30000 }) : { status: 1, stdout: '', stderr: 'missing test.js' };
    extra.blackboxRetest = await blackboxRetest(ws.dir);
    extra.staticChecks = staticCheckLongTask(ws.dir);
    extra.toolRounds = countLogEntries(caseLog, 'MSG_DONE');
    extra.requiredFiles = ['todo.js', 'test.js', 'todo.json'].every(file => fs.existsSync(path.join(ws.dir, file)));
    assertions += Number(extra.modelSelfTest.status === 0 && extra.modelSelfTest.stdout.includes('ALL TESTS PASS'));
    assertions += Number(extra.blackboxRetest.status === 0 && extra.blackboxRetest.stdout.includes('ALL TESTS PASS'));
    assertions += Number(Object.values(extra.staticChecks).every(Boolean));
    assertions += Number(extra.requiredFiles);
    assertions += Number(extra.toolRounds >= LONG_TASK_MIN_TOOL_ROUNDS && extra.toolRounds <= LONG_TASK_MAX_TOOL_ROUNDS);
  }
  const outputHit = isLong
    ? result.stdout.includes('ALL TESTS PASS') || extra.blackboxRetest?.stdout?.includes('ALL TESTS PASS')
    : target === 'claude-command'
      ? extra.verify?.stdout?.includes(marker)
      : result.stdout.includes(marker);
  const toolProofOk = target !== 'claude-tool' || extra.proof === ws.packageName;
  const longEvidenceOk = !isLong || (
    extra.modelSelfTest.status === 0
    && extra.blackboxRetest.status === 0
    && extra.requiredFiles
    && extra.toolRounds >= LONG_TASK_MIN_TOOL_ROUNDS
    && extra.toolRounds <= LONG_TASK_MAX_TOOL_ROUNDS
    && Object.values(extra.staticChecks).every(Boolean)
  );
  const commandOk = target !== 'claude-command' || extra.verify?.passed;
  const passed = result.status === 0 && outputHit && toolProofOk && commandOk && ctx.gatewayHealthPassed && gatewayFieldsMatched && longEvidenceOk && !caseLog.includes('MSG_FAILED') && assertions >= (isLong ? 8 : 4);
  return {
    name: target,
    model: ctx.model,
    status: passed ? 'PASS' : 'FAIL',
    evidenceType: 'true-key',
    durationMs: result.durationMs,
    positiveAssertions: assertions,
    marker,
    gatewayHealth: ctx.gatewayHealth,
    gatewayFieldsMatched,
    workspaceFiles: fs.readdirSync(ws.dir).sort(),
    workspaceSnapshot: snapshotWorkspace(ws.dir),
    stdout: redactFor(ctx, tail(result.stdout)),
    stderr: redactFor(ctx, tail(result.stderr)),
    logSummary: redactFor(ctx, tail(caseLog)),
    ...extra,
  };
}

async function runCodexTarget(ctx, target) {
  const ws = workspace(ctx, target);
  await initGit(ws.dir);
  const isLong = target === 'codex-long';
  const marker = isLong ? 'ALL TESTS PASS' : target === 'codex-command' ? 'CODEX COMMAND PASS' : `CODEX_TOOL_PASS:${ws.packageName}`;
  const outputFile = path.join(ctx.tmpRoot, `${safeName(target)}-last.txt`);
  const prompt = isLong
    ? LONG_PROMPT
    : target === 'codex-command'
      ? `Create hello.js and test.js. test.js must use assert, run hello.js, and print exactly ${marker}. Run node test.js before final answer.`
      : 'Use shell to read ./package.json, write its name field to shell-proof.txt, and reply exactly as CODEX_TOOL_PASS:<the extracted name>.';
  const start = logSize(ctx);
  const env = { ...baseEnv(ctx.codexHome), CODEX_HOME: ctx.codexHome };
  const result = await runCommand(ctx.bins.codex, codexArgs(ctx, ctx.model, ws.dir, outputFile, prompt, isLong), { cwd: ws.dir, env, timeoutMs: isLong ? ctx.longTimeoutMs : ctx.shortTimeoutMs });
  const lastMessage = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const caseLog = logText(ctx, start);
  const expectedLogEffort = ctx.thinking === 'disabled' ? 'undefined' : ctx.effort;
  const effortLogOk = caseLog.includes(`effort=${expectedLogEffort}`);
  const gatewayFieldsMatched = gatewayFieldsMatch(ctx, caseLog, 'codex');
  let assertions = Number(result.status === 0) + Number(caseLog.includes('RESPONSES_DONE')) + Number(!caseLog.includes('RESPONSES_FAILED')) + Number(ctx.gatewayHealthPassed) + Number(effortLogOk) + Number(gatewayFieldsMatched);
  let extra = {};
  if (target === 'codex-tool') {
    const proofPath = path.join(ws.dir, 'shell-proof.txt');
    const proof = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, 'utf8').trim() : '';
    assertions += Number(proof === ws.packageName);
    extra.proof = proof;
  }
  if (target === 'codex-command') {
    const verify = await verifyCommandTask(ws.dir, marker);
    assertions += Number(verify.passed) + Number(verify.filesExist) + Number(verify.dependsOnHello);
    extra.verify = verify;
  }
  if (isLong) {
    extra.modelSelfTest = fs.existsSync(path.join(ws.dir, 'test.js')) ? await runCommand(process.execPath, ['test.js'], { cwd: ws.dir, timeoutMs: 30000 }) : { status: 1, stdout: '', stderr: 'missing test.js' };
    extra.blackboxRetest = await blackboxRetest(ws.dir);
    extra.staticChecks = staticCheckLongTask(ws.dir);
    extra.toolRounds = countLogEntries(caseLog, 'RESPONSES_DONE');
    extra.requiredFiles = ['todo.js', 'test.js', 'todo.json'].every(file => fs.existsSync(path.join(ws.dir, file)));
    assertions += Number(extra.modelSelfTest.status === 0 && extra.modelSelfTest.stdout.includes('ALL TESTS PASS'));
    assertions += Number(extra.blackboxRetest.status === 0 && extra.blackboxRetest.stdout.includes('ALL TESTS PASS'));
    assertions += Number(Object.values(extra.staticChecks).every(Boolean));
    assertions += Number(extra.requiredFiles);
    assertions += Number(extra.toolRounds >= LONG_TASK_MIN_TOOL_ROUNDS && extra.toolRounds <= LONG_TASK_MAX_TOOL_ROUNDS);
  }
  const outputHit = isLong
    ? extra.blackboxRetest?.stdout?.includes('ALL TESTS PASS')
    : target === 'codex-command'
      ? extra.verify?.stdout?.includes(marker)
      : lastMessage.includes(marker);
  const toolProofOk = target !== 'codex-tool' || extra.proof === ws.packageName;
  const longEvidenceOk = !isLong || (
    extra.modelSelfTest.status === 0
    && extra.blackboxRetest.status === 0
    && extra.requiredFiles
    && extra.toolRounds >= LONG_TASK_MIN_TOOL_ROUNDS
    && extra.toolRounds <= LONG_TASK_MAX_TOOL_ROUNDS
    && Object.values(extra.staticChecks).every(Boolean)
  );
  const commandOk = target !== 'codex-command' || extra.verify?.passed;
  const passed = result.status === 0 && outputHit && toolProofOk && commandOk && ctx.gatewayHealthPassed && effortLogOk && gatewayFieldsMatched && longEvidenceOk && !caseLog.includes('RESPONSES_FAILED') && assertions >= (isLong ? 11 : 6);
  return {
    name: target,
    model: ctx.model,
    status: passed ? 'PASS' : 'FAIL',
    evidenceType: 'true-key',
    durationMs: result.durationMs,
    positiveAssertions: assertions,
    marker,
    gatewayHealth: ctx.gatewayHealth,
    gatewayEffortLogMatched: effortLogOk,
    gatewayFieldsMatched,
    workspaceFiles: fs.readdirSync(ws.dir).sort(),
    workspaceSnapshot: snapshotWorkspace(ws.dir),
    stdout: redactFor(ctx, tail(result.stdout)),
    stderr: redactFor(ctx, tail(result.stderr)),
    lastMessage: redactFor(ctx, tail(lastMessage)),
    logSummary: redactFor(ctx, tail(caseLog)),
    ...extra,
  };
}

async function blackboxRetest(workspaceDir) {
  const testPath = path.join(workspaceDir, 'certification-blackbox.test.js');
  fs.writeFileSync(testPath, [
    "const assert = require('assert');",
    "const fs = require('fs');",
    "const cp = require('child_process');",
    "function lines(text) { return text.trim().split(/\\r?\\n/).filter(Boolean); }",
    "function hasId(line, id) { return new RegExp(`(^|\\\\D)${id}(\\\\D|$)`).test(line); }",
    "function assertTodoLine(line, id, task, done) {",
    "  assert(line.includes(task), `missing task ${task}: ${line}`);",
    "  assert(hasId(line, id), `missing id ${id}: ${line}`);",
    "  const doneMarker = /\\[x\\]|\\[done\\]|✓|✔|✅/i.test(line);",
    "  const openMarker = /\\[\\s\\]|☐|○/i.test(line);",
    "  assert.strictEqual(doneMarker, done, `done marker mismatch: ${line}`);",
    "  if (!done) assert(openMarker, `missing open marker: ${line}`);",
    "}",
    "try { fs.unlinkSync('todo.json'); } catch {}",
    "cp.execFileSync(process.execPath, ['todo.js', 'add', '写文档']);",
    "cp.execFileSync(process.execPath, ['todo.js', 'add', '修bug']);",
    "let list = lines(cp.execFileSync(process.execPath, ['todo.js', 'list'], {encoding:'utf8'}));",
    "assert.strictEqual(list.length, 2);",
    "assertTodoLine(list[0], 1, '写文档', false);",
    "assertTodoLine(list[1], 2, '修bug', false);",
    "cp.execFileSync(process.execPath, ['todo.js', 'done', '1']);",
    "list = lines(cp.execFileSync(process.execPath, ['todo.js', 'list'], {encoding:'utf8'}));",
    "assert.strictEqual(list.length, 2);",
    "assertTodoLine(list[0], 1, '写文档', true);",
    "assertTodoLine(list[1], 2, '修bug', false);",
    "console.log('ALL TESTS PASS');",
    '',
  ].join('\n'));
  return runCommand(process.execPath, [testPath], { cwd: workspaceDir, timeoutMs: 30000 });
}

function readsNamedFile(source, fileName) {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:readFileSync|require)\\s*\\([^;\\n]{0,160}${escaped}`).test(source)) return true;
  const assignment = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;\\n]{0,160}${escaped}`, 'g');
  return [...source.matchAll(assignment)].some(([, variable]) => (
    new RegExp(`(?:readFileSync|require)\\s*\\(\\s*${variable}\\b`).test(source)
  ));
}

function readsTodoJsonViaExport(testJs, todoJs) {
  if (!/(?:readFileSync|require)\s*\(\s*\w+\.TODO_FILE\b/.test(testJs)) return false;
  return /TODO_FILE[\s\S]{0,160}todo\.json/.test(todoJs)
    && /module\.exports[\s\S]{0,160}TODO_FILE/.test(todoJs);
}

function staticCheckLongTask(workspaceDir) {
  try {
    const testJs = fs.readFileSync(path.join(workspaceDir, 'test.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const todoJs = fs.existsSync(path.join(workspaceDir, 'todo.js'))
      ? fs.readFileSync(path.join(workspaceDir, 'todo.js'), 'utf8')
      : '';
    return {
      usesAssert: /require\(['"]assert['"]\)/.test(testJs),
      readsTodoJs: /(?:execFileSync|spawnSync|execSync)[\s\S]{0,160}todo\.js/.test(testJs)
        || readsNamedFile(testJs, 'todo.js'),
      readsTodoJson: readsNamedFile(testJs, 'todo.json') || readsTodoJsonViaExport(testJs, todoJs),
    };
  } catch {
    return { usesAssert: false, readsTodoJs: false, readsTodoJson: false };
  }
}

function writeClientReport(result, options = {}) {
  const reportDir = options.evidenceDir || DEFAULT_REPORT_DIR;
  fs.mkdirSync(reportDir, { recursive: true });
  const suffix = options.evidenceDir ? `_${safeName(result.runId)}` : '_LATEST';
  const jsonPath = process.env.CLIENT_E2E_REPORT_JSON || path.join(reportDir, `CLIENT_E2E_REPORT${suffix}.json`);
  const mdPath = process.env.CLIENT_E2E_REPORT || path.join(reportDir, `CLIENT_E2E_REPORT${suffix}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const lines = [
    '# Client E2E Report',
    '',
    `- Status: ${result.status}`,
    `- Provider: ${result.providerId}`,
    `- Mode: ${result.mode}`,
    `- Model: ${result.model || '-'}`,
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    '',
    '| Case | Status | Assertions | Duration |',
    '|---|---|---:|---:|',
    ...(result.cases || []).map(c => `| ${c.name} | ${c.status} | ${c.positiveAssertions || 0} | ${c.durationMs || 0}ms |`),
    '',
    `- User config changes: ${(result.configChanges || []).join(', ') || 'none'}`,
    `- Secret scan hits: ${(result.secretScan || []).length}`,
  ];
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);
  return { jsonPath, mdPath };
}

function scanResultForSecret(result, apiKey) {
  const text = JSON.stringify(result);
  return apiKey && apiKey.length >= 12 && text.includes(apiKey.slice(0, 12)) ? ['client-result-json'] : [];
}

// true-key 用例对真模型采样抖动的有界重试：用例仍须真正 PASS（真 CLI + 真模型 + 真断言），仅容忍偶发手滑
// （如模型把 proof 命令写错、漏走一轮）；重试次数与每次结果记入 case（attempts/attemptHistory），证据透明不藏。
// N 默认 3，可用 CLIENT_E2E_MAX_ATTEMPTS 调（设 1 即退回单次、不重试）。
const TRUE_KEY_MAX_ATTEMPTS = Math.max(1, Number(process.env.CLIENT_E2E_MAX_ATTEMPTS || 3));

async function runTargetWithRetry(ctx, target) {
  const runFn = target.startsWith('claude') ? runClaudeTarget : runCodexTarget;
  const attemptHistory = [];
  let result;
  for (let attempt = 1; attempt <= TRUE_KEY_MAX_ATTEMPTS; attempt++) {
    result = await runFn(ctx, target);
    attemptHistory.push({ attempt, status: result.status, durationMs: result.durationMs });
    if (result.status === 'PASS') break;
    if (attempt < TRUE_KEY_MAX_ATTEMPTS) {
      console.error(`[true-key retry] ${target} attempt ${attempt}/${TRUE_KEY_MAX_ATTEMPTS} -> FAIL，重试中…`);
    }
  }
  result.attempts = attemptHistory.length;
  result.attemptHistory = attemptHistory;
  return result;
}

async function runTrueKeyClient(options = {}) {
  const provider = getProviderProfile(options.providerId || process.env.CLIENT_E2E_PROVIDER || 'deepseek');
  if (!provider) throw new Error('unknown provider');
  const apiKey = Object.prototype.hasOwnProperty.call(options, 'apiKey') ? options.apiKey : process.env[provider.apiKeyEnv];
  const targets = trueTargets(options.targets);
  const model = options.model || selectedModel();
  const thinking = options.thinking || selectedThinking();
  const effort = options.effort || selectedEffort();
  if (!apiKey) {
    return { providerId: provider.id, mode: 'true-key', status: 'BLOCKED', passed: false, failureClass: 'provider', message: `${provider.apiKeyEnv} is required`, positiveAssertions: 1, cases: [] };
  }
  const runAsUser = targets.some(target => target.startsWith('claude')) ? await linuxClientUser() : null;
  if (runAsUser) {
    return runTrueKeyClientAsUser(provider, options, {
      apiKey,
      effort,
      longTimeoutMs: Number(process.env.CLIENT_E2E_LONG_TIMEOUT_MS || 900000),
      model,
      shortTimeoutMs: Number(process.env.CLIENT_E2E_SHORT_TIMEOUT_MS || 240000),
      targets,
      thinking,
      user: runAsUser,
    });
  }
  const bins = { claude: process.env.CLIENT_E2E_CLAUDE_BIN || 'claude', codex: process.env.CLIENT_E2E_CODEX_BIN || 'codex' };
  const pf = await preflight(targets, bins);
  if (!pf.ok) {
    return { providerId: provider.id, mode: 'true-key', status: 'BLOCKED', passed: false, failureClass: 'preflight', message: pf.errors.join('; '), versions: pf.versions, positiveAssertions: 1, cases: [] };
  }

  const tmpRoot = makeTempRoot('deepseek-client-e2e-real-');
  const ctx = {
    apiKey,
    bins,
    cases: [],
    claudeHome: path.join(tmpRoot, 'claude-home'),
    codexHome: path.join(tmpRoot, 'codex-home'),
    logPath: path.join(tmpRoot, 'gateway.log'),
    longTimeoutMs: Number(process.env.CLIENT_E2E_LONG_TIMEOUT_MS || 900000),
    shortTimeoutMs: Number(process.env.CLIENT_E2E_SHORT_TIMEOUT_MS || 240000),
    effort,
    effortTiers: provider.thinkingEfforts || [], // 空=无 effort 档（zai/kimi）→ gatewayFieldsMatch 期望 effort=-
    model,
    port: randomPort(),
    runId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    thinking,
    tmpRoot,
  };
  fs.mkdirSync(ctx.claudeHome, { recursive: true });
  fs.mkdirSync(ctx.codexHome, { recursive: true });
  fs.writeFileSync(path.join(ctx.tmpRoot, 'claude-settings.json'), JSON.stringify({}, null, 2));
  fs.writeFileSync(path.join(ctx.tmpRoot, 'empty-mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));

  const before = snapshotUserConfigs();
  let proxy = null;
  try {
    proxy = await startProxy({ tmpRoot, port: ctx.port, logPath: ctx.logPath, config: { activeProvider: provider.id, providers: { [provider.id]: { apiKey, model } }, thinking, effort } });
    ctx.gatewayHealth = proxy.health;
    ctx.gatewayHealthPassed = healthMatches(ctx, proxy.health);
    for (const target of targets) {
      const caseResult = await runTargetWithRetry(ctx, target);
      ctx.cases.push(caseResult);
    }
  } finally {
    if (proxy) await stopProxy(proxy, ctx.port);
  }
  const after = snapshotUserConfigs();
  const result = {
    providerId: provider.id,
    mode: 'true-key',
    runId: ctx.runId,
    effort,
    model,
    thinking,
    status: ctx.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL',
    passed: ctx.cases.every(c => c.status === 'PASS'),
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
    versions: pf.versions,
    cases: ctx.cases,
    gatewayHealth: ctx.gatewayHealth,
    expectedGatewayHealth: expectedHealth(ctx),
    gatewayHealthPassed: ctx.gatewayHealthPassed,
    positiveAssertions: ctx.cases.reduce((sum, c) => sum + (c.positiveAssertions || 0), 0),
    configSnapshots: { before, after },
    configChanges: diffSnapshots(before, after),
    secretScan: [],
  };
  result.secretScan = [
    ...scanResultForSecret(result, apiKey),
    ...scanForSecrets(ctx.logPath, [apiKey]).map(hit => hit.file),
    ...scanForSecrets(path.join(tmpRoot, 'workspaces'), [apiKey]).map(hit => hit.file),
  ];
  if (result.configChanges.length || result.secretScan.length) {
    result.status = 'FAIL';
    result.passed = false;
    result.failureClass = 'cleanup';
  }
  let cleanupError = null;
  if (process.env.CLIENT_E2E_KEEP_TMP !== '1') {
    try { removeIfExists(tmpRoot); } catch (err) { cleanupError = err; }
  } else {
    result.tmpRoot = tmpRoot;
  }
  result.cleanup = {
    tmpRootRemoved: !fs.existsSync(tmpRoot),
    keptForDebug: process.env.CLIENT_E2E_KEEP_TMP === '1',
    error: cleanupError ? cleanupError.message : undefined,
  };
  if ((!result.cleanup.tmpRootRemoved && process.env.CLIENT_E2E_KEEP_TMP !== '1') || cleanupError) {
    result.status = 'FAIL';
    result.passed = false;
    result.failureClass = 'cleanup';
  }
  result.report = writeClientReport(JSON.parse(redactText(JSON.stringify(result), [apiKey])), options);
  return JSON.parse(redactText(JSON.stringify(result), [apiKey]));
}

async function main() {
  const wantsCapture = process.env.CLIENT_E2E_SEQUENCE || process.env.CLIENT_E2E_MODE === 'capture';
  const result = wantsCapture ? await runCaptureMatrix() : await runTrueKeyClient();
  console.log(redactText(JSON.stringify(result, null, 2), [process.env.DEEPSEEK_API_KEY]));
  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(redactText(err.stack || err.message, [process.env.DEEPSEEK_API_KEY]));
    process.exit(1);
  });
}

module.exports = {
  blackboxRetest,
  claudeArgs,
  healthMatches,
  LONG_TASK_MAX_TOOL_ROUNDS,
  LONG_TASK_MIN_TOOL_ROUNDS,
  parseSequence,
  runCaptureMatrix,
  runTrueKeyClient,
  snapshotWorkspace,
  staticCheckLongTask,
  gatewayFieldsMatch,
  trueTargets,
};
