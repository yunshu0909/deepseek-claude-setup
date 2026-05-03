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
  fs.copyFileSync(path.join(__dirname, 'proxy', 'proxy.js'), path.join(configDir, 'proxy.js'));

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
    assert.strictEqual(patched.env.ANTHROPIC_BASE_URL, `http://localhost:${proxyPort}`);
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
  check('writes auth token from saved DeepSeek key', () => {
    assert.strictEqual(patched.env.ANTHROPIC_AUTH_TOKEN, cfg.apiKey);
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
    assert.match(codexConfig, new RegExp(`base_url = "http://localhost:${proxyPort}/v1"`));
    assert.match(codexConfig, /experimental_bearer_token = "sk-test-key"/);
  });
  check('preserves original top-level model', () => {
    assert.match(codexConfig, /model = "gpt-5.5"/);
  });
  check('writes (none) for original defaults when no [profiles.default] existed', () => {
    assert.match(codexConfig, /\(none\)/);
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
      assert.deepStrictEqual(chatUpstream.calls[0].body.thinking, { type: 'enabled' });
      assert.deepStrictEqual(chatUpstream.calls[0].body.output_config, { effort: cfg.effort });
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
    check('thinking disabled: no output_config sent to upstream', () => {
      assert.strictEqual(noThinkingUpstream.calls[0].body.output_config, undefined);
    });
  } finally {
    await proxyManager.stop();
    await new Promise(resolve => noThinkingUpstream.server.close(resolve));
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
