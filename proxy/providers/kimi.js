/**
 * Kimi（月之暗面 / Moonshot）provider 定义
 *
 * 负责：
 * - 声明 Kimi 默认 OpenAI Chat 端点、模型与能力
 * - 归一化 Kimi provider 配置
 *
 * 作为 PRD-007 US-49 模板化复利验证的对象：本文件 + index.js 注册 + client-e2e API_KEY_ENV 映射
 * 三处改动后，无需改 runner / capability-asserts / SEQUENCE 引擎，新 provider 即可被矩阵自动覆盖。
 *
 * 注意：本配置基于公开文档的保守假设，实际接入前应跟智谱一样做一轮真实 smoke。
 * - 无 Anthropic 兼容端点（claudeCode: null）→ runner 会自动 SKIP claude case
 * - Chat path 上认为支持 thinking 但不支持 effort 调节（跟智谱类似）
 * - 未声明 preservedThinking / toolStreamParam，因此 capability-asserts 会把这两个字段写进 mustNotHave
 *
 * @module proxy/providers/kimi
 */

const DEFAULT_MODEL = 'kimi-k2';
const DEFAULTS = {
  baseUrl: 'https://api.moonshot.cn/v1',
  chatPath: '/chat/completions',
  anthropicBaseUrl: '', // Kimi 暂无 Anthropic 兼容端点
};

function normalizeConfig(config = {}) {
  return {
    apiKey: config.apiKey,
    model: config.model || DEFAULT_MODEL,
    baseUrl: config.baseUrl || DEFAULTS.baseUrl,
    chatPath: config.chatPath || DEFAULTS.chatPath,
    anthropicBaseUrl: config.anthropicBaseUrl || DEFAULTS.anthropicBaseUrl,
  };
}

module.exports = {
  id: 'kimi',
  displayName: 'Kimi (Moonshot)',
  models: [
    { id: 'kimi-k2', label: 'kimi-k2（通用）' },
    { id: 'kimi-k2-think', label: 'kimi-k2-think（思考模式）' },
  ],
  defaults: DEFAULTS,
  capabilities: {
    claudeCode: null,         // 无 Anthropic 端点 → Claude case 自动 SKIPPED_UNSUPPORTED
    codex: 'chat_bridge',     // 支持 OpenAI Chat
    openaiChat: true,
    openaiResponses: false,
    thinking: true,           // 假设支持 thinking 切换（k2-think 系列）
    thinkingEffort: false,    // 假设不支持 effort 强度调节
    anthropicThinking: false, // 无 Anthropic 端点，自动 false
    chatStreamOptions: true,
    toolCallStreaming: true,
    parallelToolCalls: true,
  },
  normalizeConfig,
};
