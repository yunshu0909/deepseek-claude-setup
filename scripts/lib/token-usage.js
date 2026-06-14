/**
 * Token usage 报告汇总模块
 *
 * 负责：
 * - 从 gateway 日志解析 MSG_DONE / RESPONSES_DONE / CHAT_DONE 的 usage 片段
 * - 将 smoke、client E2E、Linux Hermes 的用量记录合并为统一 summary
 * - 保留 missing/partial usage 计数，避免把未知用量误当作 0
 *
 * @module scripts/lib/token-usage
 */

const { normalizeUsage } = require('../../proxy/usage');

function emptyTokenUsage() {
  return {
    version: 1,
    requests: 0,
    requestsWithUsage: 0,
    missingUsageCount: 0,
    partialUsageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    records: [],
  };
}

function compactTokenUsage(usage) {
  const summary = usage || emptyTokenUsage();
  return {
    version: 1,
    requests: summary.requests || 0,
    requestsWithUsage: summary.requestsWithUsage || 0,
    missingUsageCount: summary.missingUsageCount || 0,
    partialUsageCount: summary.partialUsageCount || 0,
    inputTokens: summary.inputTokens || 0,
    outputTokens: summary.outputTokens || 0,
    reasoningTokens: summary.reasoningTokens || 0,
    totalTokens: summary.totalTokens || 0,
  };
}

function addRecord(summary, input) {
  const usage = input.usage || normalizeUsage(input.rawUsage);
  const record = {
    source: input.source || 'gateway-log',
    client: input.client || null,
    caseName: input.caseName || null,
    path: input.path || null,
    providerId: input.providerId || null,
    model: input.model || null,
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    reasoningTokens: usage.reasoningTokens || 0,
    totalTokens: usage.totalTokens || 0,
    missingUsage: Boolean(usage.missingUsage),
    partialUsage: Boolean(usage.partialUsage || input.partialUsage),
  };
  summary.requests += 1;
  if (record.missingUsage) {
    summary.missingUsageCount += 1;
  } else {
    summary.requestsWithUsage += 1;
    summary.inputTokens += record.inputTokens;
    summary.outputTokens += record.outputTokens;
    summary.reasoningTokens += record.reasoningTokens;
    summary.totalTokens += record.totalTokens;
    if (record.partialUsage) summary.partialUsageCount += 1;
  }
  summary.records.push(record);
  return summary;
}

function parseLogUsage(value, partial) {
  if (!value || value === 'none') return normalizeUsage(null);
  const [input, output, total] = String(value).split('/');
  const raw = {
    inputTokens: input === '?' ? null : Number(input),
    outputTokens: output === '?' ? null : Number(output),
    totalTokens: total === undefined || total === '?' ? undefined : Number(total),
  };
  const normalized = normalizeUsage(raw);
  return {
    ...normalized,
    partialUsage: Boolean(partial || normalized.partialUsage),
  };
}

function lineField(line, field) {
  const match = String(line).match(new RegExp(`\\b${field}=([^\\s|]+)`));
  return match ? match[1] : null;
}

function classifyLine(line) {
  if (line.includes('MSG_DONE')) return { client: 'claude', path: '/v1/messages' };
  if (line.includes('RESPONSES_DONE')) return { client: 'codex', path: '/v1/responses' };
  if (line.includes('CHAT_DONE')) return { client: 'chat', path: '/v1/chat/completions' };
  return null;
}

/**
 * 从 gateway log 文本中解析 token usage。
 * @param {string} text - gateway log 片段。
 * @param {object} [defaults] - 默认 source/client/caseName/providerId/model。
 * @returns {object} token usage summary。
 */
function parseGatewayLogUsage(text, defaults = {}) {
  const summary = emptyTokenUsage();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const classified = classifyLine(line);
    if (!classified) continue;
    const usageMatch = line.match(/\busage=(none|[0-9?]+\/[0-9?]+(?:\/[0-9?]+)?)/);
    if (!usageMatch) continue;
    const usage = parseLogUsage(usageMatch[1], /\busage_partial=1\b/.test(line));
    const reasoningMatch = line.match(/\busage_reasoning=(\d+)\b/);
    if (reasoningMatch) usage.reasoningTokens = Number(reasoningMatch[1]);
    addRecord(summary, {
      usage,
      source: defaults.source,
      client: defaults.client || classified.client,
      caseName: defaults.caseName,
      path: defaults.path || classified.path,
      providerId: defaults.providerId,
      model: lineField(line, 'model') || defaults.model,
    });
  }
  return summary;
}

function mergeTokenUsage(items = []) {
  const summary = emptyTokenUsage();
  for (const item of items.flat().filter(Boolean)) {
    if (Array.isArray(item.records)) {
      for (const record of item.records) addRecord(summary, { ...record, usage: record });
    }
  }
  return summary;
}

module.exports = {
  addRecord,
  compactTokenUsage,
  emptyTokenUsage,
  mergeTokenUsage,
  parseGatewayLogUsage,
  parseLogUsage,
};
