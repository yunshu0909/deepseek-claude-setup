/**
 * Capture 断言模块
 *
 * 负责：
 * - 按 provider capabilities 生成 capture 期望
 * - 校验 gateway health 与上游 payload 是否匹配当前 provider/model/thinking/effort
 * - 输出可读 violation，避免 capture 假绿
 *
 * @module scripts/lib/capture-asserts
 */

function hasField(obj, dottedPath) {
  return getField(obj, dottedPath) !== undefined;
}

function getField(obj, dottedPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const part of dottedPath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function addViolation(violations, rule, message, details = {}) {
  violations.push({ rule, message, ...details });
}

function assertEqual(violations, rule, actual, expected, message) {
  if (actual !== expected) addViolation(violations, rule, message, { actual, expected });
  return actual === expected ? 1 : 0;
}

function assertAbsent(violations, rule, body, path, reason) {
  if (hasField(body, path)) {
    addViolation(violations, rule, `${path} must be absent: ${reason}`, { actual: getField(body, path) });
    return 0;
  }
  return 1;
}

function assertPresentValue(violations, rule, body, path, expected, reason) {
  const actual = getField(body, path);
  if (actual !== expected) {
    addViolation(violations, rule, `${path} mismatch: ${reason}`, { actual, expected });
    return 0;
  }
  return 1;
}

function expectedHealth(providerDef, step) {
  const caps = providerDef.capabilities || {};
  const thinking = caps.thinking === false ? 'unsupported' : step.thinking;
  return {
    provider: providerDef.id,
    model: step.model,
    thinking,
    effort: thinking === 'enabled' && caps.thinkingEffort !== false ? step.effort : null,
  };
}

function assertHealth(stepResult, providerDef, step, violations) {
  const expected = expectedHealth(providerDef, step);
  const health = stepResult.health || {};
  let assertions = 0;
  assertions += assertEqual(violations, 'health-provider', health.provider, expected.provider, 'health provider mismatch');
  assertions += assertEqual(violations, 'health-model', health.model, expected.model, 'health model mismatch');
  assertions += assertEqual(violations, 'health-thinking', health.thinking, expected.thinking, 'health thinking mismatch');
  assertions += assertEqual(violations, 'health-effort', health.effort ?? null, expected.effort, 'health effort mismatch');
  return assertions;
}

function assertAnthropicPayload(body, providerDef, step, violations) {
  const caps = providerDef.capabilities || {};
  let assertions = 0;
  assertions += assertEqual(violations, 'payload-model', body.model, step.model, 'payload model mismatch');

  if (caps.thinking === false || caps.anthropicThinking === false) {
    assertions += assertAbsent(violations, 'anthropic-thinking-absent', body, 'thinking', 'provider does not use Anthropic thinking');
    assertions += assertAbsent(violations, 'anthropic-output-config-absent', body, 'output_config', 'provider does not use Anthropic effort');
    return assertions;
  }

  assertions += assertPresentValue(violations, 'anthropic-thinking-type', body, 'thinking.type', step.thinking, 'Anthropic thinking state follows config');
  if (step.thinking === 'enabled' && caps.thinkingEffort !== false) {
    assertions += assertPresentValue(violations, 'anthropic-effort', body, 'output_config.effort', step.effort, 'provider supports effort tiers');
  } else {
    assertions += assertAbsent(violations, 'anthropic-effort-absent', body, 'output_config', 'thinking disabled or effort unsupported');
  }
  return assertions;
}

function assertChatPayload(body, providerDef, step, violations) {
  const caps = providerDef.capabilities || {};
  let assertions = 0;
  assertions += assertEqual(violations, 'payload-model', body.model, step.model, 'payload model mismatch');

  if (caps.thinking === false) {
    assertions += assertAbsent(violations, 'chat-thinking-absent', body, 'thinking', 'provider thinking=false');
    assertions += assertAbsent(violations, 'chat-effort-absent', body, 'reasoning_effort', 'provider thinking=false');
  } else {
    assertions += assertPresentValue(violations, 'chat-thinking-type', body, 'thinking.type', step.thinking, 'Chat thinking state follows config');
    if (step.thinking === 'enabled' && caps.thinkingEffort !== false) {
      assertions += assertPresentValue(violations, 'chat-effort', body, 'reasoning_effort', step.effort, 'provider supports effort tiers');
    } else {
      assertions += assertAbsent(violations, 'chat-effort-absent', body, 'reasoning_effort', 'thinking disabled or effort unsupported');
    }
  }

  if (Array.isArray(body.tools) && caps.toolStreamParam) {
    assertions += assertPresentValue(violations, 'chat-tool-stream', body, caps.toolStreamParam, true, 'provider declares tool stream parameter');
  } else if (!caps.toolStreamParam) {
    assertions += assertAbsent(violations, 'chat-tool-stream-absent', body, 'tool_stream', 'provider does not declare tool stream parameter');
  }

  if (!caps.preservedThinking) {
    assertions += assertAbsent(violations, 'chat-clear-thinking-absent', body, 'thinking.clear_thinking', 'provider does not preserve thinking with clear_thinking');
  }
  return assertions;
}

/**
 * 校验单个 capture step。
 * @param {object} stepResult - runner 单步结果。
 * @param {object} providerDef - provider adapter 定义。
 * @param {object} step - 解析后的 step。
 * @returns {{positiveAssertions:number, violations:object[]}}
 */
function assertCaptureStep(stepResult, providerDef, step) {
  const violations = [];
  let positiveAssertions = assertHealth(stepResult, providerDef, step, violations);
  const body = stepResult.requests?.[0]?.body;
  if (!body) {
    addViolation(violations, 'capture-missing-request', 'capture step did not record an upstream request');
    return { positiveAssertions, violations };
  }
  positiveAssertions += step.target === 'claude'
    ? assertAnthropicPayload(body, providerDef, step, violations)
    : assertChatPayload(body, providerDef, step, violations);
  return { positiveAssertions, violations };
}

module.exports = {
  assertCaptureStep,
  expectedHealth,
  getField,
};
