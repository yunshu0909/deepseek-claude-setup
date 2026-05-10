# V0.5 Provider Gateway 测试计划

> 日期：2026-05-09
> 适用分支：`codex/v0.5-provider-gateway`
> 配套报告：[TEST_REPORT.md](./TEST_REPORT.md)
> 目标：定义 Provider Gateway 版本“测什么 / 不测什么 / 怎么判定可发布”。

## 1. 测试目标

v0.5 的风险不只是“接口能返回一句话”，而是本地 gateway 要同时满足：

- DeepSeek 老用户路径 0 回归。
- 智谱作为第二 provider 真实可用。
- Claude Code 与 Codex 两个真实客户端都能跑。
- 不同 provider 的 thinking、tool calling、streaming 差异不会互相污染。
- 后续接入 Kimi / Qwen / MiniMax 时有统一测试模板。

因此测试分成五层：

| 层级 | 名称 | 目的 | 是否发版门禁 |
|------|------|------|--------------|
| L1 | 本地自动化回归 | 快速防止配置、patcher、proxy 状态机退化 | 是 |
| L2 | provider runtime 假上游 | 验证 provider-shaped config 与字段注入规则 | 是 |
| L3 | 真实 provider smoke | 验证真实 API key、endpoint、认证、基础协议 | 是 |
| L4 | 真实客户端 CLI 测试 | 验证 Claude Code / Codex 真能通过 gateway 工作 | 是 |
| L5 | 长链路项目闭环 | 验证多轮工具调用、reasoning 回传、上下文累积 | 发版前必跑 |

执行节奏：

| 阶段 | 必跑层级 | 进入下一阶段的条件 |
|------|----------|--------------------|
| 日常开发 | L1 + L2 | 本地自动化全绿，字段注入符合 provider 规则 |
| 新 provider 首次接入 | L1 + L2 + L3 | 真实 endpoint、认证、基础协议都通过 |
| 声明“Claude Code 可用” | L1 + L2 + L3 + Claude Code L4 | 文本闭环与工具闭环都通过 |
| 声明“Codex 可用” | L1 + L2 + L3 + Codex L4 | 单工具闭环通过，日志 0 `RESPONSES_FAILED` |
| 发版前 | L1-L5 全部 | 真实报告更新完成，DeepSeek 0 回归补跑完成 |

失败回退原则：低层失败先修低层，不跳到更高层靠“重跑”碰运气；高层失败先看 gateway 日志和 provider 原始响应体，再判断是协议字段、模型能力还是客户端配置问题。

## 2. 必须测试什么

### 2.1 L1 本地自动化回归

命令：

```bash
npm test
```

覆盖：

- `config-store` 旧格式迁移到 Provider Gateway 新格式。
- provider registry 注册与默认值。
- UI provider/model 配置构造。
- Claude Code settings patch / restore。
- Codex config patch / restore，包括顶层 `model_provider` 与重复 section 清理。
- proxy health / Anthropic 转发 / Responses bridge。
- DeepSeek thinking enabled / disabled 字段注入。
- Codex Responses 状态机：
  - reasoning / message / function_call 独立 output item。
  - function_call `id == call_id` 契约。
  - tool arguments 真流式增量。
  - `function_call_output` -> Chat `role=tool`。
  - reasoning_content 回传与 fallback。
  - 并行 function_call 合并。
  - upstream error 与 connect 阶段透明 retry。

通过标准：

```text
node test.js                       0 failed
node test/provider-runtime.test.js 0 failed
```

### 2.2 L2 provider runtime 假上游

目的：不依赖真实 API，就能快速检查 provider adapter 的请求体是否正确。

智谱必须验证：

- health 暴露 `provider=zai`、`model=glm-5.1`。
- Anthropic path 走 `anthropicBaseUrl`。
- Anthropic path 不主动注入 `thinking` / `output_config`。
- Responses path 走 Chat Completions endpoint。
- Responses path 发送 `thinking.type`。
- Responses path 不发送 `reasoning_effort`。
- Responses path 不发送 `stream_options`。
- 有 tools 时发送 `tool_stream: true`。
- 有历史 `reasoning_content` 时发送 `thinking.clear_thinking: false`。

