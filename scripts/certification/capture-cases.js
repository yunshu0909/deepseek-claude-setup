/**
 * Capture 用例汇总模块
 *
 * 负责：
 * - 将 capture runner 的 capability-aware step 结果映射回 PRD-015 TC-024~TC-031
 * - 按 provider capability 判断 effort/thinking 字段应存在还是应缺席
 * - 保持 certify-provider 主入口不继续膨胀
 *
 * @module scripts/certification/capture-cases
 */

const providerRegistry = require('../../proxy/providers');
const { STATUSES } = require('./provider-profiles');

function captureBody(capture, stepName) {
  return capture.steps.find(step => step.step === stepName)?.requests?.[0]?.body || {};
}

function captureStep(capture, stepName) {
  return capture.steps.find(step => step.step === stepName) || {};
}

function captureStepOk(capture, stepName) {
  const step = captureStep(capture, stepName);
  return step.status === STATUSES.PASS && Array.isArray(step.violations) && step.violations.length === 0;
}

function missingField(body, field) {
  return body && body[field] === undefined;
}

function appendCase({ profile, testCases, resultFor, id, passed, message, assertions, evidenceRef }) {
  testCases.push(resultFor(profile, id, {
    status: passed ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: passed ? null : 'gateway',
    message,
    positiveAssertions: assertions,
    evidenceRefs: evidenceRef ? [evidenceRef] : [],
  }));
}

/**
 * 追加 TC-024~TC-031 capture 认证结果。
 * @param {object} args - { profile, testCases, capture, evidenceRef, resultFor }。
 * @returns {void}
 */
function appendCaptureCases({ profile, testCases, capture, evidenceRef, resultFor }) {
  const providerDef = providerRegistry.getProvider(profile.id);
  const caps = providerDef?.capabilities || {};
  const supportsEffort = caps.thinkingEffort !== false;
  const supportsAnthropicThinking = caps.thinking !== false && caps.anthropicThinking !== false;
  const ch = captureBody(capture, 'claude:pro:on:high');
  const cm = captureBody(capture, 'claude:pro:on:max');
  const cf = captureBody(capture, 'claude:flash:off:-');
  const dx = captureBody(capture, 'codex:pro:on:max');
  const df = captureBody(capture, 'codex:flash:off:-');
  const dh = captureBody(capture, 'codex:pro:on:high');
  const chOk = captureStepOk(capture, 'claude:pro:on:high');
  const cmOk = captureStepOk(capture, 'claude:pro:on:max');
  const cfOk = captureStepOk(capture, 'claude:flash:off:-');
  const dxOk = captureStepOk(capture, 'codex:pro:on:max');
  const dfOk = captureStepOk(capture, 'codex:flash:off:-');
  const dhOk = captureStepOk(capture, 'codex:pro:on:high');
  const common = { profile, testCases, resultFor, evidenceRef };

  appendCase({ ...common, id: 'TC-024', passed: chOk && dxOk && ch.model === profile.defaultModel && dx.model === profile.defaultModel, message: 'Pro capture model fields match', assertions: 2 });
  appendCase({
    ...common,
    id: 'TC-025',
    passed: cfOk && dfOk
      && captureStep(capture, 'claude:flash:off:-').switchedConfigRoot === true
      && captureStep(capture, 'codex:flash:off:-').switchedConfigRoot === true
      && cf.model === profile.flashModel
      && df.model === profile.flashModel,
    message: 'First Flash requests after in-run gateway restart contain no Pro model',
    assertions: 4,
  });
  appendCase({
    ...common,
    id: 'TC-026',
    passed: chOk && cmOk && (supportsAnthropicThinking ? ch.thinking?.type === 'enabled' && cm.thinking?.type === 'enabled' : missingField(ch, 'thinking') && missingField(cm, 'thinking')),
    message: 'Anthropic thinking fields match provider capability',
    assertions: 2,
  });
  appendCase({
    ...common,
    id: 'TC-027',
    passed: chOk && cmOk && (supportsEffort && supportsAnthropicThinking ? ch.output_config?.effort === 'high' && cm.output_config?.effort === 'max' : missingField(ch, 'output_config') && missingField(cm, 'output_config')),
    message: 'Anthropic effort fields match provider capability',
    assertions: 2,
  });
  appendCase({
    ...common,
    id: 'TC-028',
    passed: cfOk && (supportsAnthropicThinking ? cf.thinking?.type === 'disabled' : missingField(cf, 'thinking')) && missingField(cf, 'output_config'),
    message: 'Anthropic thinking off follows provider capability and removes output_config',
    assertions: 2,
  });
  appendCase({
    ...common,
    id: 'TC-029',
    passed: dxOk && dhOk && (supportsEffort ? dx.reasoning_effort === 'max' && dh.reasoning_effort === 'high' : missingField(dx, 'reasoning_effort') && missingField(dh, 'reasoning_effort')),
    message: 'Responses thinking-on effort fields match provider capability',
    assertions: 2,
  });
  appendCase({ ...common, id: 'TC-030', passed: dfOk && df.thinking?.type === 'disabled' && missingField(df, 'reasoning_effort'), message: 'Responses thinking off removes effort', assertions: 2 });
  appendCase({
    ...common,
    id: 'TC-031',
    passed: dxOk && dhOk && dx.model === dh.model && dx.thinking?.type === dh.thinking?.type && (supportsEffort ? dx.reasoning_effort !== dh.reasoning_effort : missingField(dx, 'reasoning_effort') && missingField(dh, 'reasoning_effort')),
    message: 'High/max config changes only the provider-supported effort field',
    assertions: 3,
  });
}

module.exports = { appendCaptureCases };
