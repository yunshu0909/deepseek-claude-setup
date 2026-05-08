/**
 * Z.AI provider 定义
 *
 * 负责：
 * - 声明 Z.AI 的默认 endpoint、模型与能力
 * - 归一化 Z.AI provider 配置
 * - 作为 v0.5 第二 provider 的 runtime adapter 元数据
 *
 * @module proxy/providers/zai
 */

const DEFAULT_MODEL = 'glm-5.1';
const DEFAULTS = {
  baseUrl: 'https://api.z.ai/api/paas/v4',
  chatPath: '/chat/completions',
  anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
};

/**
 * 补齐 Z.AI provider 配置默认值
 * @param {object} config - 原始 provider 配置
 * @returns {object} 补齐默认 endpoint/model 后的配置
 */
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
  id: 'zai',
  displayName: 'Z.AI / 智谱',
  models: [
    { id: 'glm-5.1', label: 'glm-5.1（旗舰）', hint: '推荐' },
    { id: 'glm-5-turbo', label: 'glm-5-turbo（均衡）', hint: 'Turbo' },
    { id: 'glm-4.6', label: 'glm-4.6（通用）', hint: 'Stable' },
  ],
  defaults: DEFAULTS,
  capabilities: {
    claudeCode: 'anthropic_forward',
    codex: 'chat_bridge',
    openaiChat: true,
    openaiResponses: false,
    thinking: false,
    reasoningStream: 'unknown',
    toolCallStreaming: true,
    parallelToolCalls: true,
  },
  normalizeConfig,
};