DeepSeek 必须验证：

- Responses path 发送 `thinking.type`。
- enabled 时发送 `reasoning_effort=high|max`。
- disabled 时不发送 `reasoning_effort`。
- Anthropic path enabled 时发送 `output_config.effort`。
- Anthropic path disabled 时删除 `output_config`。

### 2.3 L3 真实 provider smoke

目的：验证真实 endpoint、认证和基础协议，不污染用户真实配置。

命令模板：

```bash
ZHIPU_API_KEY=... npm run smoke:provider
```

关闭 thinking：

```bash
ZHIPU_API_KEY=... PROVIDER_SMOKE_THINKING=disabled npm run smoke:provider
```

Coding Plan endpoint 另测：

```bash
ZHIPU_API_KEY=... \
PROVIDER_SMOKE_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 \
npm run smoke:provider
```

覆盖：

- 本地临时 gateway 启动。
- `/__health` 返回 active provider/model。
- Anthropic Messages path HTTP 2xx 且 body 非空。
- Responses bridge HTTP 2xx、`status=completed`、`output_text` 非空。

通过标准：

- enabled / disabled 至少都过一次。
- 失败时不能只看客户端错误，必须看 provider 原始响应体。

### 2.4 L4 真实 Claude Code CLI

目的：证明 Claude Code 不是“理论兼容”，而是真的能通过本地 gateway 跑。

测试形态：

```text
npm run e2e:clients
```

必须覆盖：

- 文本闭环：模型返回指定 marker。
- 工具闭环：Claude Code 实际调用 Bash 读取随机 `package.json`，写出 `bash-proof.txt`，最终输出随机 package name。
- 环境隔离：使用临时 `HOME`、`--bare`、`--settings`、`--setting-sources local`、dummy `ANTHROPIC_API_KEY`，不修改 `~/.claude/settings.json`。

智谱模型矩阵：

| 模型 | 文本闭环 | 工具闭环 |
|------|----------|----------|
| `glm-5.1` | 必测 | 必测 |
| `glm-5` | 必测 | 可抽样 |
| `glm-5-turbo` | 必测 | 可抽样 |
| `glm-4.7` | 必测 | 可抽样 |

通过标准：

- CLI exit code 为 0。
- 输出包含预期 marker 或包名。
- proxy 日志出现 `MSG_DONE`。

### 2.5 L4 真实 Codex CLI

目的：证明 Codex 真实 Responses API 客户端能通过 gateway 跑，并实际使用工具。

测试形态：

```text
npm run e2e:clients
```

必须覆盖：

- 临时 `CODEX_HOME`，不读写用户真实 `~/.codex/config.toml`。
- `--ignore-user-config` + `--ignore-rules` + `--ephemeral`。
- 单工具闭环：实际调用 shell 读取随机 `package.json`，最终输出随机 package name。
- 模型矩阵：`glm-5.1` / `glm-5` / `glm-5-turbo` / `glm-4.7`。
- proxy 日志无本次测试产生的 `RESPONSES_FAILED`。

通过标准：

- CLI exit code 为 0。
- 输出包含本次随机 package name。
- proxy 日志有 `RESPONSES_DONE`，且工具轮次 `tools=1`。

### 2.6 L5 Codex 长链路项目闭环

目的：覆盖最容易出 bug 的多轮工具调用、reasoning_content 回传、上下文累积。

标准 prompt（跨平台：用 Node 内置模块跑测试，不依赖 bash/curl）：

```text
写一个 Node.js HTTP 文件管理服务，只使用 Node 内置模块。
1. 创建 server.js，支持 GET /、GET /files、GET /files/:name、POST /files/:name、DELETE /files/:name。
2. 文件存到 ./data。
3. 创建 test.js（不是 test.sh），只用 Node 内置 http 和 assert 模块跑 7 个断言，最后用 console.log 输出一行：ALL 7 TESTS PASS。
4. 实际运行 `node test.js`，修到测试通过。
```

必须覆盖：

