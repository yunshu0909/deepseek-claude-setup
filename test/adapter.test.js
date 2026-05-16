/**
 * Adapter / Gateway 抽象单测 —— PRD-005-R ADP / STR-3 / STR-4
 *
 * 负责：
 * - 验证 provider adapter 三方法（buildChatRequestSpec/parseChatStreamChunk/
 *   buildAnthropicRequestSpec）的契约
 * - 验证 GatewayRequest/GatewayEvent 中立抽象存在且字段最小完整
 * - 验证 config migration / provider selection / CanonicalConversation 不提前 lower
 *
 * 全部不做网络 IO（纯函数级断言）。
 *
 * @module test/adapter
 */
const assert = require('assert');

const gateway = require('../proxy/gateway');
const deepseek = require('../proxy/providers/deepseek');
const zai = require('../proxy/providers/zai');
const providerRegistry = require('../proxy/providers');
const runtimeConfig = require('../proxy/runtime-config');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); }
}

console.log('\n-- adapter / gateway abstraction --');

// STR-3：adapter 接口真存在
check('STR-3: deepseek + zai expose adapter trio as functions', () => {
  for (const p of [deepseek, zai]) {
    for (const m of ['buildChatRequestSpec', 'parseChatStreamChunk', 'buildAnthropicRequestSpec']) {
      assert.strictEqual(typeof p[m], 'function', `${p.id}.${m}`);
    }
  }
});

// STR-4：中立抽象存在且最小字段完整
check('STR-4: GatewayRequest carries provider-neutral minimal fields', () => {
  const gr = gateway.makeGatewayRequest({
    model: 'm', messages: [{ role: 'user', content: 'hi' }],
    tools: undefined, thinking: 'enabled', effort: 'max', stream: true,
  });
  assert.strictEqual(gr.model, 'm');
  assert.deepStrictEqual(gr.conversation, { messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(gr.thinking, 'enabled');
  assert.strictEqual(gr.effort, 'max');
  assert.strictEqual(gr.stream, true);
});
check('STR-4: GatewayEvent stream is a typed list of {kind,...}', () => {
  const evs = gateway.parseChatStreamDelta({
    choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.ok(Array.isArray(evs));
  assert.ok(evs.every(e => typeof e.kind === 'string'));
  assert.deepStrictEqual(evs.map(e => e.kind).sort(), ['finish', 'text', 'usage']);
});

// ADP-1：config migration
check('ADP-1: legacy {apiKey,model} migrates into providers.deepseek', () => {
  const n = runtimeConfig.normalizeConfig({ apiKey: 'sk-x', model: 'deepseek-v4-flash' });
  assert.strictEqual(n.activeProvider, 'deepseek');
  assert.strictEqual(n.providers.deepseek.apiKey, 'sk-x');
  assert.strictEqual(n.providers.deepseek.model, 'deepseek-v4-flash');
  assert.strictEqual(n.apiKey, 'sk-x'); // 兼容顶层
});

// ADP-2：provider selection
check('ADP-2: registry resolves deepseek/zai adapters, unknown → null', () => {
  assert.strictEqual(providerRegistry.getProvider('deepseek').id, 'deepseek');
  assert.strictEqual(providerRegistry.getProvider('zai').id, 'zai');
  assert.strictEqual(providerRegistry.getProvider('nope'), null);
});

// ADP-3：deepseek.buildChatRequestSpec
check('ADP-3: deepseek.buildChatRequestSpec injects model + reasoning_effort, no zai-only fields', () => {
  const gr = gateway.makeGatewayRequest({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: undefined, thinking: 'enabled', effort: 'max', stream: true,
  });
  const spec = deepseek.buildChatRequestSpec(gr, { apiKey: 'sk-a', baseUrl: 'https://api.deepseek.com', chatPath: '/chat/completions' });
  assert.strictEqual(spec.body.model, 'deepseek-v4-pro');
  assert.strictEqual(spec.body.stream, true);
  assert.strictEqual(spec.body.reasoning_effort, 'max');           // thinkingEffort 未禁用
  assert.strictEqual(spec.body.clear_thinking, undefined);          // 非 zai
  assert.strictEqual(spec.body.tool_stream, undefined);             // 非 zai
  assert.deepStrictEqual(spec.body.stream_options, { include_usage: true });
  assert.strictEqual(spec.apiKey, 'sk-a');
  assert.strictEqual(spec.target.hostname, 'api.deepseek.com');
});

// ADP-4：deepseek.parseChatStreamChunk
check('ADP-4: deepseek.parseChatStreamChunk maps reasoning/content/tool_calls to GatewayEvents', () => {
  assert.deepStrictEqual(
    deepseek.parseChatStreamChunk({ choices: [{ delta: { reasoning_content: 'think' } }] }),
    [{ kind: 'reasoning', text: 'think' }]);
  assert.deepStrictEqual(
    deepseek.parseChatStreamChunk({ choices: [{ delta: { content: 'hello' } }] }),
    [{ kind: 'text', text: 'hello' }]);
  const tc = deepseek.parseChatStreamChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'ls', arguments: '{}' } }] } }],
  });
  assert.deepStrictEqual(tc, [{ kind: 'tool_call', index: 0, id: 'call_1', name: 'ls', argsDelta: '{}' }]);
});

