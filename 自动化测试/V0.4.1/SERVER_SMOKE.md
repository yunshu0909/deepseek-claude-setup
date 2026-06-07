# SERVER_SMOKE（V0.4.1）

## 1. 环境

- 日期：2026-05-24
- Host：`RainYun-fmYK8D2Q`
- 用户：root 部署，`hermes` 运行服务
- 分支代码来源：本地 `codex/v0.4.1-hermes-target` rsync 到服务器
- proxy runtime：`/var/lib/hermes/deepseek-claude/proxy.js`
- Hermes config：`/var/lib/hermes/config.yaml`

## 2. 部署动作

- 备份：
  - `/var/lib/hermes/config.yaml.before-v041-20260523-223133`
  - `/var/lib/hermes/deepseek-claude.before-v041-20260523-223133`
- 同步：
  - `/opt/deepseek-claude-setup-v041/`
  - `/var/lib/hermes/deepseek-claude/`
- 重启：
  - `systemctl restart deepseek-claude-proxy.service`
  - `systemctl restart hermes-gateway.service`

## 3. Service / Health

```text
systemctl is-active deepseek-claude-proxy.service -> active
systemctl is-enabled deepseek-claude-proxy.service -> enabled
systemctl is-active hermes-gateway.service -> active
```

```json
{"service":"deepseek-claude-proxy","ok":true,"provider":"deepseek","model":"deepseek-v4-pro","thinking":"enabled","effort":"max"}
```

## 4. Hermes Config

```text
model.api_mode: "chat_completions"
model.base_url: "http://127.0.0.1:17861/v1"
model.default: "deepseek-v4-pro"
model.provider: "custom"
agent.reasoning_effort: "high"
```

真实 provider key 未写入 Hermes config；Hermes 侧使用本地占位 token，真实 key 仍由 proxy 注入上游。

## 5. Direct Chat Smoke

命令：`curl http://127.0.0.1:17861/v1/chat/completions`

结果：

```text
http=200
model=deepseek-v4-pro
content=OK
```

## 6. Hermes CLI Smoke

命令：

```bash
sudo -iu hermes bash -lc 'export HERMES_HOME=/var/lib/hermes; cd /tmp; timeout 120 hermes -z "只回复 OK 两个字母，不要解释。" --ignore-rules'
```

结果：

```text
OK
```

## 7. Proxy Logs

关键日志：

```text
CHAT_POST /v1/chat/completions model=ignored->deepseek-v4-pro msgs=1 tools=0 max_tokens=64 thinking=enabled effort=max
CHAT_DONE model=deepseek-v4-pro stream=false status=200
CHAT_POST /v1/chat/completions model=deepseek-v4-pro->deepseek-v4-pro msgs=2 tools=28 max_tokens=- thinking=enabled effort=max
CHAT_DONE model=deepseek-v4-pro stream=true status=200
```

## 8. Doctor

`hermes doctor` 通过核心运行项：

- Python / venv / OpenAI SDK / PyYAML / HTTPX：OK
- `/var/lib/hermes/config.yaml`：OK
- Gateway service linger：OK
- Node.js / agent-browser / Playwright Chromium：OK
- API Connectivity：DeepSeek OK

仍有非阻断 warnings：

- OpenRouter API 未配置
- 多个可选工具 token / 系统依赖缺失
- Skills Hub 未初始化
- No GITHUB_TOKEN

这些 warnings 在 PRD-004.1 范围外，不影响 Hermes 文本模型接管 smoke。

## 9. 结论

- EVD-043-1：PASS
- EVD-045-1：PASS
- EVD-045-2：PASS
- Server Smoke Gate：PASS

剩余未覆盖：微信端到端 MAN-045-1、vision 边界人工确认 MAN-045-2。
