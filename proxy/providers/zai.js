/**
 * 智谱 provider 定义
 *
 * 负责：
 * - 声明智谱大陆版默认 endpoint、模型与能力
 * - 归一化智谱 provider 配置
 * - 作为 v0.5 第二 provider 的 runtime adapter 元数据
 *
 * @module proxy/providers/zai
 */

const gateway = require('../gateway');

const DEFAULT_MODEL = 'glm-5.1';
const DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  chatPath: '/chat/completions',
  anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
};

/**
 * 补齐智谱 provider 配置默认值
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

module.exports = gateway.attachAdapter({
  id: 'zai',
  displayName: '智谱 BigModel',
  defaultModel: DEFAULT_MODEL,
  models: [
    { id: 'glm-5.1', label: 'glm-5.1（旗舰，强制思考）', hint: '推荐' },
    { id: 'glm-5', label: 'glm-5（长程任务）', hint: 'Agentic' },
    { id: 'glm-5-turbo', label: 'glm-5-turbo（快速均衡）', hint: 'Turbo' },
    { id: 'glm-4.7', label: 'glm-4.7（代码/工具调用）', hint: 'Stable' },
    { id: 'glm-4.5-air', label: 'glm-4.5-air（轻量高速）' },
  ],
  defaults: DEFAULTS,
  capabilities: {
    claudeCode: 'anthropic_forward',
    codex: 'chat_bridge',
    openaiChat: true,
    openaiResponses: false,
    thinking: true,
    thinkingEffort: false,
    anthropicThinking: false,
    chatStreamOptions: false,
    preservedThinking: 'clear_thinking',
    toolStreamParam: 'tool_stream',
    reasoningStream: 'native',
    toolCallStreaming: true,
    parallelToolCalls: true,
  },
  normalizeConfig,
});
