# DeepSeek / 智谱 / Kimi × Claude Code / Codex / Hermes 一键配置工具

让 Claude Code、OpenAI Codex CLI 和 Hermes Agent 透明使用 DeepSeek、智谱 BigModel、Kimi 模型，且**思考模式真的生效**。

> ✅ 当前版本（v1.6.4）已支持 **3 个 provider**：DeepSeek、智谱 BigModel、Kimi（Moonshot）。配置向导支持保存自定义模型 ID；三家都跑过同一套真实客户端认证（详见底部「支持的 Provider」与路线图），认证报告会记录真实 API token 用量。

---

## 支持的 Provider

配置向导**第一步就是选 Provider**，选好后输该 provider 的 API Key、选模型，再决定接入 Claude Code / Codex / Hermes 哪几个客户端。模型选择支持内置推荐列表，也支持直接输入自定义模型 ID；新增 provider 只需在 registry 注册一个 adapter，向导自动展开。

| Provider | id | 默认端点 | 模型示例 | 思考模式 | 思考强度档（effort） |
|---|---|---|---|---|---|
| **DeepSeek** | `deepseek` | api.deepseek.com | deepseek-v4-pro / deepseek-v4-flash | ✅ | ✅ high / max |
| **智谱 BigModel** | `zai` | open.bigmodel.cn | glm-5.1 / glm-5 / glm-5-turbo / glm-4.7 / glm-4.5-air | ✅ | ❌（向导自动跳过强度选择） |
| **Kimi（Moonshot）** | `kimi` | api.moonshot.cn | kimi-k2.6 / kimi-k2.7-code / kimi-k2.5 | ✅ | ❌（向导自动跳过强度选择） |

> 智谱 / Kimi 支持思考模式但没有 effort 强度档，向导检测到 `thinkingEffort:false` 会自动跳过强度选择；只有 DeepSeek 会让你选 high / max。Kimi `kimi-k2.7-code` 官方要求始终开启 thinking，本工具会在该模型下把 `disabled` 请求提升为 effective `enabled`，避免上游 400；Codex Responses 工具请求会补 `max_completion_tokens=8192`，避免长任务把默认输出预算耗在 thinking 后截断工具参数。

三家 provider 都经过**同一套 56 例真实客户端认证**（真 Claude Code + 真 Codex + Hermes 打真实 API，非 capture 演习）：macOS 上 DeepSeek / 智谱 / Kimi 各 55/55 PASS，Linux 上 DeepSeek 55/55 PASS。

---

## 解决三个真实痛点

### 1. Claude Code 接 DeepSeek，思考强度无效

Claude Code 的 `effortLevel` 映射到 Anthropic 协议的 `thinking.budget_tokens`，但 DeepSeek 的 Anthropic 兼容端点**忽略这个字段**——真正控制思考深度的是 `output_config.effort`。所以你设了"max effort"实际跑出来是默认强度。

**解法**：本地 Provider Gateway 按当前 provider 的能力声明注入正确字段（DeepSeek 强制注入 `output_config.effort`；智谱 / Kimi 没有 effort 档，则只注入 thinking 开关），各家才认。

### 2. Codex 接 DeepSeek，必须协议翻译 + 真流式

Codex 用的是 OpenAI Responses API（独立的 reasoning / message / function_call 事件流），DeepSeek 只有 OpenAI Chat Completions 端点（扁平的 `delta.content` 流）。中间需要双向翻译，且必须**逐 chunk 真流式**才能让 codex 渲染思考过程和工具调用 args 的逐字流。

**解法**：本地代理实现完整状态机翻译，逐字转发，零依赖。

### 3. Hermes Agent 需要纳入统一模型配置

Hermes Agent 默认有自己的模型配置和 provider key 管理。如果它直接连外部 provider，就会和 Claude Code / Codex 使用两套模型、两套思考强度和两套故障诊断路径，服务器上也不方便统一纳管。