// ADP-5：zai.buildChatRequestSpec（智谱专属字段规则）
check('ADP-5: zai.buildChatRequestSpec applies clear_thinking + tool_stream, suppresses effort/stream_options', () => {
  const gr = gateway.makeGatewayRequest({
    model: 'glm-5.1',
    messages: [{ role: 'assistant', content: null, reasoning_content: 'kept' }],
    tools: [{ type: 'function', function: { name: 'ls', parameters: {} } }],
    thinking: 'enabled', effort: 'max', stream: true,
  });
  const spec = zai.buildChatRequestSpec(gr, { apiKey: 'zk', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatPath: '/chat/completions' });
  assert.strictEqual(spec.body.reasoning_effort, undefined);        // thinkingEffort=false
  assert.strictEqual(spec.body.stream_options, undefined);          // chatStreamOptions=false
  assert.deepStrictEqual(spec.body.thinking, { type: 'enabled', clear_thinking: false });
  assert.strictEqual(spec.body.tool_stream, true);                  // toolStreamParam + tools
});

// ADP-6：Codex client adapter 消费 GatewayEvent（端到端契约由 test.js codex 套件覆盖；
// 此处单测 provider→neutral 这一接缝：tool_call 事件携带 id 供 client 维持 id==call_id）
check('ADP-6: tool_call GatewayEvent carries id (client keeps id==call_id from it)', () => {
  const [ev] = zai.parseChatStreamChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'run', arguments: '{"a":1}' } }] } }],
  });
  assert.strictEqual(ev.kind, 'tool_call');
  assert.strictEqual(ev.id, 'call_abc');
  assert.strictEqual(ev.name, 'run');
  assert.strictEqual(ev.argsDelta, '{"a":1}');
  assert.strictEqual(typeof require('../proxy/clients/codex-responses').streamChatToResponses, 'function');
});

// ADP-7：CanonicalConversation 不提前 lower（gateway 不注入 provider 专属字段）
check('ADP-7: makeGatewayRequest does not pre-lower / pre-inject provider fields', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const gr = gateway.makeGatewayRequest({ model: 'm', messages: msgs, thinking: 'enabled', effort: 'max' });
  assert.deepStrictEqual(gr.conversation.messages, msgs);          // 原样承载
  const json = JSON.stringify(gr);
  for (const f of ['reasoning_content', 'output_config', 'clear_thinking', 'tool_stream', 'reasoning_effort']) {
    assert.ok(!json.includes(f), `GatewayRequest 不应含 provider 专属字段 ${f}`);
  }
});

// ADP-8：Kimi K2.6 reasoning/reasoning_content 双字段兼容（PRD-008 US-44 强制要求）
const kimi = require('../proxy/providers/kimi');
check('ADP-8: kimi tolerates K2.6 `reasoning` field as reasoning (dual-field)', () => {
  // K2.6 只给 reasoning
  assert.deepStrictEqual(
    kimi.parseChatStreamChunk({ choices: [{ delta: { reasoning: 'k26-think' } }] }),
    [{ kind: 'reasoning', text: 'k26-think' }]);
  // K2.5 给 reasoning_content（不受影响）
  assert.deepStrictEqual(
    kimi.parseChatStreamChunk({ choices: [{ delta: { reasoning_content: 'k25-think' } }] }),
    [{ kind: 'reasoning', text: 'k25-think' }]);
  // 两者都在时以 reasoning_content 为准（不重复）
  const evs = kimi.parseChatStreamChunk({ choices: [{ delta: { reasoning: 'x', reasoning_content: 'y' } }] });
  assert.deepStrictEqual(evs, [{ kind: 'reasoning', text: 'y' }]);
  // 不污染基座：deepseek 不认 reasoning 字段
  assert.deepStrictEqual(
    require('../proxy/providers/deepseek').parseChatStreamChunk({ choices: [{ delta: { reasoning: 'z' } }] }),
    []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