- Codex 创建文件。
- Codex 实际运行 `node test.js`。
- Codex 自己修复测试失败。
- 代理日志连续 `RESPONSES_DONE`。
- 本次长链路 0 `RESPONSES_FAILED`。
- runner 在 Codex 退出后**再次执行** `node test.js` 二次验证（防止模型只在 stdout echo 字符串骗过去）。

通过标准：

```text
ALL 7 TESTS PASS
```

标准 runner：

```bash
CLIENT_E2E_LONG=1 npm run e2e:clients
```

## 3. Provider 专项规则

### 3.1 DeepSeek

必须测：

- 旧配置迁移不破坏老用户。
- Claude Code Anthropic path：
  - enabled 发 `output_config.effort`。
  - disabled 删除 `output_config`。
- Codex Responses bridge：
  - enabled 发 `thinking.type` + `reasoning_effort`。
  - disabled 发 `thinking.type=disabled`，不发 `reasoning_effort`。
- 21 轮长链路 0 `RESPONSES_FAILED`。

发版前必须再跑一次 DeepSeek 0 回归长链路，不能只依赖智谱通过。

### 3.2 智谱 BigModel

必须测：

- 大陆版 endpoint：`open.bigmodel.cn`。
- 普通 BigModel endpoint。
- `thinking=enabled` 和 `thinking=disabled`。
- 不发送 DeepSeek 专属 `reasoning_effort`。
- 不发送 Anthropic path 的 `output_config.effort`。
- 有 tools 时发 `tool_stream: true`。
- 有历史 reasoning 时发 `thinking.clear_thinking=false`。
- 模型矩阵：
  - `glm-5.1`
  - `glm-5`
  - `glm-5-turbo`
  - `glm-4.7`

可选测：

- GLM Coding Plan endpoint：`https://open.bigmodel.cn/api/coding/paas/v4`。

## 4. 明确不测试什么

以下内容不作为 v0.5 自动化门禁：

| 不测项 | 原因 |
|--------|------|
| 所有国产 provider 一次性接完 | v0.5 只要求 DeepSeek + 1 个第二 provider 验证抽象 |
| Qwen 原生 Responses 直连 | v0.5 继续走 Responses -> Chat bridge；原生 Responses 放 v0.6+ |
| 智谱 Coding Plan endpoint | 本轮用户明确只测普通 BigModel endpoint；Coding Plan 后续按需测 |
| 精确模型输出文案 | LLM 输出天然不稳定，只校验 marker、结构、工具结果和状态 |
| 精确 latency / token 成本 benchmark | 网络、排队、模型负载波动大；只记录异常慢，不做硬门禁 |
| provider 商业额度 / 计费准确性 | 不属于本地 gateway 可控范围 |
| provider 平台安全审计 | 只保证本工具不把 key 写进项目文件；不审计上游平台 |
| Windows / macOS / Linux 全 CI 矩阵 | 现有 `npm test` 不依赖 OS 特性；真实跨平台问题 CI 模拟不出来 |
| Linux systemd user unit | v0.5 不做 Linux 自启主线 |
| 完全卸载按钮 | 已明确不做；关接入已能还原关键配置 |
| 终端 UI 视觉快照 | 这是 CLI 工具，v0.5 只验证配置逻辑和行为，不做视觉快照 |
| Claude Code Anthropic thinking 注入 | 智谱官方未公开该字段，v0.5 先不主动注入 |
| 长时间稳定性压测（数小时） | v0.5 门禁是项目级长链路，不做 soak test |

## 5. Key 与环境安全规则

- API Key 只通过环境变量传入。
- 不把 key 写入文档、测试报告、提交记录。
- 真实测试用临时 config dir。
- Claude Code 测试不修改用户真实 `~/.claude/settings.json`。
- Codex 测试不修改用户真实 `~/.codex/config.toml`。
- 测完后清理临时 `zhipu-*` 目录。
- 结束前必须 grep：

```bash
rg '<key片段>' /path/to/project || true
```

## 6. 发版门禁

v0.5 发版前必须全部满足：

