/**
 * Provider Gateway 内部协议与中立基座
 *
 * 负责：
 * - 定义 provider-neutral 的 GatewayRequest / GatewayEvent / CanonicalConversation 最小结构
 * - 提供 endpoint URL 解析等中立工具（不含任何 provider 专用字段）
 * - 提供 capability 驱动的 canonical 实现（buildChatExtras / parseChatStreamDelta /
 *   anthropicMutate），供各 provider adapter 委托——这些逻辑由 provider.capabilities 决定，
 *   与具体 provider 无关，因此集中一份放在基座，既不散落进 server 核心，也不在每个
 *   provider 文件里重复。
 *
 * 设计约束（PRD-005-R STR 门禁）：
 * - 本模块不出现 provider id 分支（不写 if provider==='deepseek'）；行为只由传入的
 *   capabilities/defaults 决定。
 * - 本模块不做网络 IO（transport 留在 server/client 核心）。
 *
 * @module proxy/gateway
 */

/**
 * GatewayEvent：provider SSE chunk 被 adapter 归一后的中立事件。
 * client（如 Codex Responses 发射器）只消费 GatewayEvent，不直接解析 provider SSE。
 *
 * kind 取值：
 * - 'reasoning'  { kind, text }                思考增量
 * - 'text'       { kind, text }                正文增量
 * - 'tool_call'  { kind, index, id, name, argsDelta }  工具调用增量（按 index 累积）
 * - 'usage'      { kind, usage }               token 用量
 * - 'finish'     { kind, reason }              finish_reason
 *
 * @typedef {{kind:string,[k:string]:*}} GatewayEvent
 */

/**
 * GatewayRequest：client 把客户端输入归一后的 provider-neutral 请求意图。
 * adapter 负责把它 lower 成具体 provider 的上游请求体。
 *
 * 最小结构：
 *   { model, conversation:CanonicalConversation, tools, thinking, effort, stream, source, maxOutputTokens }
 *
 * @typedef {{model:string,conversation:object,tools:(object[]|undefined),
 *   thinking:string,effort:string,stream:boolean,source:string,maxOutputTokens:number|undefined}} GatewayRequest
 */

/**
 * CanonicalConversation：provider-neutral 会话载荷。
 * 当前最小实现直接承载已归一的 Chat messages（codex-input 已完成 provider-neutral 归一，
 * 未提前写 provider 专属字段）。保留 wrapper 以便后续 provider 需要不同 lower 时扩展。
 *
 * @typedef {{messages:object[]}} CanonicalConversation
 */

function makeGatewayRequest({ model, messages, tools, thinking, effort, stream, source, maxOutputTokens }) {
  return {
    model,
    conversation: { messages },
    tools,
    thinking,
    effort,
    stream: stream !== false,
    source,
    maxOutputTokens,
  };
}

// -------- 中立 URL 工具（不含 provider 专用字段） --------

function endpointFromUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'http:' ? 80 : 443),
    pathname,
  };
}

