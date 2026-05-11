/**
 * Capability-driven 断言生成器 —— PRD-007 US-42
 *
 * 负责：
 * - 读 provider 元数据的 `capabilities` 字段，按当前 step 的 thinking / effort 配置生成
 *   `mustHave` / `mustNotHave` 两组字段断言
 * - 对 capture server 抓到的 JSONL 行做字段级比对，返回违反的 invariant 列表
 *
 * 规则表是**硬编码**的（每个 capability flag 对应一组规则）。接新 provider 时如有它特有的
 * 字段（如假设 Kimi 的 partial_mode），在本文件加新规则即可——这是 v0.6.x patch，不影响 v0.6 主线。
 *
 * 设计原则：
 * - **mustHave**：在符合条件的 step 中 capture 必须含有该字段（值可选——`true` 表示存在即可，
 *   正则/常量表示需要精确匹配）
 * - **mustNotHave**：在符合条件的 step 中 capture 不应有该字段；存在即违反
 * - **path 区分**：anthropic 路径（`/v1/messages` / `/anthropic/v1/messages`）和 chat 路径
 *   （`/chat/completions` / `/v1/chat/completions`）独立断言
 *
 * @module scripts/lib/capability-asserts
 */

const ANTHROPIC_PATH_RE = /\/v1\/messages$/;
const CHAT_PATH_RE = /\/chat\/completions$/;

/**
 * 安全读取嵌套字段，例如 `getField(body, 'thinking.type')`
 * @param {object} obj
 * @param {string} dottedPath
 * @returns {*} undefined 表示不存在
 */
