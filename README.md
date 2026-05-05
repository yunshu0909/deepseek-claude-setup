# DeepSeek × Claude Code / Codex 一键配置工具

让 Claude Code 和 OpenAI Codex CLI 透明使用 DeepSeek 模型，且**思考模式真的生效**。

---

## 解决两个真实痛点

### 1. Claude Code 接 DeepSeek，思考强度无效

Claude Code 的 `effortLevel` 映射到 Anthropic 协议的 `thinking.budget_tokens`，但 DeepSeek 的 Anthropic 兼容端点**忽略这个字段**——真正控制思考深度的是 `output_config.effort`。所以你设了"max effort"实际跑出来是默认强度。

**解法**：本地代理在请求里强制注入 `output_config.effort`，DeepSeek 才认。

### 2. Codex 接 DeepSeek，必须协议翻译 + 真流式

Codex 用的是 OpenAI Responses API（独立的 reasoning / message / function_call 事件流），DeepSeek 只有 OpenAI Chat Completions 端点（扁平的 `delta.content` 流）。中间需要双向翻译，且必须**逐 chunk 真流式**才能让 codex 渲染思考过程和工具调用 args 的逐字流。

**解法**：本地代理实现完整状态机翻译，逐字转发，零依赖。

---

## 一行命令使用

```bash
npx -y github:yunshu0909/deepseek-claude-setup
```

**首次运行**：拉到 GitHub 最新版，进配置向导（输入 DeepSeek API Key → 选模型 → 选思考模式 → 选思考深度），然后进主面板。

**已经装过的用户**：本工具会自动检测 `proxy.js` 升级并热加载（v1.3.6+）。但 `cli.js`（交互壳）受 npx 缓存影响。要强制拉最新 cli.js：

```bash
# 清 npx 缓存
rm -rf ~/.npm/_npx && npx -y github:yunshu0909/deepseek-claude-setup

# 或显式指定最新 tag
npx -y github:yunshu0909/deepseek-claude-setup#v1.3.7
```

---

## 主面板 4 个独立开关

```
Claude Code: ○ 未接入 / 🟢 已接入
Codex:       ○ 未接入 / 🟢 已接入 (直接 codex 即可使用)
代理:        ○ 未运行 / 🟢 127.0.0.1:17861
模型: deepseek-v4-pro  |  思考模式: 开启 (max)

🤖 开启/关闭 Claude Code 接入       — 改 ~/.claude/settings.json
⌘ 开启/关闭 Codex 接入              — 改 ~/.codex/config.toml 默认 profile
🧠 开启/关闭思考模式                 — 切换 thinking.type 与 effort
⚙ 修改配置                          — API Key / 模型 / 思考强度
✕ 退出
```

**两个接入完全独立**——可以只让 Claude Code 走 DeepSeek 而 Codex 保留 OpenAI，反之亦然。

代理进程**自动管理**：任一接入开启时代理自动启动 + 注册 LaunchAgent 开机自启；两个接入都关闭时代理自动停止。

---

## 原理

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code 路径（透传 + 字段覆盖，~50 行）                        │
│                                                                 │
│  Claude Code  ─POST /v1/messages──►  代理 127.0.0.1:17861       │
│                                       │ 注入 model               │
│                                       │ 注入 thinking.type       │
│                                       │ 注入 output_config.effort│
│                                       ▼                         │
│                                  api.deepseek.com/anthropic     │
│                                       │ SSE 直接 pipe 透传        │
│                                       ▼                         │
│                                   Claude Code（无感）             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Codex 路径（协议翻译 + 状态机，~250 行）                           │
│                                                                 │
│  Codex CLI ─POST /v1/responses──►  代理 127.0.0.1:17861         │
│                                       │ ① 输入翻译                │
│                                       │ ② 注入 thinking +         │
│                                       │   reasoning_effort       │
│                                       ▼                         │
│                              api.deepseek.com/chat/completions  │
│                                       │ Chat Completions SSE     │
│                                       ▼                         │
│                                   状态机翻译                      │
│                                       │ reasoning_text.delta     │
│                                       │ output_text.delta        │
│                                       │ function_call_arguments  │
│                                       ▼                         │
│                              Codex CLI（看到独立思考 + 文本 +     │
│                                         工具调用真流式）           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 为什么 Codex 路径比 Claude Code 复杂得多