- `npm test` 全绿。
- DeepSeek provider 假上游 runtime 全绿。
- 智谱 provider 假上游 runtime 全绿。
- 智谱真实 smoke enabled / disabled 全绿。
- 智谱 Claude Code CLI 文本 + 工具闭环全绿。
- 智谱 Codex CLI 单工具闭环全绿。
- 智谱模型矩阵全绿。
- 智谱 Codex 长链路输出 `ALL 7 TESTS PASS`。
- DeepSeek Codex 长链路 0 回归再跑一次。
- 项目文件中 grep 不到真实 API key。
- `docs/provider-matrix.md`、`docs/prd/PRD-005-v0.5.md`、`自动化测试/V0.5/TEST_REPORT.md` 同步更新。

## 7. 失败处理规则

| 失败类型 | 处理方式 |
|----------|----------|
| `npm test` 失败 | 先修单测，不进入真实 smoke |
| provider smoke 401/403 | 检查 key / endpoint / 账号权限，不先改协议 |
| provider smoke 400 | 保存原始响应体，判断字段不兼容 |
| Claude Code 失败 | 先确认 `ANTHROPIC_BASE_URL` 是否走临时 gateway |
| Codex 失败 | 先确认 `model_provider`、`wire_api=responses`、`base_url=/v1` |
| `RESPONSES_FAILED` | 优先看 provider 原始错误；不能只看客户端 exit code |
| 工具调用后报 reasoning 相关错误 | 检查 `reasoning_content` 回传、`clear_thinking`、并行 tool_call 合并 |
| 输出不含 marker | 可重跑一次；连续失败才视为模型兼容问题 |

## 8. 文档归档规则

- 每次真实测试后更新 `自动化测试/V0.5/TEST_REPORT.md`。
- provider 能力变化同步 `docs/provider-matrix.md`。
- PRD 状态变化同步 `docs/prd/PRD-005-v0.5.md`。
- 若新增 provider，把本文件的 provider 专项规则复制一份扩展，不要临时口头约定。

## 9. L4 / L5 标准入口（PRD-006）

L4 真实客户端 CLI 测试 + L5 长链路统一通过 `npm run e2e:clients` 进入。具体见 [PRD-006](../../../docs/prd/PRD-006-v0.5-client-e2e.md)。

```bash
# L4：DeepSeek 默认三项（claude-text + claude-tool + codex-tool）
DEEPSEEK_API_KEY=... CLIENT_E2E_PROVIDER=deepseek CLIENT_E2E_MODEL=deepseek-v4-pro npm run e2e:clients

# L4 + L5：追加 codex-long
DEEPSEEK_API_KEY=... CLIENT_E2E_PROVIDER=deepseek CLIENT_E2E_MODEL=deepseek-v4-pro CLIENT_E2E_LONG=1 npm run e2e:clients

# 智谱矩阵（同上替换 provider/key 即可）
ZHIPU_API_KEY=... CLIENT_E2E_PROVIDER=zai CLIENT_E2E_MODEL=glm-5.1 CLIENT_E2E_LONG=1 npm run e2e:clients
```

每次跑测自动生成：
- `自动化测试/V0.5/CLIENT_E2E_REPORT_LATEST.md`（人读）
- `自动化测试/V0.5/CLIENT_E2E_REPORT_LATEST.json`（机读）

CLIENT_E2E_REPORT 环境变量可指定额外的存档路径（不替换默认 latest）。

## 10. E2E 测试纪律

跑 `npm run e2e:clients` 期间：

- **不要在另一个窗口/IDE 里同时使用 Claude Code 或 Codex**。否则你日常用客户端会动 `~/.claude.json` / `~/.codex/config.toml`，被 runner 的"用户配置 sha256 比对"误判为污染。
  - runner 已经实现按 target 归因（codex-only 测试不阻断 Claude 改动），但保持纪律才能拿到 100% 干净的报告。
- 不要中途 `Ctrl+C` 长链路。Codex 长链路会自己跑测试 + 自修复，最长可能 10+ 分钟，是正常的。
- 如果你需要**保留**临时目录调试，加 `CLIENT_E2E_KEEP_TMP=1`。

如果报告里 `Blocking config changes` 非空，**先确认这一段时间外部没用 codex/claude**。如果确实没用，那就是 runner 隔离不彻底或 codex/claude CLI 在 `--ignore-user-config` / `--bare` 下仍写了用户文件——这是 runner 真问题，需要查。
