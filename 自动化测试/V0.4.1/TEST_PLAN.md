# V0.4.1 Hermes Target 自动化测试计划

## 目标

验证 v1.4.1 只做 Hermes Agent 接管补丁，不引入 provider gateway 大版本变更：

- Hermes config.yaml 能被接管到本地 `/v1/chat/completions`
- 本地代理新增 OpenAI Chat Completions 入口，供 Hermes 等 OpenAI SDK 客户端使用
- Linux 服务器能通过 systemd 纳管代理常驻
- Claude Code / Codex 原有路径保持回归通过

## 自动化范围

| 编号 | 用例 | 断言 |
| --- | --- | --- |
| HERMES-001 | Hermes config patch/restore | 写入 `provider=custom`、`api_mode=chat_completions`、本地 base_url；关闭后还原 |
| HERMES-002 | Key 隔离 | Hermes config 不写真实 DeepSeek key，只写本地占位 token |
| HERMES-003 | Chat Completions 入口 | `/v1/chat/completions` 覆盖模型并注入 `thinking` / `reasoning_effort` |
| HERMES-004 | 非流式兼容 | `stream=false` 时不转发 `stream_options` |
| HERMES-005 | 工具重请求 fallback | `tools + reasoning_effort=max` 上游 5xx 时，未回包前降到 `high` 重试一次 |
| LINUX-001 | systemd unit | root/server scope 使用 `multi-user.target`，包含 config env |
| REG-001 | 旧路径回归 | `node test.js` 原 Claude Code / Codex 测试保持通过 |

## 执行命令

```bash
npm test
```

服务器真实验证命令：

```bash
npx -y github:yunshu0909/deepseek-claude-setup --enable-hermes
curl -s http://127.0.0.1:17861/__health
sudo -iu hermes bash -lc 'export HERMES_HOME=/var/lib/hermes; timeout 120 hermes -z "只回复 OK 两个字母，不要解释。" --ignore-rules'
```
