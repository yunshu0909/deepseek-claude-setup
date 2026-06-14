/**
 * Token usage 归一模块
 *
 * 负责：
 * - 将 Anthropic / OpenAI Chat / Responses 常见 usage 字段归一为统一结构
 * - 为 gateway 诊断日志生成稳定的 usage=... 片段
 * - 避免 proxy runtime 依赖 scripts/ 测试目录
 *
 * @module proxy/usage
 */

function readPath(obj, dottedPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const part of dottedPath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstNumber(obj, paths) {
  for (const path of paths) {
    const value = readPath(obj, path);
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
  }
  return null;
}

/**
 * 归一 provider usage 对象。
 * @param {object|null|undefined} raw - provider 返回的 usage 对象。
 * @returns {object} 统一 token usage。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      missingUsage: true,
      partialUsage: false,
    };
  }
  if (raw.missingUsage === true) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      missingUsage: true,
      partialUsage: false,
    };
  }

  const inputTokens = firstNumber(raw, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
  ]);
  const outputTokens = firstNumber(raw, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ]);
  const reasoningTokens = firstNumber(raw, [
    'reasoning_tokens',
    'reasoningTokens',
    'output_tokens_details.reasoning_tokens',
    'outputTokensDetails.reasoningTokens',
    'completion_tokens_details.reasoning_tokens',
    'completionTokensDetails.reasoningTokens',
  ]);
  const totalTokens = firstNumber(raw, [
    'total_tokens',
    'totalTokens',
  ]);

  const hasAny = inputTokens !== null || outputTokens !== null || reasoningTokens !== null || totalTokens !== null;
  if (!hasAny) return normalizeUsage(null);

  const derivedTotal = totalTokens !== null
    ? totalTokens
    : (inputTokens || 0) + (outputTokens || 0);
  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    reasoningTokens: reasoningTokens || 0,
    totalTokens: derivedTotal,
    missingUsage: false,
    partialUsage: inputTokens === null || outputTokens === null,
  };
}

/**
 * 转成日志片段，供测试 parser 读取。
 * @param {object|null|undefined} usage - normalizeUsage 输出。
 * @returns {string} usage=... 日志片段。
 */
function formatUsageForLog(usage) {
  const normalized = normalizeUsage(usage);
  if (normalized.missingUsage) return 'usage=none';
  const parts = [
    `usage=${normalized.inputTokens}/${normalized.outputTokens}/${normalized.totalTokens}`,
  ];
  if (normalized.reasoningTokens > 0) parts.push(`usage_reasoning=${normalized.reasoningTokens}`);
  if (normalized.partialUsage) parts.push('usage_partial=1');
  return parts.join(' ');
}

/**
 * 转成 OpenAI Responses 响应体中的 usage 形状。
 * @param {object|null|undefined} usage - normalizeUsage 输出。
 * @returns {object|null} Responses usage。
 */
function toResponsesUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (normalized.missingUsage) return null;
  const responseUsage = {
    input_tokens: normalized.inputTokens,
    output_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
  };
  if (normalized.reasoningTokens > 0) responseUsage.reasoning_tokens = normalized.reasoningTokens;
  return responseUsage;
}

module.exports = {
  formatUsageForLog,
  normalizeUsage,
  toResponsesUsage,
};
