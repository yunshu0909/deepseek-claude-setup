/**
 * DeepSeek provider 定义
 *
 * 负责：
 * - 声明 DeepSeek 的默认 endpoint、模型与能力
 * - 归一化 DeepSeek provider 配置
 * - 为 Provider Gateway 提供第一个 runtime adapter 元数据
 *
 * @module proxy/providers/deepseek
 */

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  chatPath: '/chat/completions',
  anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
};

/**
 * 补齐 DeepSeek provider 配置默认值
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
  id: 'deepseek',
  displayName: 'DeepSeek',
  models: [
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  ],
  defaults: DEFAULTS,
  capabilities: {
    claudeCode: 'anthropic_forward',
    codex: 'chat_bridge',
    openaiChat: true,
    openaiResponses: false,
    thinking: true,
    reasoningStream: 'native',
    toolCallStreaming: true,
    parallelToolCalls: true,
  },
  normalizeConfig,
};