**解法**：本工具把 Hermes 的 `config.yaml` 切到本地 OpenAI Chat Completions 入口 `http://127.0.0.1:17861/v1`，真实 DeepSeek Key 仍只保存在本地代理配置里，Hermes 配置只写本地占位 token。

---

## 一行命令使用

```bash
npx -y github:yunshu0909/deepseek-claude-setup
```

**首次运行**：拉到 GitHub 最新版，进配置向导（**选 Provider（DeepSeek / 智谱 / Kimi）** → 输该 provider 的 API Key → 选内置模型或输入自定义模型 ID → 选思考模式 →（仅 DeepSeek）选思考深度），然后进主面板。

**已经装过的用户**（v1.4.0+）：每次启动自动检测 GitHub `main` 最新 commit——发现新版本就自动清 `~/.npm/_npx` 缓存 + 重新 `npx` + 重启进程，**无需手动操作**。`proxy.js` 同样会被检测内容变化并热重启代理。

---

## 主面板 5 个独立入口

```
Claude Code: ○ 未接入 / 🟢 已接入
Codex:       ○ 未接入 / 🟢 已接入 (直接 codex 即可使用)
Hermes:      ○ 可接管 / 🟢 已接管
代理:        ○ 未运行 / 🟢 127.0.0.1:17861
模型: deepseek-v4-pro  |  思考模式: 开启 (max)

🤖 开启/关闭 Claude Code 接入       — 改 ~/.claude/settings.json
⌘ 开启/关闭 Codex 接入              — 改 ~/.codex/config.toml 默认 profile
◇ 开启/关闭 Hermes Agent 接管       — 改 ~/.hermes/config.yaml 或 /var/lib/hermes/config.yaml
🧠 开启/关闭思考模式                 — 切换 thinking.type 与 effort
⚙ 修改配置                          — API Key / 模型 / 思考强度
✕ 退出
```

**三个接入完全独立**——可以只让 Claude Code、Codex 或 Hermes 其中一个走 DeepSeek，其他客户端保留原配置。

代理进程**自动管理**：任一接入开启时代理自动启动 + 注册开机自启；全部接入都关闭时代理自动停止。Linux 服务器优先注册 systemd service，非 systemd 环境会明确提示只能手动常驻。

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

┌─────────────────────────────────────────────────────────────────┐
│ Hermes Agent 路径（OpenAI Chat Completions 透传 + 字段覆盖）        │
│                                                                 │
│  Hermes Agent ─POST /v1/chat/completions──► 代理 127.0.0.1:17861 │
│                                       │ 注入 model               │
│                                       │ 注入 thinking.type       │
│                                       │ 注入 reasoning_effort    │
│                                       ▼                         │
│                              api.deepseek.com/chat/completions  │
│                                       ▼                         │
│                                   Hermes Agent（无感）            │
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

接管 `[profiles.default]` 让 `codex` 直接走 DeepSeek（不加 `-p` 参数）。**同时还会写入顶层 `model` / `model_reasoning_effort` / `model_provider` 三个键**——因为 codex 0.128 在 ChatGPT 账号登录态下，顶层 `model_provider` 才是路由的决定性字段，`[profiles.default]` 在登录态下是次要建议会被无视（Mac/Windows 实战均遇到，v1.3.7 修复）。原始 default profile + 顶层值都备份到 managed block 注释 + `~/.codex/config.toml.deepseek-backup`，双保险还原。

```toml
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
model_provider = "deepseek_local"

# >>> deepseek-claude-setup codex
[model_providers.deepseek_local]
name = "DeepSeek Local Proxy"
base_url = "http://127.0.0.1:17861/v1"
wire_api = "responses"
experimental_bearer_token = "<DeepSeek API Key>"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 600000

# --- original default profile ---
# [top-level]
# model = "<原顶层 model 备份>"
# [profiles.default]
# (none)
# --- end original ---

[profiles.default]
model_provider = "deepseek_local"
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
# <<< deepseek-claude-setup codex
```