function getField(obj, dottedPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = dottedPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 根据 provider.capabilities + 当前 step 配置生成期望字段清单。
 *
 * @param {object} provider - provider 元数据（含 capabilities）
 * @param {object} runConfig - { thinking, effort, hasReasoningContent, hasToolCall }
 *   - thinking: 'enabled' | 'disabled'
 *   - effort: 'high' | 'max' | '-' （`-` 表示该 provider 不支持 effort）
 *   - hasReasoningContent: 是否包含 reasoning_content（影响 zai 的 clear_thinking 注入）
 *   - hasToolCall: 是否工具调用场景（影响 zai 的 tool_stream 注入）
 * @returns {{anthropic: {mustHave: Array, mustNotHave: Array}, chat: {...}}}
 */
function expectedFields(provider, runConfig) {
  const caps = provider?.capabilities || {};
  const { thinking, effort, hasReasoningContent, hasToolCall } = runConfig;

  const result = {
    anthropic: { mustHave: [], mustNotHave: [] },
    chat: { mustHave: [], mustNotHave: [] },
  };

  // 1. thinking 字段断言（按 gateway 实际行为分三种情况）
  //
  // gateway 实际逻辑（proxy.js:628-642 / healthBody / writeGatewayConfig）：
  //   - caps.thinking === false: provider 不支持，所有 thinking 相关字段都不发
  //   - caps.thinking === true 且 anthropicThinking !== false:
  //       anthropic path 仍发 thinking: {type: "enabled" | "disabled"} 显式声明状态
  //   - caps.thinking === true 且 anthropicThinking === false（智谱）:
  //       anthropic path 永远不发 thinking 字段
  //
  // output_config.effort 仅在 thinking=enabled + anthropicThinking + thinkingEffort 全 true 时才发
  // reasoning_effort 仅在 thinking=enabled + thinkingEffort !== false 时才发
  if (caps.thinking === false) {
    result.anthropic.mustNotHave.push({ path: 'thinking', reason: 'provider thinking=false' });
    result.anthropic.mustNotHave.push({ path: 'output_config', reason: 'provider thinking=false' });
    result.chat.mustNotHave.push({ path: 'reasoning_effort', reason: 'provider thinking=false' });
  } else {
    // provider 支持 thinking，按 anthropicThinking 决定 Anthropic path 是否发字段
    if (caps.anthropicThinking === false) {
      // 智谱：Anthropic path 永远不带 thinking / output_config
      result.anthropic.mustNotHave.push({ path: 'thinking', reason: 'anthropicThinking=false' });
      result.anthropic.mustNotHave.push({ path: 'output_config', reason: 'anthropicThinking=false' });
    } else {
      // DS：thinking 字段必须存在且 type 跟随 step 配置
      result.anthropic.mustHave.push({ path: 'thinking.type', expected: thinking, reason: 'anthropic path explicit thinking state' });
      // output_config 仅在 enabled + thinkingEffort 支持时发
      if (thinking === 'enabled' && caps.thinkingEffort !== false && effort !== '-') {
        result.anthropic.mustHave.push({ path: 'output_config.effort', expected: effort, reason: 'enabled + thinkingEffort supported' });
      } else {
        result.anthropic.mustNotHave.push({ path: 'output_config', reason: thinking === 'disabled' ? 'thinking disabled' : 'thinkingEffort unsupported' });
      }
    }

    // Chat path: reasoning_effort 仅在 enabled + thinkingEffort 支持时发
    if (thinking === 'enabled' && caps.thinkingEffort !== false && effort !== '-') {
      result.chat.mustHave.push({ path: 'reasoning_effort', expected: effort, reason: 'enabled + thinkingEffort supported' });
    } else {
      result.chat.mustNotHave.push({ path: 'reasoning_effort', reason: thinking === 'disabled' ? 'thinking disabled' : (caps.thinkingEffort === false ? 'thinkingEffort=false' : 'no effort specified') });
    }
  }

  // 4. preservedThinking：智谱特有，Chat 路径含 reasoning_content 时需注入 clear_thinking=false
  if (caps.preservedThinking === 'clear_thinking' && hasReasoningContent) {
    result.chat.mustHave.push({ path: 'clear_thinking', expected: false, reason: 'preservedThinking=clear_thinking' });
  }
  // 反向：未声明 preservedThinking 的 provider（如 DS）不应发 clear_thinking
  if (!caps.preservedThinking) {
    result.chat.mustNotHave.push({ path: 'clear_thinking', reason: 'preservedThinking not declared' });
  }

  // 5. toolStreamParam：智谱工具调用时需注入 tool_stream=true
  if (caps.toolStreamParam === 'tool_stream' && hasToolCall) {
    result.chat.mustHave.push({ path: 'tool_stream', expected: true, reason: 'toolStreamParam=tool_stream + tool call' });
  }
  if (!caps.toolStreamParam) {
    result.chat.mustNotHave.push({ path: 'tool_stream', reason: 'toolStreamParam not declared' });
  }

  return result;
}

/**
 * 判断 capture 条目走的是 Anthropic 还是 Chat 路径
 */
function classifyPath(reqPath) {
  if (ANTHROPIC_PATH_RE.test(reqPath)) return 'anthropic';
  if (CHAT_PATH_RE.test(reqPath)) return 'chat';
  return null;
}

/**
 * 对一条 capture entry 做断言。
 *
 * @param {object} entry - JSONL 行（含 path / headers / body / step）
 * @param {object} expected - expectedFields 返回的对象
 * @returns {Array<{rule: string, field: string, reason: string, actual?: *, expected?: *}>} 违反清单（空数组=全通过）
 */
function assertEntry(entry, expected) {
  const violations = [];
  const kind = classifyPath(entry.path);
  if (!kind) return violations; // 非 Anthropic/Chat 路径不做断言（如 /__step 管理端点）
  const body = entry.body && typeof entry.body === 'object' ? entry.body : {};
  const rules = expected[kind];

  for (const m of rules.mustHave) {
    const actual = getField(body, m.path);
    if (actual === undefined) {
      violations.push({ rule: 'mustHave-missing', field: m.path, reason: m.reason, expected: m.expected });
    } else if (m.expected !== undefined && actual !== m.expected) {
      violations.push({ rule: 'mustHave-mismatch', field: m.path, reason: m.reason, expected: m.expected, actual });
    }
  }
  for (const n of rules.mustNotHave) {
    const actual = getField(body, n.path);
    if (actual !== undefined) {
      violations.push({ rule: 'mustNotHave-present', field: n.path, reason: n.reason, actual });
    }
  }

  return violations;
}

/**
 * 读 JSONL 文件，按 step 过滤后对每条 entry 跑 assertEntry
 *
 * @param {string} jsonlPath - capture server 输出的 JSONL 路径
 * @param {string} step - 当前 step 名（过滤条件）
 * @param {object} provider - provider 元数据
 * @param {object} runConfig - { thinking, effort, hasReasoningContent, hasToolCall }
 * @returns {{passed: boolean, entries: number, violations: Array}}
 */
function assertCapture(jsonlPath, step, provider, runConfig) {
  const fs = require('fs');
  if (!fs.existsSync(jsonlPath)) {
    return { passed: false, entries: 0, violations: [{ rule: 'no-capture', field: '-', reason: `JSONL not found: ${jsonlPath}` }] };
  }
  const expected = expectedFields(provider, runConfig);
  const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
  let entries = 0;
  const violations = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.step !== step) continue;
    entries++;
    const v = assertEntry(entry, expected);
    for (const item of v) {
      violations.push({ step, path: entry.path, ...item });
    }
  }
  if (entries === 0) {
    return { passed: false, entries: 0, violations: [{ rule: 'no-entries', field: '-', reason: `no capture entry for step ${step}` }] };
  }
  return { passed: violations.length === 0, entries, violations };
}

