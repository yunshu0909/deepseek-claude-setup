const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-claude-setup-'));
const configDir = path.join(tmp, '.deepseek-claude');
const claudeDir = path.join(tmp, '.claude');
const codexDir = path.join(tmp, '.codex');
const settingsPath = path.join(claudeDir, 'settings.json');
const codexConfigPath = path.join(codexDir, 'config.toml');
const proxyPort = 19000 + Math.floor(Math.random() * 1000);

process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = configDir;
process.env.CLAUDE_SETTINGS_PATH = settingsPath;
process.env.CODEX_CONFIG_PATH = codexConfigPath;
process.env.DEEPSEEK_CLAUDE_PROXY_PORT = String(proxyPort);

const configStore = require('./src/config-store');
const settingsPatcher = require('./src/settings-patcher');
const codexPatcher = require('./src/codex-patcher');
const proxyManager = require('./src/proxy-manager');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function requestJson(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        'anthropic-version': '2023-06-01',
      },
      timeout: 5000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
    req.write(raw);
    req.end();
  });
}

function makeUpstream() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(raw),
      });
      const response = JSON.stringify({
        type: 'message',
        content: [
          { type: 'thinking', thinking: 'stub thinking' },
          { type: 'text', text: 'pong' },
        ],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(response) });
      res.end(response);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