> 思考强度映射：UI 选 `max` → 写 `xhigh`（DeepSeek 真实最高档），UI 选 `high` → 写 `high`，思考关闭 → 写 `minimal`。

```bash
codex                # 无需 -p，直接走 DeepSeek
codex -p openai      # 临时切回 OpenAI
```

### Hermes Agent（开启 Hermes 接管时）

优先改 `HERMES_CONFIG_PATH` 指定的文件；未指定时，服务器上优先使用 `/var/lib/hermes/config.yaml`，本机使用 `~/.hermes/config.yaml`。原始文件备份到同路径 `.deepseek-backup`。

```yaml
model:
  provider: "custom"
  default: "deepseek-v4-pro"
  base_url: "http://127.0.0.1:17861/v1"
  api_mode: "chat_completions"
  api_key: "deepseek-claude-local"
agent:
  reasoning_effort: "high"
```

> Hermes 配置里不会写入真实 DeepSeek API Key；真实 key 只保存在 `~/.deepseek-claude/config.json`，由本地代理转发到 DeepSeek。

服务器非交互接管：

```bash
npx -y github:yunshu0909/deepseek-claude-setup --enable-hermes
npx -y github:yunshu0909/deepseek-claude-setup --disable-hermes
npx -y github:yunshu0909/deepseek-claude-setup --diagnose-hermes
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

**Hermes / OpenAI Chat Completions 路径**：

```
CHAT_POST /v1/chat/completions model=hermes-local->deepseek-v4-pro msgs=1 tools=0 thinking=enabled effort=max
CHAT_DONE model=deepseek-v4-pro stream=false status=200 1750ms
```

判定标准：
- `thinking=Y(N chars)` 且 N > 0 → DeepSeek 真启用了思考
- `thinking=N` 而你设了开启 → 配置或上游 bug，请提 issue 附日志
- `RESPONSES_FAILED upstream_error` 带 DeepSeek 业务错误信息（如 `reasoning_content must be passed back`）→ 真实 bug，请提 issue
- `RESPONSES_FAILED connection_error TLS` → 公网抖动，代理已自动重试一次；多发说明网络问题

---

## 开发者认证

开发者侧的 provider 自动化认证能力（v1.5.0 引入，v1.6.2 已覆盖三家 provider），用来判断每个 provider 的回归和新模型接入是否真的可用。`--provider` 接受 `deepseek` / `zai` / `kimi`，各自读自己的 Key 环境变量（`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`）。

```bash
npm run certify:provider -- --provider deepseek --dry-run
env -u DEEPSEEK_API_KEY npm run certify:provider -- --provider deepseek
DEEPSEEK_API_KEY=<key> npm run certify:provider -- --provider deepseek
ZHIPU_API_KEY=<key>    npm run certify:provider -- --provider zai
MOONSHOT_API_KEY=<key> npm run certify:provider -- --provider kimi
DEEPSEEK_API_KEY=<key> npm run certify:provider -- --provider deepseek --target hermes-linux
npm run certify:provider -- --provider <id> --model <new-model> --flash-model <secondary-model>
npm run certify:release -- <mac-report> <windows-report> <linux-report>
```

认证器会生成 `reports/provider-certification/<run-id>/report.json` 和 `report.md`，并按 56 条用例记录 `PASS / FAIL / BLOCKED / SKIPPED`。`dry-run` 只表示计划生成成功，固定为 `planReady=true`、`passed=false`，不会冒充真实认证通过。新增模型发布前可以用 `--model` / `--flash-model` 显式指定本轮认证模型；不传时仍使用 provider profile 的默认 pro/flash 模型。

`report.json` 顶层包含 `tokenUsage`，用于估算本轮真实 API 使用量：

```json
{
  "requests": 38,
  "requestsWithUsage": 38,
  "missingUsageCount": 0,
  "inputTokens": 222219,
  "outputTokens": 10744,
  "reasoningTokens": 5186,
  "totalTokens": 232963
}
```

`tokenUsage.records[]` 会按请求记录 `source`、`client`、`caseName`、`path`、`providerId`、`model` 和 token 数。provider 未返回 usage 时计入 `missingUsageCount`，不阻断认证；报告只统计 token，不内置价格表、不估算金额。

当前认证范围包括：
- 各 provider 的 health / Anthropic Messages / OpenAI Chat（Codex 桥接）基础连通
- Claude Code 与 Codex 的模型切换、thinking 开关、effort（仅有 effort 档的 provider）、工具调用、命令执行、长任务
- Hermes / Linux systemd 真场景 smoke
- 报告上下文、dirty worktree、true-key 证据、Key 泄露扫描、缺平台/缺 P0/假绿防护

真实认证结果：macOS 上 DeepSeek / 智谱 / Kimi 各 55/55 PASS，Linux 上 DeepSeek 55/55 PASS（真客户端打真实 API，非 capture 演习）。

v1.6.2 macOS 认证修复后，三家完整真 key 认证均重新跑过并产出 tokenUsage：DeepSeek `232,963` total tokens，智谱 `150,979` total tokens，Kimi `130,203` total tokens（Kimi 有部分请求未返回 usage，已计入 `missingUsageCount`）。

Windows 报告可由 Windows 真机单独生成后人工合并；release gate 仍要求三平台报告来自同一目标分支和 commit。

---

## 测试

```bash
npm test
```

134 个自动化用例覆盖：配置存储、settings/codex 文件 patch/restore、自定义模型 ID 保存、Kimi K2.7 Code thinking 与 Codex 长工具预算规则、Anthropic 透传、Codex 流式状态机、并行 tool_calls 合并、reasoning_content 多场景回传、连接错误透明重试、Hermes config patch/restore、OpenAI Chat Completions 入口、工具请求 5xx fallback、跨平台 autostart 抽象（macOS launchd / Windows schtasks / Linux systemd），以及 provider certification 的报告、release gate、capability-aware capture runner、true-key runner、Linux Hermes runner、认证 runner stdio 兜底和 tokenUsage 汇总。

测试使用临时目录 + 本地假 DeepSeek 上游，**不调用真实 API，不修改真实 `~/.claude` / `~/.codex` / Hermes 配置**。

真实 codex CLI 长会话压测见 [自动化测试/codex实际测试/REPORT.md](自动化测试/codex实际测试/REPORT.md)（21 轮长会话 0 失败）。

---

## 系统要求

- **macOS**（开机自启走 launchd LaunchAgent）
- **Windows 10/11**（开机自启走 schtasks `/SC ONLOGON`，失败时降级到 Startup 文件夹的 `.vbs`）
- Linux 代理本身能跑；systemd 环境会注册 `deepseek-claude-proxy.service`，非 systemd 环境会明确提示手动常驻命令
- Node.js >= 16
- Claude Code 已安装（仅 Claude Code 接入需要）
- Codex CLI 已安装（仅 Codex 接入需要）
- Hermes Agent 已安装且存在 `config.yaml`（仅 Hermes 接管需要）

> 跨平台抽象在 `src/autostart/{darwin,win32,linux}.js`，调用方零 `process.platform` 分支（PRD-003 已交付，v1.3.x）。Mac 与 Windows UX 完全一致。

---

## 升级与卸载

### 升级

```bash
npx -y github:yunshu0909/deepseek-claude-setup
```

v1.4.0+ 启动时自动比对 GitHub `main` 最新 commit：发现新版本就自动 `rm -rf ~/.npm/_npx` 后重新 npx + 重启进程，**无需手动清缓存**。`proxy.js` 内容变化时主面板会热重启代理。

### 完全卸载

工具里推荐先**关闭所有接入开关**（自动还原 settings.json / config.toml / Hermes config.yaml + 注销自启项），再清残留：

```bash
# macOS
launchctl bootout gui/$(id -u)/com.deepseek.claude-proxy 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist
pkill -f "deepseek-claude/proxy.js"
rm -rf ~/.deepseek-claude