/**
 * PRD-007 US-48 state leak 真探针辅助
 *
 * 推导 from-provider 在切换前可能注入到 upstream payload 的"专属字段"清单。
 * 切换到 to-provider 后第一个 capture entry 必须**绝对不含**这些字段——否则就是 state leak。
 *
 * 设计原则：这跟 capability-asserts 普通规则的区别是
 *   - 普通规则按 to-provider 的 capability 反推"该有/不该有"；mustNotHave 已经覆盖大部分 leak
 *   - state-leak 探针从 from-provider 视角再单独列一遍专属字段，违反时 rule 标 'state-leak'
 *     这样报告能区分"to-provider 普通断言违反"和"from-provider 残留字段"两类问题，
 *     便于定位是 gateway 配置切换不彻底还是 capability 声明不一致。
 *
 * @param {object} provider - from-provider 元数据
 * @returns {{anthropic: string[], chat: string[]}} 字段清单（按路径分）
 */
function fromProviderExclusiveFields(provider) {
  const caps = provider?.capabilities || {};
  const fields = { anthropic: [], chat: [] };

  // Anthropic path 字段：provider 支持 thinking 注入时会发 thinking/output_config
  if (caps.thinking !== false && caps.anthropicThinking !== false) {
    fields.anthropic.push('thinking');           // type=enabled/disabled
    if (caps.thinkingEffort !== false) {
      fields.anthropic.push('output_config');    // {effort: max/high}
    }
  }

  // Chat path 字段：thinkingEffort 支持时会发 reasoning_effort
  if (caps.thinking !== false && caps.thinkingEffort !== false) {
    fields.chat.push('reasoning_effort');
  }
  // 智谱专属注入
  if (caps.preservedThinking === 'clear_thinking') {
    fields.chat.push('clear_thinking');
  }
  if (caps.toolStreamParam) {
    fields.chat.push(caps.toolStreamParam);      // 'tool_stream'
  }

  return fields;
}

/**
 * 对当前 step 的第一个 capture entry 跑 state-leak 断言：
 * from-provider 的专属字段绝对不该出现在 to-provider 的首请求 payload 里。
 *
 * @param {string} jsonlPath
 * @param {string} step - 当前 step 名（to）
 * @param {object} fromProvider - 上一个 step 的 provider 元数据
 * @returns {{passed: boolean, firstEntries: number, violations: Array}}
 */
function assertStateLeak(jsonlPath, step, fromProvider) {
  const fs = require('fs');
  if (!fs.existsSync(jsonlPath)) return { passed: true, firstEntries: 0, violations: [] };
  const exclusive = fromProviderExclusiveFields(fromProvider);

  // 收集当前 step 的所有 entries，按 anthropic / chat 分别取第一条
  const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
  const firstByKind = { anthropic: null, chat: null };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.step !== step) continue;
    const kind = classifyPath(entry.path);
    if (!kind || firstByKind[kind]) continue;
    firstByKind[kind] = entry;
  }

  const violations = [];
  let firstEntries = 0;
  for (const kind of ['anthropic', 'chat']) {
    const entry = firstByKind[kind];
    if (!entry) continue;
    firstEntries++;
    const body = entry.body && typeof entry.body === 'object' ? entry.body : {};
    for (const field of exclusive[kind]) {
      const actual = getField(body, field);
      if (actual !== undefined) {
        violations.push({
          rule: 'state-leak',
          field,
          reason: `from-provider (${fromProvider.id}) 专属字段残留在切换后首请求 (${kind} path)`,
          actual,
          step,
          path: entry.path,
        });
      }
    }
  }

  return { passed: violations.length === 0, firstEntries, violations };
}

module.exports = {
  expectedFields, assertEntry, assertCapture, classifyPath, getField,
  fromProviderExclusiveFields, assertStateLeak,
};
