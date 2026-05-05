# TEST_REPORT（V0.2）

## 1. 结果摘要
- 日期：2026-05-05
- PRD：/Users/yunshu/Documents/projects/deepseek/docs/prd/PRD-002-v0.2.md
- 结论：PASS（自动化部分），人工验证清单待跑

## 2. 执行命令与结果
- `npm test`
  - result：48 passed, 0 failed
- `for f in cli.js proxy/proxy.js src/*.js test.js; do node --check "$f" || exit 1; done`
  - result：passed
- `npm pack --dry-run`
  - result：passed，tarball 包含 16 个文件

## 3. 分层覆盖结果
- Unit：13/13
- Integration — Anthropic：5/5
- Integration — Codex Responses（v0.2 新）：14/14
- 其他（v0.1 留存）：16/16

## 4. v0.2 关键修复对应用例

| PRD §／Bug 编号 | 用例 | 通过 |
|---|---|---|
| PRD §3.1 / A1 | UT-06/07/08：codex-patcher 只接管 default profile，不动顶层 | ✅ |
| 调研 N1 | IT-07：Chat Completions 路径用 `reasoning_effort`，不发 thinking/output_config | ✅ |
| 调研 N1 | IT-08：思考关闭时 `reasoning_effort='minimal'` | ✅ |
| P0#1 | IT-09/10/11：function_call_output / function_call input 翻译；对象 output stringify | ✅ |
| P0#2 | IT-12：function_call item id == call_id，都以 `call_` 前缀 | ✅ |
| P0#3 | IT-16/17：tool args 真流式，每个上游 chunk 一个 delta | ✅ |
| P0#4 | IT-14/15：reasoning 是独立 output_item，6 步序列完整 | ✅ |
| 调研 Q10 | IT-13：`function_call_arguments.done` 不携带 `name` | ✅ |
| P2#9 | UT-02/UT-11：BASE_URL/base_url 使用 `127.0.0.1` 而非 `localhost` | ✅ |

## 5. 失败用例
- 无

## 5.1 诊断日志（v0.2 新增）

代理日志路径：`/tmp/deepseek-claude-proxy.log`

每次请求结束记录一行诊断信息，可一眼判断思考是否真的启用：

- **Codex 路径**：`RESPONSES_DONE id=xxx effort=max thinking=Y(N chars) text=N chars tools=N usage=in/out Nms`
- **Claude Code 路径**：`MSG_DONE model=xxx thinking=Y(N chars) text=N chars stream=true usage=in/out Nms`

`thinking=Y(N chars)` 且 N > 0 表示 DeepSeek 真的返回了思考内容；`thinking=N` 表示请求里 effort 字段虽然发了，但 DeepSeek 没启用思考——这是 v0.2 修复 `output_config.effort → reasoning_effort` 之前可能存在的隐藏故障，现在能直接观测到。

查看命令：
```bash
tail -f /tmp/deepseek-claude-proxy.log | grep -E "RESPONSES_DONE|MSG_DONE"
```

## 6. 剩余风险（必须人工补测）
- **HV-01**：真实 Codex CLI + DeepSeek 普通对话，token 逐字输出（验证 reasoning + message 在 Codex 里渲染正常）
- **HV-02**：真实 Codex 工具调用，验证 tool args 流式渲染 + call_id 串联回传
- **HV-03**：抓包确认 DeepSeek 流式 `delta.tool_calls` chunk shape（PRD §3.2.6.c flag 的风险）
  - 若 DeepSeek 流式不发 `delta.tool_calls`，需要补 fallback 路径：检测 `finish_reason='tool_calls'` 且累积 args 为空 → 重发非流式请求拿完整 tool_calls。当前代码已加日志检测但未实现 fallback
- **HV-04**：v0.1 升级路径（已有 `[profiles.deepseek]`）开关验证
- **HV-05**：关闭代理后顶层 key 不被改动（A1 修复确认）
- **HV-06**：逃生通道 `codex -p openai` 仍可用
- **HV-07**：macOS 13+ LaunchAgent `bootstrap` 真实开机自启
- **HV-08**：Claude Code 长流式会话冒烟（v0.1 透传路径未变，但回归验证）

## 7. 发布门禁
- 自动化门禁：通过
- 人工验证门禁：**未跑**，建议在打 v0.2 release 前完成 HV-01/HV-02/HV-03 三项核心
- 最终决策：自动化 PASS，待人工补测后整体 release
