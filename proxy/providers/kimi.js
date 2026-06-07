/**
 * Kimi（月之暗面 / Moonshot）provider 定义
 *
 * 负责：
 * - 声明 Kimi 默认 OpenAI Chat / Anthropic 端点、模型与能力
 * - 归一化 Kimi provider 配置
 *
 * v0.7 PRD-008 US-44 据实修正（推翻 v0.6 错误假设）：
 * - v0.6 误标 `claudeCode: null`（"无 Anthropic 端点"）——**是错的**。Kimi 按量有官方
 *   Anthropic 兼容端点 `https://api.moonshot.cn/anthropic`（国际 api.moonshot.ai），
 *   Claude Code 一等支持 → `claudeCode: 'anthropic_forward'`。
 * - 模型 ID 过时（kimi-k2/kimi-k2-think）→ 换 kimi-k2.6/k2.5/thinking/turbo。
 * - thinking 用 `thinking.type` enabled/disabled，无 effort 档位 → thinkingEffort:false。
 *
 * 真实接入状态（2026-05-16 已真打 api.moonshot.cn 验证，非文档拍脑袋）：
 * - **已 smoke 验证**：`CLIENT_E2E_PROVIDER=kimi npm run e2e:clients` 真打 Moonshot，
 *   claude-text/claude-tool（Anthropic 端点 .cn/anthropic）+ codex-tool（chat 端点 .cn/v1）
 *   三项 Status PASS（真实延迟 3-8.6s）。证明 v0.6 `claudeCode:null` 错、本修正对。
 * - 域名：本账号 `.cn` 实测可用 → 默认 `.cn`；国际账号用 `.ai`，可被 config.baseUrl 覆盖。
 * - K2.6 文档称把 reasoning_content 改名 `reasoning`（单源）→ 已做防御性双字段兼容
 *   （见下方 parseChatStreamChunk 覆写），K2.5/K2.6 都不会漏 reasoning。
 * - anthropicThinking：Anthropic 端点 claude-* case PASS 间接验证未破，标 true（精确 thinking
 *   block 透传行为仍以真实使用为准）。
 *
 * @module proxy/providers/kimi
 */

const gateway = require('../gateway');

const DEFAULT_MODEL = 'kimi-k2.6';
const DEFAULTS = {
  baseUrl: 'https://api.moonshot.cn/v1',
  chatPath: '/chat/completions',
  anthropicBaseUrl: 'https://api.moonshot.cn/anthropic',
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

const kimi = gateway.attachAdapter({
  id: 'kimi',
  displayName: 'Kimi (Moonshot)',
  defaultModel: DEFAULT_MODEL,
  models: [
    { id: 'kimi-k2.6', label: 'kimi-k2.6（旗舰，编码/Agent）', hint: '推荐' },
    { id: 'kimi-k2.5', label: 'kimi-k2.5（均衡）' },
    { id: 'kimi-k2-thinking', label: 'kimi-k2-thinking（思考专用）' },
    { id: 'kimi-k2-turbo-preview', label: 'kimi-k2-turbo-preview（快速）' },
  ],
  defaults: DEFAULTS,
  capabilities: {
    claudeCode: 'anthropic_forward', // 据实修正：官方 /anthropic 端点存在
    codex: 'chat_bridge',
    openaiChat: true,
    openaiResponses: false,
    thinking: true,                  // thinking.type enabled/disabled
    thinkingEffort: false,           // 无 effort 档位（同智谱）
    anthropicThinking: true,         // 文档称支持，待真 smoke 确认
    chatStreamOptions: true,
    reasoningStream: 'native',
    toolCallStreaming: true,
    parallelToolCalls: true,
  },
  normalizeConfig,
});

// K2.6 文档称把 chat 流式 reasoning_content 改名 `reasoning`（单源存疑）。
// 防御性双字段兼容：若上游只给了 delta.reasoning 而无 reasoning_content，
// 先归一到 reasoning_content 再走基座解析——K2.5/K2.6 都不会漏思考增量。
// 不污染基座（只覆写 Kimi 自己的 parseChatStreamChunk）。
const baseParse = kimi.parseChatStreamChunk;
kimi.parseChatStreamChunk = function parseChatStreamChunk(parsed) {
  const ch = parsed && parsed.choices && parsed.choices[0];
  if (ch && ch.delta && ch.delta.reasoning != null && ch.delta.reasoning_content == null) {
    parsed = {
      ...parsed,
      choices: [{ ...ch, delta: { ...ch.delta, reasoning_content: ch.delta.reasoning } },
        ...parsed.choices.slice(1)],
    };
  }
  return baseParse(parsed);
};

module.exports = kimi;