**协议形态不同**：Anthropic Messages API 是"对话回合"模型——messages 进 SSE delta blocks 出，结构对应字段一致，转发即可。OpenAI Responses API 是"事件流 + 状态机"模型——reasoning / message / function_call 各自是独立的 output_item，每个都要严格走 6 步生命周期事件序列：

```
output_item.added → content_part.added → *.delta+ → *.done → content_part.done → output_item.done
```

**少一步 Codex UI 就显示异常**。

**端点不匹配**：DeepSeek 没有 Responses API，只有 Chat Completions。代理必须双向翻译：
- 上行：Codex 的 input items（`message` / `reasoning` / `function_call` / `function_call_output`）→ Chat Completions messages
- 下行：DeepSeek Chat Completions SSE（`delta.content` / `delta.reasoning_content` / `delta.tool_calls`）→ Responses API 的事件流

**字段细节多**：开发期间踩过的真实坑：
- `thinking: {type}` 字段 Chat Completions 路径同样支持（曾误以为只能 Anthropic 路径用）
- 思考强度只有 `high` / `max` 两档真实生效（`minimal` / `xhigh` / `low` / `medium` 都是兼容映射或非法值）
- 含工具调用的轮次中**所有** assistant 消息必须回传 `reasoning_content`（不只是 function_call，文本回复也要带）
- 一段 reasoning 可能对应多个连续 assistant 行为，需要 fallback 复用
- 并行 `tool_calls` 必须合并到一条 assistant 消息的 `tool_calls` 数组（不能拆成多条 assistant 消息）
- function_call item 的 `id` 必须等于 `call_id` 且都用 `call_` 前缀（zai-codex-bridge 兼容惯例）
- 公网偶发 TLS 抖动，`upstream.on('error')` 阶段需要透明 retry

代理代码里大约 **250 行状态机 + 80 行 input 翻译 + 嗅探日志**，全用 Node.js 内置模块，零外部依赖。

参考资料：[详细架构对比](../docs/codex-vs-claude-code-architecture.md)、[Codex 实测报告](自动化测试/codex实际测试/REPORT.md)。

---

## 配置文件改动

### `~/.claude/settings.json`（开启 Claude Code 接入时）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:17861",
    "ANTHROPIC_AUTH_TOKEN": "<DeepSeek API Key>",
    "ANTHROPIC_MODEL": "<选择的 DeepSeek 模型>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<选择的 DeepSeek 模型>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<选择的 DeepSeek 模型>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_EFFORT_LEVEL": "<high|max>"
  },
  "model": "<选择的 DeepSeek 模型>",
  "effortLevel": "<high|max>",
  "alwaysThinkingEnabled": true
}
```

原始 settings 备份到 `~/.claude/settings.json.deepseek-backup`，关闭接入时一键还原。

### `~/.codex/config.toml`（开启 Codex 接入时）

接管 `[profiles.default]` 让 `codex` 直接走 DeepSeek（不加 `-p` 参数）。原始 default profile 备份到注释 + `~/.codex/config.toml.deepseek-backup`，双保险还原。

```toml
# >>> deepseek-claude-setup codex
[model_providers.deepseek_local]
name = "DeepSeek Local Proxy"
base_url = "http://127.0.0.1:17861/v1"
wire_api = "responses"
experimental_bearer_token = "<DeepSeek API Key>"
...