function joinPath(prefix, suffix) {
  const left = (prefix || '').replace(/\/$/, '');
  const right = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${left}${right}`;
}

function legacyEnvTarget(pathPrefix, suffix) {
  if (!process.env.DEEPSEEK_CLAUDE_TARGET_HOST) return null;
  return {
    protocol: process.env.DEEPSEEK_CLAUDE_TARGET_PROTOCOL || 'https:',
    hostname: process.env.DEEPSEEK_CLAUDE_TARGET_HOST,
    port: process.env.DEEPSEEK_CLAUDE_TARGET_PORT ? Number(process.env.DEEPSEEK_CLAUDE_TARGET_PORT) : 443,
    path: joinPath(pathPrefix, suffix),
  };
}

function normalizeEffort(effort) {
  if (effort === 'max' || effort === 'xhigh') return 'max';
  return 'high';
}

function normalizeThinking(thinking) {
  return thinking === 'disabled' ? 'disabled' : 'enabled';
}

/**
 * 解析 Chat Completions 上游 target（endpoint 来自 provider 配置，无硬编码默认 URL）
 * @param {object} providerConfig - 归一后的 provider 配置（baseUrl 已由 normalizeConfig 补默认）
 * @param {string} fallbackBaseUrl - provider.defaults.baseUrl（兜底，不在 server 核心写死）
 */
function chatTarget(providerConfig, fallbackBaseUrl) {
  const chatPath = providerConfig.chatPath || '/chat/completions';
  const legacy = legacyEnvTarget(process.env.DEEPSEEK_CLAUDE_OPENAI_TARGET_PREFIX || '', chatPath);
  if (legacy) return legacy;
  const endpoint = endpointFromUrl(providerConfig.baseUrl || fallbackBaseUrl);
  return { ...endpoint, path: joinPath(endpoint.pathname, chatPath) };
}

/**
 * 解析 Anthropic 上游 target
 */
function anthropicTarget(providerConfig, fallbackAnthropicBaseUrl, requestUrl) {
  const legacy = legacyEnvTarget(process.env.DEEPSEEK_CLAUDE_TARGET_PREFIX || '/anthropic', requestUrl);
  if (legacy) return legacy;
  const endpoint = endpointFromUrl(providerConfig.anthropicBaseUrl || fallbackAnthropicBaseUrl);
  return { ...endpoint, path: joinPath(endpoint.pathname, requestUrl) };
}

// -------- capability 驱动的 canonical 实现（行为只由 capabilities 决定） --------

/**
 * 构造 Chat Completions 的 provider 扩展字段。
 *
 * 行为与 v0.5 proxy.js `chatProviderOptions` 字节等价——只是从 server 核心搬到基座，
 * 由 capabilities 驱动，不含任何 provider id 判断。
 *
 * @param {object} caps - provider.capabilities
 * @param {object} args - { messages, tools, thinking, effort }
 *   thinking: 'enabled' | 'disabled' | 'unsupported'
 *   effort: 已 normalize 的 'max' | 'high'
 * @returns {object} 合并进 Chat 请求体的扩展字段
 */
function buildChatExtras(caps, { messages, tools, thinking, effort, stream }) {
  const options = {};
  if (stream !== false && caps.chatStreamOptions !== false) options.stream_options = { include_usage: true };
  if (thinking !== 'unsupported') {
    options.thinking = { type: thinking };
    if (thinking === 'enabled' && caps.preservedThinking === 'clear_thinking' && messages.some(m => m.reasoning_content)) {
      options.thinking.clear_thinking = false;
    }
  }
  if (thinking === 'enabled' && caps.thinkingEffort !== false) {
    options.reasoning_effort = effort;
  }
  if (tools && caps.toolStreamParam) options[caps.toolStreamParam] = true;
  return options;
}

/**
 * 把一条 Chat Completions SSE 的 parsed JSON 归一为 GatewayEvent[]。
 *
 * 字段映射（DeepSeek 类 Chat provider，含智谱/Kimi）与 v0.5 proxy.js 内联解析字节等价：
 * delta.reasoning_content → reasoning；delta.tool_calls → tool_call；delta.content → text。
 * 后续 provider 若字段名不同（如 Kimi K2.6 用 reasoning），在其 adapter 覆写此函数即可。
 *
 * @param {object} parsed - 一条 data: JSON
 * @returns {GatewayEvent[]}
 */
function parseChatStreamDelta(parsed) {
  const events = [];
  if (parsed.usage) events.push({ kind: 'usage', usage: parsed.usage });
  const choice = parsed.choices?.[0];
  if (!choice) return events;
  const delta = choice.delta || {};

  if (delta.reasoning_content) {
    events.push({ kind: 'reasoning', text: delta.reasoning_content });
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      events.push({
        kind: 'tool_call',
        index: typeof tc.index === 'number' ? tc.index : 0,
        id: tc.id,
        name: tc.function?.name,
        argsDelta: tc.function?.arguments,
      });
    }
  }
  if (delta.content) {
    events.push({ kind: 'text', text: delta.content });
  }
  if (choice.finish_reason) {
    events.push({ kind: 'finish', reason: choice.finish_reason });
  }
  return events;
}

/**
 * 对 Anthropic Messages 请求体做 capability 驱动的 mutation（行为与 v0.5 proxy.js 等价）。
 * @param {object} payload - 原始 Anthropic 请求体（原地修改）
 * @param {object} caps - provider.capabilities
 * @param {object} args - { model, thinking, effort }（thinking: enabled|disabled|unsupported）
 * @returns {object} 同一 payload（已 mutate）
 */
function anthropicMutate(payload, caps, { model, thinking, effort }) {
  const anthropicThinking = thinking !== 'unsupported' && caps.anthropicThinking !== false;
  payload.model = model;
  if (anthropicThinking) {
    payload.thinking = { ...(payload.thinking || {}), type: thinking };
  } else {
    delete payload.thinking;
  }
  if (thinking === 'enabled' && anthropicThinking && caps.thinkingEffort !== false) {
    payload.output_config = { ...(payload.output_config || {}), effort };
  } else {
    delete payload.output_config;
  }
  return payload;
}

/**
 * 给一个 provider 定义挂上标准 adapter 接口（PRD-005 §3.3 US-23）。
 *
 * 注入三个方法，全部委托基座 capability 驱动实现——provider 文件因此保持"只声明
 * 元数据"，不重复逻辑、不做网络 IO（满足 STR-3/STR-5）。后续某 provider 行为特殊时
 * 可在其文件内覆写对应方法。
 *
 * @param {object} def - provider 定义（须含 capabilities + defaults）
 * @returns {object} 同一 def，已挂载 buildChatRequestSpec/parseChatStreamChunk/buildAnthropicRequestSpec
 */
function attachAdapter(def) {
  const caps = def.capabilities || {};
  const defaults = def.defaults || {};

  /**
   * 把 GatewayRequest lower 成该 provider 的 Chat Completions 上游请求规格
   * @returns {{target:object, body:object, apiKey:string}}
   */
  def.buildChatRequestSpec = function buildChatRequestSpec(gatewayRequest, providerConfig) {
    const { model, conversation, tools, thinking, effort } = gatewayRequest;
    const messages = conversation.messages;
    const body = { model, messages, stream: gatewayRequest.stream !== false };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    Object.assign(body, buildChatExtras(caps, { messages, tools, thinking, effort, stream: gatewayRequest.stream }));
    return {
      target: chatTarget(providerConfig, defaults.baseUrl),
      body,
      apiKey: providerConfig.apiKey,
    };
  };

  /**
   * 把一条 Chat SSE parsed JSON 归一为 GatewayEvent[]
   * @returns {GatewayEvent[]}
   */
  def.parseChatStreamChunk = function parseChatStreamChunk(parsed) {
    return parseChatStreamDelta(parsed);
  };

  /**
   * 对 Anthropic 请求体做 provider mutation，并给出上游 target
   * @returns {{target:object, payload:object}}
   */
  def.buildAnthropicRequestSpec = function buildAnthropicRequestSpec(payload, providerConfig, runtime) {
    anthropicMutate(payload, caps, runtime);
    return {
      target: anthropicTarget(providerConfig, defaults.anthropicBaseUrl, runtime.requestUrl),
      payload,
    };
  };

  return def;
}

module.exports = {
  makeGatewayRequest,
  endpointFromUrl, joinPath, legacyEnvTarget,
  normalizeEffort, normalizeThinking,
  chatTarget, anthropicTarget,
  buildChatExtras, parseChatStreamDelta, anthropicMutate,
  attachAdapter,
};