# Windows (PowerShell)
schtasks /Delete /TN "DeepSeekClaudeProxy" /F 2>$null
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-claude-proxy.vbs" -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*deepseek-claude*" } | Stop-Process -Force
Remove-Item -Recurse -Force "$env:USERPROFILE\.deepseek-claude"

# Linux systemd
systemctl disable --now deepseek-claude-proxy.service 2>/dev/null
rm -f /etc/systemd/system/deepseek-claude-proxy.service
systemctl daemon-reload 2>/dev/null
```

如果跳过了开关直接清文件，从 `.deepseek-backup` 备份手动还原 `~/.claude/settings.json`、`~/.codex/config.toml` 和 Hermes `config.yaml`。

---

## 路线图

已完成：

- ✅ **跨平台适配（PRD-003，v1.3.x）** — `src/autostart/` 抽象 macOS launchd / Windows schtasks+Startup .vbs / Linux systemd，调用方零 `process.platform` 分支
- ✅ **真·自更新（v1.4.0）** — cli.js 启动检测 GitHub `main` 最新 commit，发现新版自动清 `~/.npm/_npx` + 重新 npx + 重启进程（用 `DEEPSEEK_CLAUDE_SKIP_UPDATE` 环境变量防死循环）
- ✅ **Hermes Agent 接管（v1.4.1）** — 新增 `/v1/chat/completions` 入口、Hermes config patch/restore/status、Linux systemd、非交互 `--enable-hermes`，服务器真实 `hermes -z` smoke 通过
- ✅ **Provider Certification Automation（v1.5.0）** — 新增 `certify:provider`、`certify:release`、`smoke:provider`、`e2e:clients`、`smoke:hermes-linux`，把 DeepSeek 作为基准 provider 建立可复用认证报告和三平台门禁
- ✅ **Key 泄漏止血（v1.5.1）** — 客户端配置（`~/.claude` / `~/.codex`）改写本地占位 token，不再把真实 provider key 明文落进客户端文件
- ✅ **Provider Gateway 架构（v1.6.0）** — 把 DeepSeek 从一次性透传迁到 provider 无关、能力声明驱动的网关核心 + 原子部署；智谱 / Kimi 的实验底子保存在 git tag `archive/v1.6.0-provider-gateway`
- ✅ **接入智谱 + Kimi（v1.6.1）** — 新增 `proxy/providers/zai.js` / `proxy/providers/kimi.js` 两个 adapter，向导第一步可选 Provider；三家共用同一套真实客户端认证
- ✅ **认证可信度 + Token usage（v1.6.2）** — 修复非 DeepSeek provider capture 假绿，认证断言改为 capability-aware；`certify:provider` 支持 `--model` / `--flash-model`，报告新增真实 API tokenUsage 汇总
- ✅ **自定义模型保存 + Kimi K2.7 Code（v1.6.3）** — 向导支持保存 provider 级自定义模型 ID；Kimi 内置可选 `kimi-k2.7-code`，并处理其 thinking 只能 enabled 的上游约束；智谱补入真测通过的 `glm-4.5-air`
- ✅ **Kimi K2.7 Code Codex 长任务认证修复（v1.6.4）** — K2.7 Code 的 Codex 工具请求补安全输出预算，修复完整认证曾卡在 TC-037 的问题；认证 capture 正确尊重 `--model/--flash-model` override

下一步：

- **继续扩 provider** — 网关核心已 provider 无关，新增 Qwen / MiniMax / 豆包等只需写一个声明 endpoint / 模型 / capabilities 的 adapter

---

## License

MIT