function makeChatUpstream(options = {}) {
  const { mode = 'text_with_reasoning', statusCode = 200, disconnectHalfway = false } = options;
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });

      if (statusCode >= 400) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'test error' } }));
      }

      let parts;
      switch (mode) {
        case 'text_only':
          parts = [
            { choices: [{ delta: { content: 'hello' } }] },
            { choices: [{ delta: { content: ' world' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 42 } },
          ];
          break;
        case 'tool_call':
          parts = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fc_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd"' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ];
          break;
        case 'error':
          // handled by statusCode
          parts = [];
          break;
        case 'text_with_reasoning':
        default:
          parts = [
            { choices: [{ delta: { reasoning_content: 'think ' } }] },
            { choices: [{ delta: { content: 'hi' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
          break;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (disconnectHalfway && parts.length > 1) {
        res.write(`data: ${JSON.stringify(parts[0])}\n\n`);
        res.destroy(); // 模拟连接中断
        return;
      }
      for (const part of parts) res.write(`data: ${JSON.stringify(part)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, calls, port: server.address().port });
    });
  });
}

async function run() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  // v1.6.0：proxy 是多文件 bundle（gateway/providers/clients/...），部署整个 proxy/ 目录而非单文件。
  fs.cpSync(path.join(__dirname, 'proxy'), configDir, { recursive: true });

  const originalSettings = {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'old-model',
    },
    effortLevel: 'xhigh',
  };
  fs.writeFileSync(settingsPath, JSON.stringify(originalSettings, null, 2));

  const cfg = {
    apiKey: 'sk-test-key',
    model: 'deepseek-v4-flash',
    thinking: 'enabled',
    effort: 'high',
  };

  console.log('\n-- config-store --');
  configStore.write(cfg);
  check('writes and reads selected model/effort', () => {
    assert.deepStrictEqual(configStore.read(), cfg);
  });

  console.log('\n-- settings-patcher --');
  settingsPatcher.patch(cfg);
  const patched = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check('points Claude Code at the local proxy', () => {
    assert.strictEqual(patched.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${proxyPort}`);
  });
  check('writes Claude Code model env and top-level model', () => {
    assert.strictEqual(patched.env.ANTHROPIC_MODEL, cfg.model);
    assert.strictEqual(patched.env.ANTHROPIC_DEFAULT_OPUS_MODEL, cfg.model);
    assert.strictEqual(patched.env.ANTHROPIC_DEFAULT_SONNET_MODEL, cfg.model);
    assert.strictEqual(patched.model, cfg.model);
  });
  check('writes effort and thinking defaults', () => {
    assert.strictEqual(patched.env.CLAUDE_CODE_EFFORT_LEVEL, cfg.effort);
    assert.strictEqual(patched.effortLevel, cfg.effort);
    assert.strictEqual(patched.alwaysThinkingEnabled, true);
  });
  check('writes a local placeholder token, NOT the real provider key', () => {
    assert.notStrictEqual(patched.env.ANTHROPIC_AUTH_TOKEN, cfg.apiKey);
    assert.strictEqual(patched.env.ANTHROPIC_AUTH_TOKEN, settingsPatcher.LOCAL_TOKEN);
  });
  check('re-patching overwrites a previously leaked real key with the placeholder', () => {
    const dirty = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    dirty.env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
    fs.writeFileSync(settingsPath, JSON.stringify(dirty, null, 2));
    settingsPatcher.patch(cfg);
    const repatched = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(repatched.env.ANTHROPIC_AUTH_TOKEN, settingsPatcher.LOCAL_TOKEN);
    assert.ok(!fs.readFileSync(settingsPath, 'utf-8').includes(cfg.apiKey));
  });
  settingsPatcher.patch({ ...cfg, model: 'deepseek-v4-pro', effort: 'max' });
  settingsPatcher.restore();

  console.log('\n-- codex-patcher --');
  fs.writeFileSync(codexConfigPath, 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');
  codexPatcher.patch(cfg);
  const codexConfig = fs.readFileSync(codexConfigPath, 'utf-8');
  check('writes [profiles.default] pointing to deepseek_local', () => {
    assert.match(codexConfig, /\[profiles\.default\]/);
    assert.match(codexConfig, /model_provider = "deepseek_local"/);
    assert.match(codexConfig, new RegExp(`base_url = "http://127.0.0.1:${proxyPort}/v1"`));
    assert.doesNotMatch(codexConfig, /experimental_bearer_token = "sk-test-key"/);
    assert.match(codexConfig, new RegExp(`experimental_bearer_token = "${codexPatcher.LOCAL_TOKEN}"`));
  });
  check('writes top-level deepseek_local override so codex uses our proxy in login state', () => {
    // 关键：codex 0.128 在 ChatGPT 账号登录态下，顶层 model_provider 是路由决定性字段
    const beforeManaged = codexConfig.split('# >>> deepseek-claude-setup')[0];
    assert.match(beforeManaged, /^model = "deepseek-v4-flash"/m);
    assert.match(beforeManaged, /^model_provider = "deepseek_local"/m);
    // 原顶层 gpt-5.5 应被 strip，不再出现在 managed block 之前
    assert.doesNotMatch(beforeManaged, /^model = "gpt-5\.5"/m);
    // 但原值必须保留在 managed block 注释里供 restore 用
    assert.match(codexConfig, /# model = "gpt-5\.5"/);
    assert.match(codexConfig, /# model_reasoning_effort = "high"/);
  });
  check('writes (none) for original defaults when no [profiles.default] existed', () => {
    assert.match(codexConfig, /# \(none\)/);
  });
  codexPatcher.restore();
  check('restores: removes managed block, no [profiles.default] left', () => {
    const restored = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.match(restored, /model = "gpt-5.5"/);
    assert.doesNotMatch(restored, /\[profiles\.deepseek\]/);
    assert.doesNotMatch(restored, /\[profiles\.default\]/);
  });

  // 测试原始有 [profiles.default] 时的还原
  fs.writeFileSync(codexConfigPath, '[profiles.default]\nmodel_provider = "openai"\nmodel = "gpt-5.5"\n');
  codexPatcher.patch(cfg);
  check('saves original [profiles.default] values in comments', () => {
    const content = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.match(content, /# model_provider = "openai"/);
    assert.match(content, /# model = "gpt-5.5"/);
  });
  codexPatcher.restore();
  check('restores original [profiles.default] values', () => {
    const restored = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.match(restored, /\[profiles\.default\]/);
    assert.match(restored, /model_provider = "openai"/);
    assert.match(restored, /model = "gpt-5.5"/);
    assert.doesNotMatch(restored, /deepseek_local/);
  });

  // 测试 restore fallback: 注释缺失时从 backup 文件恢复
  fs.writeFileSync(codexConfigPath, '[profiles.default]\nmodel_provider = "openai"\nmodel = "gpt-5.5"\n');
  codexPatcher.patch(cfg);
  // 删除备份文件，但因为 patch 已经做了 backup，我们能模拟注释丢失
  // 实际上 backup 是在 patch 开头做的，此时 backup 内容是 patch 前的原始文件
  const backupExists = fs.existsSync(`${codexConfigPath}.deepseek-backup`);
  check('backup file exists after patch', () => { assert.ok(backupExists); });
  // 移除注释段，模拟用户手动删除
  let content = fs.readFileSync(codexConfigPath, 'utf-8');
  content = content.replace(/# --- original default profile ---[\s\S]*?# --- end original ---/, '');
  fs.writeFileSync(codexConfigPath, content);
  codexPatcher.restore();
  check('restore falls back to backup file when comments missing', () => {
    const restored = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.match(restored, /\[profiles\.default\]/);
    assert.match(restored, /model_provider = "openai"/);
    assert.doesNotMatch(restored, /deepseek_local/);
  });

  // 测试 isPatched 兼容 v0.1 格式
  fs.writeFileSync(codexConfigPath, '# >>> deepseek-claude-setup codex\n[profiles.deepseek]\nmodel_provider = "deepseek_local"\n# <<< deepseek-claude-setup codex\n');
  check('isPatched returns true for v0.1 [profiles.deepseek] format', () => {
    assert.ok(codexPatcher.isPatched());
  });
  codexPatcher.restore();
  check('restore cleans up v0.1 managed block', () => {
    const restored = fs.readFileSync(codexConfigPath, 'utf-8');
    assert.doesNotMatch(restored, /\[profiles\.deepseek\]/);
  });
  check('restores the original settings after repeated patch calls', () => {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), originalSettings);
  });
  settingsPatcher.patch(cfg);
  fs.unlinkSync(settingsPath + '.deepseek-backup');
  settingsPatcher.restore();
  const fallbackRestored = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check('fallback restore never leaves Claude Code pointed at the stopped proxy', () => {
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_BASE_URL, settingsPatcher.DIRECT_URL);
    assert.notStrictEqual(fallbackRestored.env.ANTHROPIC_BASE_URL, settingsPatcher.PROXY_URL);
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_AUTH_TOKEN, cfg.apiKey);
    assert.strictEqual(fallbackRestored.env.ANTHROPIC_MODEL, cfg.model);
  });
  settingsPatcher.patch({ ...cfg, thinking: 'disabled' });
  const thinkingOffSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check('writes disabled thinking mode without Claude effort forcing', () => {
    assert.strictEqual(thinkingOffSettings.alwaysThinkingEnabled, false);
    assert.strictEqual(thinkingOffSettings.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    assert.strictEqual(thinkingOffSettings.effortLevel, undefined);
  });
  settingsPatcher.restore();

  console.log('\n-- proxy injection --');
  const upstream = await makeUpstream();
  process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL = 'http:';
  process.env.DEEPSEEK_CLAUDE_TARGET_HOST = '127.0.0.1';
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(upstream.port);
  process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX = '/anthropic';

  configStore.write(cfg);
  await proxyManager.start();
  try {
    const health = await proxyManager.getHealth();
    check('reports its selected model and effort through health check', () => {
      assert.strictEqual(health.model, cfg.model);
      assert.strictEqual(health.effort, cfg.effort);
      assert.strictEqual(health.thinking, 'enabled');
    });

    const response = await requestJson(proxyPort, '/v1/messages?beta=true', {
      model: 'deepseek-v4-pro',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'disabled', budget_tokens: 1 },
      output_config: { effort: 'max' },
    });

    check('proxy response is forwarded from upstream', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /pong/);
    });
    check('forwards to the DeepSeek Anthropic path with query string preserved', () => {
      assert.strictEqual(upstream.calls[0].url, '/anthropic/v1/messages?beta=true');
    });
    check('overrides model, thinking mode, and output_config.effort', () => {
      assert.strictEqual(upstream.calls[0].body.model, cfg.model);
      assert.deepStrictEqual(upstream.calls[0].body.thinking, { type: 'enabled', budget_tokens: 1 });
      assert.deepStrictEqual(upstream.calls[0].body.output_config, { effort: cfg.effort });
    });
    check('uses saved DeepSeek API key for upstream auth', () => {
      assert.strictEqual(upstream.calls[0].headers['x-api-key'], cfg.apiKey);
      assert.strictEqual(upstream.calls[0].headers.authorization, `Bearer ${cfg.apiKey}`);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstream.server.close(resolve));
  }

  console.log('\n-- proxy thinking disabled --');
  const upstreamOff = await makeUpstream();
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(upstreamOff.port);
  configStore.write({ ...cfg, thinking: 'disabled', effort: 'max' });
  await proxyManager.start();
  try {
    const health = await proxyManager.getHealth();
    check('reports disabled thinking mode through health check', () => {
      assert.strictEqual(health.thinking, 'disabled');
      assert.strictEqual(health.effort, null);
    });

    await requestJson(proxyPort, '/v1/messages', {
      model: 'deepseek-v4-pro',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'enabled', budget_tokens: 32768 },
      output_config: { effort: 'max' },
    });

    check('disables thinking and removes output_config when configured off', () => {
      assert.deepStrictEqual(upstreamOff.calls[0].body.thinking, { type: 'disabled', budget_tokens: 32768 });
      assert.strictEqual(upstreamOff.calls[0].body.output_config, undefined);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => upstreamOff.server.close(resolve));
  }

  console.log('\n-- codex responses proxy --');
  const chatUpstream = await makeChatUpstream();
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(chatUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      instructions: 'Say hi.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'exec_command', description: 'Run command', parameters: { type: 'object', properties: {} } }],
      stream: true,
    });
    check('accepts Codex Responses API requests and responds with streaming SSE events', () => {
      assert.strictEqual(response.statusCode, 200);
      assert.match(response.body, /response\.created/);
      assert.match(response.body, /response\.in_progress/);
      assert.match(response.body, /response\.reasoning_text\.delta/);
      assert.match(response.body, /response\.output_text\.delta/);
      assert.match(response.body, /response\.completed/);
    });
    check('translates Codex Responses requests into DeepSeek chat completions', () => {
      assert.strictEqual(chatUpstream.calls[0].url, '/chat/completions');
      assert.strictEqual(chatUpstream.calls[0].body.model, cfg.model);
      // Chat Completions 路径用 reasoning_effort 控制强度，thinking 控制开关，不发 output_config
      assert.strictEqual(chatUpstream.calls[0].body.reasoning_effort, cfg.effort);
      assert.deepStrictEqual(chatUpstream.calls[0].body.thinking, { type: 'enabled' });
      assert.strictEqual(chatUpstream.calls[0].body.output_config, undefined);
      assert.strictEqual(chatUpstream.calls[0].body.tools[0].function.name, 'exec_command');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => chatUpstream.server.close(resolve));
  }

  // --- streaming tests: text-only mode ---
  console.log('\n-- codex streaming: text-only --');
  const textUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(textUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    });
    check('streams text-only: output_text.delta contains correct text', () => {
      assert.match(response.body, /hello world/);
      assert.match(response.body, /response\.output_text\.delta/);
    });
    check('streams text-only: no reasoning item when no reasoning_content', () => {
      assert.doesNotMatch(response.body, /"type":"reasoning"/);
    });
    check('streams text-only: includes usage in completed', () => {
      assert.match(response.body, /"total_tokens":42/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => textUpstream.server.close(resolve));
  }

  // --- streaming tests: tool call mode ---
  console.log('\n-- codex streaming: tool call --');
  const toolUpstream = await makeChatUpstream({ mode: 'tool_call' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(toolUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] }],
      tools: [{ type: 'function', name: 'exec_command', description: 'Run', parameters: { type: 'object', properties: {} } }],
      stream: true,
    });
    check('tool call: emits function_call output_item', () => {
      assert.match(response.body, /"type":"function_call"/);
    });
    check('tool call: emits function_call_arguments.delta', () => {
      assert.match(response.body, /function_call_arguments\.delta/);
    });
    check('tool call: emits function_call_arguments.done with name', () => {
      assert.match(response.body, /function_call_arguments\.done/);
      assert.match(response.body, /exec_command/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => toolUpstream.server.close(resolve));
  }

  // --- streaming tests: non-streaming (JSON) response ---
  console.log('\n-- codex: non-streaming --');
  const jsonUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(jsonUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
    });
    check('non-streaming: returns JSON response object', () => {
      const parsed = JSON.parse(response.body);
      assert.strictEqual(parsed.object, 'response');
      assert.strictEqual(parsed.status, 'completed');
      assert.match(parsed.output_text, /hello world/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => jsonUpstream.server.close(resolve));
  }

  // --- streaming tests: upstream error ---
  console.log('\n-- codex: upstream error --');
  const errorUpstream = await makeChatUpstream({ mode: 'error', statusCode: 500 });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(errorUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    });
    check('error: emits response.failed', () => {
      assert.match(response.body, /response\.failed/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => errorUpstream.server.close(resolve));
  }

  // --- streaming tests: thinking disabled → no reasoning item ---
  console.log('\n-- codex: thinking disabled --');
  const noThinkingUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(noThinkingUpstream.port);
  configStore.write({ ...cfg, thinking: 'disabled' });
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    });
    check('thinking disabled: thinking={type:disabled} sent to upstream', () => {
      assert.deepStrictEqual(noThinkingUpstream.calls[0].body.thinking, { type: 'disabled' });
    });
    check('thinking disabled: no reasoning_effort and no output_config to upstream', () => {
      // 关闭思考时不发 reasoning_effort（强度对关闭无意义）也不发 output_config（那是 Anthropic 路径专用）
      assert.strictEqual(noThinkingUpstream.calls[0].body.reasoning_effort, undefined);
      assert.strictEqual(noThinkingUpstream.calls[0].body.output_config, undefined);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => noThinkingUpstream.server.close(resolve));
  }

  // --- D1.A: function_call_output input → role=tool 翻译（多轮工具调用关键路径） ---
  console.log('\n-- codex: function_call_output input translation --');
  const fcOutUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(fcOutUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        { type: 'function_call', call_id: 'call_abc123', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_abc123', output: 'file1.txt\nfile2.txt' },
      ],
      stream: true,
    });
    const sentMessages = fcOutUpstream.calls[0].body.messages;
    check('function_call_output translated to role=tool with tool_call_id', () => {
      const toolMsg = sentMessages.find(m => m.role === 'tool');
      assert.ok(toolMsg, 'expected at least one tool message');
      assert.strictEqual(toolMsg.tool_call_id, 'call_abc123');
      assert.strictEqual(toolMsg.content, 'file1.txt\nfile2.txt');
    });
    check('function_call input translated to assistant tool_calls', () => {
      const asstMsg = sentMessages.find(m => m.role === 'assistant' && m.tool_calls);
      assert.ok(asstMsg, 'expected assistant message with tool_calls');
      assert.strictEqual(asstMsg.tool_calls[0].id, 'call_abc123');
      assert.strictEqual(asstMsg.tool_calls[0].function.name, 'exec_command');
      assert.strictEqual(asstMsg.tool_calls[0].function.arguments, '{"cmd":"ls"}');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => fcOutUpstream.server.close(resolve));
  }

  // DeepSeek 文档要求：含工具调用的轮次必须回传 reasoning_content，否则 400
  console.log('\n-- codex: reasoning_content carried into tool-call assistant messages --');
  const reasonCarryUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(reasonCarryUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I should call ls' }] },
        { type: 'function_call', call_id: 'call_z', name: 'exec', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_z', output: 'a.txt' },
      ],
      stream: true,
    });
    const msgs = reasonCarryUpstream.calls[0].body.messages;
    check('reasoning before function_call is attached to assistant message', () => {
      const asst = msgs.find(m => m.role === 'assistant' && m.tool_calls);
      assert.ok(asst, 'expected assistant message with tool_calls');
      assert.strictEqual(asst.reasoning_content, 'I should call ls');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(r => reasonCarryUpstream.server.close(r));
  }

  // 并行工具调用：连续多个 function_call input 必须合并成一条 assistant 消息，
  // 否则 DeepSeek 报 "insufficient tool messages following tool_calls"
  console.log('\n-- codex: parallel function_calls merged --');
  const parallelUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(parallelUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list two dirs' }] },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'parallel A and B' }] },
        { type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{"dir":"a"}' },
        { type: 'function_call', call_id: 'call_2', name: 'ls', arguments: '{"dir":"b"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a-content' },
        { type: 'function_call_output', call_id: 'call_2', output: 'b-content' },
      ],
      stream: true,
    });
    const msgs = parallelUpstream.calls[0].body.messages;
    check('parallel function_calls collapsed into one assistant message', () => {
      const asstWithTools = msgs.filter(m => m.role === 'assistant' && m.tool_calls);
      assert.strictEqual(asstWithTools.length, 1, `expected exactly 1 assistant tool_calls msg, got ${asstWithTools.length}`);
      assert.strictEqual(asstWithTools[0].tool_calls.length, 2);
      assert.strictEqual(asstWithTools[0].tool_calls[0].id, 'call_1');
      assert.strictEqual(asstWithTools[0].tool_calls[1].id, 'call_2');
      assert.strictEqual(asstWithTools[0].reasoning_content, 'parallel A and B');
    });
    check('tool messages immediately follow assistant tool_calls', () => {
      const asstIdx = msgs.findIndex(m => m.role === 'assistant' && m.tool_calls);
      assert.strictEqual(msgs[asstIdx + 1].role, 'tool');
      assert.strictEqual(msgs[asstIdx + 1].tool_call_id, 'call_1');
      assert.strictEqual(msgs[asstIdx + 2].role, 'tool');
      assert.strictEqual(msgs[asstIdx + 2].tool_call_id, 'call_2');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(r => parallelUpstream.server.close(r));
  }

  // 关键回归：连续 assistant 行为（reasoning -> message -> function_call 没有独立 reasoning）
  // 第二个 assistant tool_calls 应该 fallback 到上一次 reasoning 作为 reasoning_content，
  // 否则 DeepSeek 报 "reasoning_content must be passed back"
  const reasonFallbackUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(reasonFallbackUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do things' }] },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plan A' }] },
        { type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'a-result' },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'analyze A then act B' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A done; now B' }] },
        // 注意：这里没有独立的 reasoning，但下一个 function_call 仍需要 reasoning_content
        { type: 'function_call', call_id: 'call_b', name: 'tool_b', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_b', output: 'b-result' },
      ],
      stream: true,
    });
    const msgs = reasonFallbackUpstream.calls[0].body.messages;
    check('orphan function_call after assistant message reuses last reasoning', () => {
      const fcMessages = msgs.filter(m => m.role === 'assistant' && m.tool_calls);
      assert.strictEqual(fcMessages.length, 2, 'expected 2 assistant tool_calls messages');
      // 第一个 fc 消息 reasoning 来自 'plan A'
      assert.strictEqual(fcMessages[0].reasoning_content, 'plan A');
      // 第二个 fc 消息没自己的 reasoning，应 fallback 到刚才的 'analyze A then act B'
      assert.strictEqual(fcMessages[1].reasoning_content, 'analyze A then act B');
    });
    check('assistant text message between function_calls keeps its own reasoning', () => {
      const asstText = msgs.find(m => m.role === 'assistant' && m.content && m.content.includes('A done'));
      assert.ok(asstText);
      assert.strictEqual(asstText.reasoning_content, 'analyze A then act B');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(r => reasonFallbackUpstream.server.close(r));
  }

  // reasoning 不附加给 user 消息；仅附加给 assistant（文档：无 tool_call 的 reasoning
  // 传过去 DeepSeek 会忽略，所以无差别附加 assistant 是最安全的）
  const reasonUserUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(reasonUserUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'stale thought' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      stream: true,
    });
    const msgs = reasonUserUpstream.calls[0].body.messages;
    check('reasoning is NOT attached to user messages', () => {
      const userMsg = msgs.find(m => m.role === 'user');
      assert.ok(userMsg);
      assert.strictEqual(userMsg.reasoning_content, undefined);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => reasonUserUpstream.server.close(resolve));
  }

  // reasoning 应该附加给紧接的 assistant message（含工具调用轮次的最终回复，
  // DeepSeek 文档：含工具调用的轮次中所有 assistant 的 reasoning_content 必须回传）
  const reasonAsstUpstream = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(reasonAsstUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'analyze A' }] },
        { type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'a-result' },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'final summary thought' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here is A' }] },
      ],
      stream: true,
    });
    const msgs = reasonAsstUpstream.calls[0].body.messages;
    check('reasoning attached to assistant message (final response in tool-call turn)', () => {
      const asstText = msgs.find(m => m.role === 'assistant' && m.content === 'Here is A');
      assert.ok(asstText, 'expected final assistant text message');
      assert.strictEqual(asstText.reasoning_content, 'final summary thought');
    });
    check('reasoning still attached to assistant tool_calls message', () => {
      const asstTools = msgs.find(m => m.role === 'assistant' && m.tool_calls);
      assert.ok(asstTools);
      assert.strictEqual(asstTools.reasoning_content, 'analyze A');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => reasonAsstUpstream.server.close(resolve));
  }

  // function_call_output 的 output 是对象时应该 JSON.stringify
  const fcOutObj = await makeChatUpstream({ mode: 'text_only' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(fcOutObj.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        { type: 'function_call_output', call_id: 'call_x', output: { result: 'ok', count: 3 } },
      ],
      stream: true,
    });
    check('function_call_output: object output gets JSON.stringify', () => {
      const tm = fcOutObj.calls[0].body.messages.find(m => m.role === 'tool');
      assert.ok(tm, 'expected a tool message');
      assert.strictEqual(tm.content, '{"result":"ok","count":3}');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(r => fcOutObj.server.close(r));
  }

  // --- D1.B: function_call output_item 必须含 id == call_id 且都是 call_ 前缀 ---
  console.log('\n-- codex: function_call call_id contract --');
  const callIdUpstream = await makeChatUpstream({ mode: 'tool_call' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(callIdUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] }],
      tools: [{ type: 'function', name: 'exec_command', description: 'Run', parameters: { type: 'object', properties: {} } }],
      stream: true,
    });
    // 抓出 output_item.added 事件里的 function_call item
    const fcAddedMatch = response.body.match(/data: ({"type":"response\.output_item\.added"[^\n]*"type":"function_call"[^\n]*})/);
    check('function_call item has both id and call_id with call_ prefix', () => {
      assert.ok(fcAddedMatch, 'expected output_item.added with function_call item');
      const event = JSON.parse(fcAddedMatch[1]);
      assert.ok(event.item.id.startsWith('call_'), `id should start with call_, got ${event.item.id}`);
      assert.ok(event.item.call_id.startsWith('call_'), `call_id should start with call_, got ${event.item.call_id}`);
      assert.strictEqual(event.item.id, event.item.call_id, 'id must equal call_id for Codex compat');
    });
    check('function_call_arguments.done does NOT include name', () => {
      const doneMatch = response.body.match(/data: ({"type":"response\.function_call_arguments\.done"[^\n]*})/);
      assert.ok(doneMatch);
      const event = JSON.parse(doneMatch[1]);
      assert.strictEqual(event.name, undefined, 'arguments.done must not contain name');
      assert.ok(event.arguments, 'arguments.done must contain arguments string');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => callIdUpstream.server.close(resolve));
  }

  // --- D1.C: reasoning 是独立 output_item，与 message item 分离 ---
  console.log('\n-- codex: reasoning is independent output_item --');
  const reasonUpstream = await makeChatUpstream({ mode: 'text_with_reasoning' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(reasonUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    });
    const addedEvents = [...response.body.matchAll(/data: ({"type":"response\.output_item\.added"[^\n]*})/g)]
      .map(m => JSON.parse(m[1]));
    check('reasoning emits its own output_item.added with type=reasoning', () => {
      const reasoningItem = addedEvents.find(e => e.item.type === 'reasoning');
      assert.ok(reasoningItem, 'expected output_item.added with type=reasoning');
    });
    check('message emits a separate output_item.added with type=message', () => {
      const messageItem = addedEvents.find(e => e.item.type === 'message');
      assert.ok(messageItem, 'expected output_item.added with type=message');
    });
    check('reasoning and message have different item ids and output_index', () => {
      const r = addedEvents.find(e => e.item.type === 'reasoning');
      const m = addedEvents.find(e => e.item.type === 'message');
      assert.notStrictEqual(r.item.id, m.item.id);
      assert.notStrictEqual(r.output_index, m.output_index);
    });
    check('reasoning item emits full 6-step lifecycle', () => {
      // added → content_part.added → reasoning_text.delta+ → reasoning_text.done → content_part.done → output_item.done
      assert.match(response.body, /response\.output_item\.added[^\n]*"type":"reasoning"/);
      assert.match(response.body, /response\.content_part\.added[^\n]*"type":"reasoning_text"/);
      assert.match(response.body, /response\.reasoning_text\.delta/);
      assert.match(response.body, /response\.reasoning_text\.done/);
      assert.match(response.body, /response\.content_part\.done[^\n]*"type":"reasoning_text"/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => reasonUpstream.server.close(resolve));
  }

  // --- D1.D: tool args 是真流式（每个上游 chunk 触发一个 delta 事件） ---
  console.log('\n-- codex: tool args true streaming --');
  const streamArgsUpstream = await makeChatUpstream({ mode: 'tool_call' });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(streamArgsUpstream.port);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] }],
      tools: [{ type: 'function', name: 'exec_command', description: 'Run', parameters: { type: 'object', properties: {} } }],
      stream: true,
    });
    // tool_call mode 上游发了 3 个 args 增量 chunk: '{"cmd"' / ':"ls"' / '}'
    const argDeltas = [...response.body.matchAll(/data: ({"type":"response\.function_call_arguments\.delta"[^\n]*})/g)]
      .map(m => JSON.parse(m[1]));
    check('tool args emit one delta per upstream chunk (not coalesced)', () => {
      assert.ok(argDeltas.length >= 3, `expected >=3 incremental deltas, got ${argDeltas.length}`);
    });
    check('tool args delta events carry incremental delta text', () => {
      const concatenated = argDeltas.map(e => e.delta).join('');
      assert.strictEqual(concatenated, '{"cmd":"ls"}');
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => streamArgsUpstream.server.close(resolve));
  }

  // 透明重试：第一次连接被对方 destroy（模拟 TLS bad record / ECONNRESET），
  // 代理应该静默 retry，客户端不感知失败
  console.log('\n-- codex: transient connection error transparent retry --');
  let firstReqDestroyed = false;
  const flakyServer = http.createServer((req, res) => {
    if (!firstReqDestroyed) {
      firstReqDestroyed = true;
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'retry-ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const flakyPort = await new Promise(resolve => {
    flakyServer.listen(0, '127.0.0.1', () => resolve(flakyServer.address().port));
  });
  process.env.DEEPSEEK_CLAUDE_TARGET_PORT = String(flakyPort);
  configStore.write(cfg);
  await proxyManager.start();
  try {
    const response = await requestJson(proxyPort, '/v1/responses', {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
    });
    check('transient connection error → transparent retry → success', () => {
      assert.match(response.body, /retry-ok/);
      assert.doesNotMatch(response.body, /response\.failed/);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(r => flakyServer.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

run().catch(async err => {
  console.error(err);
  try { await proxyManager.stop(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
