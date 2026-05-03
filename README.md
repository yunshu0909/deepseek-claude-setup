# DeepSeek × Claude Code / Codex 一键配置工具

解决 Claude Code 接入 DeepSeek 时 `effortLevel` 配置不生效的问题，并提供 Codex CLI 的 DeepSeek profile 接入。

## 问题

Claude Code 的 `effortLevel` 映射到 Anthropic 的 `thinking.budget_tokens`，但 DeepSeek 的 Anthropic 兼容端点**忽略该字段**。真正控制思考深度的是 `output_config.effort`，而 Claude Code 无法发出该参数。

## 解决方案

本地部署一个代理服务，在请求中自动注入 DeepSeek 真正识别的模型和思考参数，然后转发给 DeepSeek。

## 一行命令使用

```bash
npx -y github:yunshu0909/deepseek-claude-setup
```

如果后续发布到 npm，也可以使用 `npx deepseek-claude-setup`。

## 使用

首次运行进入配置向导（输入 API Key、选模型、选思考模式、选思考深度），之后进入主面板：

- **开启代理** — 一键部署代理 + 修改 settings.json + 注册开机自启
- **关闭代理** — 一键还原所有配置
- **开启/关闭思考模式** — 主面板一键切换，运行中自动重启代理生效
- **开启/关闭 Codex 接入** — 接管 Codex 默认 profile，开启后直接 `codex` 即可使用 DeepSeek（不加 `-p`），关闭后还原
- **修改配置** — 更改模型、思考模式或思考深度（运行中自动重启代理）

## 原理

```
Claude Code → localhost:17861 (代理) → api.deepseek.com
                  ↑ 覆盖 model + thinking.type + output_config.effort

Codex CLI → localhost:17861/v1/responses (代理) → api.deepseek.com/chat/completions
                  ↑ Responses API 转 DeepSeek Chat Completions
```

开启代理时工具会同步修改 `~/.claude/settings.json`：

- `ANTHROPIC_BASE_URL=http://localhost:17861`
- `ANTHROPIC_AUTH_TOKEN=<DeepSeek API Key>`
- `ANTHROPIC_MODEL=<选择的 DeepSeek 模型>`
- `ANTHROPIC_DEFAULT_OPUS_MODEL=<选择的 DeepSeek 模型>`
- `ANTHROPIC_DEFAULT_SONNET_MODEL=<选择的 DeepSeek 模型>`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash`
- `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash`
- `CLAUDE_CODE_EFFORT_LEVEL=<high|max>`（仅思考模式开启时写入）
- `model=<选择的 DeepSeek 模型>`
- `effortLevel=<high|max>`（仅思考模式开启时写入）
- `alwaysThinkingEnabled=<true|false>`

代理层会再兜底覆盖请求体：

- `model`：使用配置向导选择的 `deepseek-v4-pro` 或 `deepseek-v4-flash`
- `thinking.type`：配置为 `enabled` 或 `disabled`
- `output_config.effort`：思考模式开启时为 `high` 或 `max`；思考模式关闭时不发送

## Codex CLI

在主面板选择「开启 Codex 接入」后，工具会接管 `~/.codex/config.toml` 的默认 profile，开启后直接 `codex` 即可使用 DeepSeek：

```bash
codex  # 无需 -p 参数，直接走 DeepSeek
codex -p openai  # 临时使用 OpenAI
```

原始默认配置备份到 `.deepseek-backup` 文件。关闭 Codex 接入时，一键还原原始配置。

支持普通文本会话和 function tools 的真流式逐字输出。

## 测试

```bash
npm test
```

测试使用临时配置目录和本地假 DeepSeek 上游，不会调用真实 DeepSeek API，也不会修改真实 `~/.claude/settings.json`。

## 系统要求

- macOS（LaunchAgent 仅 macOS 支持）
- Node.js >= 16
- Claude Code 已安装

## 手动卸载

如果不再需要：
```bash
launchctl unload ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist
rm ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist
rm -rf ~/.deepseek-claude
```

然后在 `~/.claude/settings.json` 中将 `ANTHROPIC_BASE_URL` 改回：
```
"https://api.deepseek.com/anthropic"
```

## License

MIT
