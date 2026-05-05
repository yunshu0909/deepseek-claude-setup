# TEST_PLAN（V0.2）

## 1. 测试范围
- PRD：/Users/yunshu/Documents/projects/deepseek/docs/prd/PRD-002-v0.2.md
- 范围内（v0.2 新增/重做能力）：
  - Codex 无感接入（接管 `[profiles.default]`，不污染顶层 key）
  - Codex 真流式输出：reasoning / message / function_call 各为独立 output_item，严格走 6 步事件序列
  - Chat Completions 路径使用 `reasoning_effort`（不再用 `output_config.effort`，那是 Anthropic 路径专用）
  - `function_call_output` / `function_call` input 翻译：多轮工具调用上下文不丢
  - function_call item 的 `id` 与 `call_id` 强制相等且都用 `call_` 前缀
  - tool args 真流式：每个上游 chunk 触发一个 delta 事件，而非缓冲后一次性发
  - settings 与 codex config 中的代理地址改用 `127.0.0.1`（避免 IPv6 解析失败）
  - LaunchAgent 用 `bootstrap` 替代弃用的 `load`，保留 fallback 兼容老系统
- 非范围：
  - Codex 真实 API 长会话流式逐字渲染（人工验证）
  - DeepSeek 流式 `delta.tool_calls` chunk shape 真实抓包（人工验证 + Phase C）
  - macOS LaunchAgent 真实开机自启
  - 终端交互 UI 体验

## 2. 完成门槛
1. 计划内自动化用例全部通过
2. P0 用例通过率 100%
3. v0.1 既有用例不发生回归
4. 关键测试在临时目录中可重复执行，不污染真实 `~/.claude` / `~/.codex`

## 3. 用例清单

### Unit
- UT-01：`config-store` 可读写 `apiKey/model/effort`
- UT-02：`settings-patcher.patch(config)` 写入 Claude Code 所需 env，BASE_URL 用 `127.0.0.1`
- UT-03：`settings-patcher.restore()` 在多次 patch 后还原原始 settings
- UT-04：备份缺失时的兜底 restore 不会让 Claude Code 指向已停止的本地代理
- UT-05：思考模式关闭时 settings 不写入 `effortLevel`，并将 `alwaysThinkingEnabled=false`
- UT-06：`codex-patcher.patch` 只接管 `[profiles.default]`，原顶层 model 保留不动
- UT-07：原始无 `[profiles.default]` 时 patch 写入 `(none)` 标记，restore 后无 default profile
- UT-08：原始 `[profiles.default]` 值保存到 managed block 注释，restore 时还原
- UT-09：注释丢失时 restore fallback 到 `.deepseek-backup` 文件
- UT-10：`isPatched` 兼容 v0.1 旧 `[profiles.deepseek]` 格式
- UT-11：codex `base_url` 使用 `127.0.0.1` 不是 `localhost`

### Integration — 代理 Anthropic 透传路径
- IT-01：`/__health` 返回当前模型、thinking、effort
- IT-02：代理把 Anthropic 请求转发到 `/anthropic/v1/messages`，保留 query string
- IT-03：代理转发前覆盖 `model`、`thinking.type`、`output_config.effort`
- IT-04：代理使用保存的 DeepSeek API Key 设置上游鉴权头
- IT-05：思考模式关闭时 Anthropic 路径转发 `thinking.type=disabled` 且移除 `output_config`

### Integration — 代理 Codex Responses 路径（v0.2 重写）
- IT-06：代理接收 `/v1/responses` 并响应完整 SSE 事件流
- IT-07：Responses 请求转换为 DeepSeek `/chat/completions`，使用 `reasoning_effort`，不发 `thinking` / `output_config`
- IT-08：思考模式关闭时 `reasoning_effort='minimal'`，不发 `output_config`
- IT-09：`function_call_output` input 翻译为 `{role:'tool', tool_call_id, content}`
- IT-10：`function_call` input 翻译为 `{role:'assistant', tool_calls:[...]}`
- IT-11：`function_call_output` 中 `output` 是对象时 JSON.stringify 为字符串
- IT-12：function_call output_item 的 `id` 等于 `call_id`，且都以 `call_` 前缀
- IT-13：`function_call_arguments.done` 事件不携带 `name` 字段
- IT-14：reasoning 是独立 output_item（type=reasoning），与 message item 分离
- IT-15：reasoning item 严格走完整 6 步事件序列
- IT-16：tool args 真流式：每个上游 chunk 触发独立 `function_call_arguments.delta` 事件
- IT-17：tool args delta 拼接结果等于完整 arguments
- IT-18：非流式请求（`stream:false`）返回完整 JSON `response` 对象
- IT-19：上游 HTTP 错误触发 `response.failed` 事件

## 4. 执行顺序
1. Unit
2. Integration — Anthropic 路径
3. Integration — Codex 路径
4. 自动修复循环（最多 3 轮）

## 5. 输出产物
- TEST_REPORT.md
- 可复现命令：`npm test`

## 6. 人工验证清单（不在自动化范围）
- HV-01：真实 Codex CLI + DeepSeek 普通对话，token 逐字输出
- HV-02：真实 Codex 工具调用，验证 tool args 流式渲染、call_id 串联工具结果回传
- HV-03：DeepSeek 流式 `delta.tool_calls` 真实 chunk shape 抓包（PRD §3.2.6.c flag 的风险）
- HV-04：从 v0.1 升级路径（已有 `[profiles.deepseek]`）→ 升级后开启 Codex 接入 → `[profiles.default]` 生效
- HV-05：关闭代理时 Codex 配置自动还原，原顶层 key 不变
- HV-06：逃生通道：代理开启期间 `codex -p openai` 仍能临时回到 OpenAI
- HV-07：macOS LaunchAgent `bootstrap` 真实开机自启（在 macOS 13+ 测）
