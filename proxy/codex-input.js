/**
 * Codex input 翻译模块
 *
 * 负责：
 * - 将 OpenAI Responses input item 翻译为 Chat Completions messages
 * - 合并并行 function_call，保留 tool_call_id 契约
 * - 回传 DeepSeek 类 Chat provider 要求的 assistant reasoning_content
 *
 * @module proxy/codex-input
 */

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part.text || part.content || '').filter(Boolean).join('\n');
}

/**
 * 把 Codex Responses API 的 input 数组翻译成 OpenAI Chat Completions 的 messages
 *
 * @param {object} payload - Responses API 请求体
 * @returns {Array<object>} Chat Completions messages
 */
function responsesInputToMessages(payload) {
  const messages = [];
  if (payload.instructions) {
    messages.push({ role: 'system', content: payload.instructions });
  }

  let pendingReasoning = '';
  let lastReasoning = '';
  let pendingToolCalls = [];

  // DeepSeek 类 provider 要求含工具调用轮次中所有 assistant 行为回传 reasoning。
  function consumeReasoning() {
    if (pendingReasoning) {
      lastReasoning = pendingReasoning;
      const v = pendingReasoning;
      pendingReasoning = '';
      return v;
    }
    return lastReasoning;
  }

  function flushToolCalls() {
    if (pendingToolCalls.length === 0) return;
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls,
    };
    const reasoning = consumeReasoning();
    if (reasoning) msg.reasoning_content = reasoning;
    messages.push(msg);
    pendingToolCalls = [];
  }

  for (const item of payload.input || []) {
    if (item.type === 'reasoning') {
      const fromContent = (item.content || [])
        .filter(c => c.type === 'reasoning_text' || c.type === 'reasoning')
        .map(c => c.text || '')
        .join('');
      const fromSummary = (item.summary || [])
        .filter(c => c.type === 'summary_text')
        .map(c => c.text || '')
        .join('');
      pendingReasoning += fromContent || fromSummary;
      continue;
    }

    if (item.type === 'function_call') {
      const callId = item.call_id || item.id;
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
      continue;
    }

    flushToolCalls();

    if (item.type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      const text = contentToText(item.content);
      if (role === 'user') {
        pendingReasoning = '';
        lastReasoning = '';
        if (text) messages.push({ role: 'user', content: text });
        continue;
      }
      if (text) {
        const msg = { role, content: text };
        if (role === 'assistant') {
          const reasoning = consumeReasoning();
          if (reasoning) msg.reasoning_content = reasoning;
        }
        messages.push(msg);
      } else if (role === 'assistant') {
        const reasoning = consumeReasoning();
        if (reasoning) {
          messages.push({ role: 'assistant', content: null, reasoning_content: reasoning });
        }
      }
      continue;
    }

    if (item.type === 'function_call_output') {
      const tcId = item.call_id || item.tool_call_id || '';
      let content = '';
      if (item.output !== undefined) {
        content = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      } else if (item.content !== undefined) {
        content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
      }
      messages.push({ role: 'tool', tool_call_id: tcId, content });
    }
  }

  flushToolCalls();

  if (!messages.some(m => m.role === 'user' || m.role === 'tool')) {
    messages.push({ role: 'user', content: 'Continue.' });
  }
  return messages;
}

/**
 * 把 Responses API tools 翻译成 Chat Completions tools
 * @param {Array<object>|undefined} tools - Responses API 工具声明
 * @returns {Array<object>|undefined} Chat Completions 工具声明；没有可用函数时返回 undefined
 */
function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const functions = tools
    .filter(tool => tool.type === 'function' && tool.name)
    .map(tool => {
      const params = {};
      for (const [k, v] of Object.entries(tool.parameters || { type: 'object', properties: {} })) {
        if (k === 'additionalProperties' || k === 'strict') continue;
        params[k] = v;
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: params,
        },
      };
    });
  return functions.length ? functions : undefined;
}

module.exports = { responsesInputToMessages, responsesToolsToChatTools };