[profiles.default]
model_provider = "deepseek_local"
model = "deepseek-v4-pro"
model_reasoning_effort = "max"
# <<< deepseek-claude-setup codex
```

```bash
codex                # 无需 -p，直接走 DeepSeek
codex -p openai      # 临时切回 OpenAI
```

---

## 诊断日志

代理把每次请求的关键状态写到 `/tmp/deepseek-claude-proxy.log`，能直接判断思考是否真启用：

```bash
tail -f /tmp/deepseek-claude-proxy.log | grep -E "RESPONSES_DONE|MSG_DONE|FAILED"
```

**Codex 路径**：

```
RESPONSES_DONE id=resp_xxx effort=max thinking=Y(1296chars) text=694chars tools=2 usage=18112/760 5103ms
                                      ^^^^^^^^^^^^^^^^^^^^^
                                  DeepSeek 实际返回的思考内容字符数
```

**Claude Code 路径**：

```
MSG_DONE model=deepseek-v4-pro thinking=Y(982chars) text=240chars stream=true usage=120/240 4200ms
```

判定标准：
- `thinking=Y(N chars)` 且 N > 0 → DeepSeek 真启用了思考
- `thinking=N` 而你设了开启 → 配置或上游 bug，请提 issue 附日志
- `RESPONSES_FAILED upstream_error` 带 DeepSeek 业务错误信息（如 `reasoning_content must be passed back`）→ 真实 bug，请提 issue
- `RESPONSES_FAILED connection_error TLS` → 公网抖动，代理已自动重试一次；多发说明网络问题

---

## 测试

```bash
npm test
```

57 个自动化用例（v1.3.6 当前数）覆盖：配置存储、settings/codex 文件 patch/restore、Anthropic 透传、Codex 流式状态机、并行 tool_calls 合并、reasoning_content 多场景回传、连接错误透明重试。

测试使用临时目录 + 本地假 DeepSeek 上游，**不调用真实 API，不修改真实 `~/.claude` / `~/.codex`**。

真实 codex CLI 长会话压测见 [自动化测试/codex实际测试/REPORT.md](自动化测试/codex实际测试/REPORT.md)（21 轮长会话 0 失败）。

---

## 系统要求

- **仅支持 macOS**（LaunchAgent 强绑定 launchctl）
- Node.js >= 16
- Claude Code 已安装（仅 Claude Code 接入需要）
- Codex CLI 已安装（仅 Codex 接入需要）

> Linux / Windows 当前**不能用**——代理本身能跑但开机自启失效，且 Windows 上会创建无效的 `~/Library/LaunchAgents/` 文件夹。跨平台支持在路线图里（PRD-003）。

---

## 升级与卸载

### 升级

最简单：

```bash
npx -y github:yunshu0909/deepseek-claude-setup
```

进主面板会自动检测 `proxy.js` 升级并重启代理。如果 `cli.js` 自身也想用最新版（修了主面板交互逻辑时），先 `rm -rf ~/.npm/_npx`。

### 完全卸载

```bash
# macOS
launchctl bootout gui/$(id -u)/com.deepseek.claude-proxy 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist
pkill -f "deepseek-claude/proxy.js"
rm -rf ~/.deepseek-claude
```

然后手动还原 `~/.claude/settings.json` 和 `~/.codex/config.toml`（如果之前开启过对应接入），或从 `.deepseek-backup` 备份文件复制回来。

---

## 路线图

按优先级（不乱序）：

1. **跨平台适配（PRD-003）** — 抽象启动管理（macOS launchd / Linux systemd user unit / Windows Task Scheduler），去掉 `~/Library/LaunchAgents/` 这种 macOS-only 路径假设
2. **多 provider 支持（PRD-004）** — 输入 API Key 一键接入 Qwen / Kimi / 智谱 / 阶跃 / MiniMax 等国产模型；引入 provider 抽象层
3. **自更新（PRD-005）** — cli.js 启动时检查 GitHub release 自动升级，彻底消除 npx 缓存影响

---

## License

MIT
