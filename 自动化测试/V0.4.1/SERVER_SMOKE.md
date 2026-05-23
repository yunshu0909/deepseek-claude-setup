# V0.4.1 服务器真实 Smoke

## 环境

- 服务器：`RainYun-fmYK8D2Q`
- 服务：`deepseek-claude-proxy.service`
- Hermes config：`/var/lib/hermes/config.yaml`
- Proxy config：`/var/lib/hermes/deepseek-claude/config.json`

## 执行

```bash
sudo -iu hermes env \
  DEEPSEEK_CLAUDE_SKIP_UPDATE=1 \
  DEEPSEEK_CLAUDE_CONFIG_DIR=/var/lib/hermes/deepseek-claude \
  HERMES_CONFIG_PATH=/var/lib/hermes/config.yaml \
  npx -y github:yunshu0909/deepseek-claude-setup --enable-hermes
```

结果：`Hermes Agent 已接管到本地 DeepSeek 代理`

## 证据

### Proxy Health

```json
{"service":"deepseek-claude-proxy","ok":true,"model":"deepseek-v4-pro","thinking":"enabled","effort":"max"}
```

### Hermes Config

```yaml
model:
  provider: custom
  default: deepseek-v4-pro
  base_url: http://127.0.0.1:17861/v1
  api_mode: chat_completions
  api_key: "****"
agent:
  reasoning_effort: high
```

### Direct Chat Completions

请求 `/v1/chat/completions`，上游实际模型覆盖为 `deepseek-v4-pro`，返回：

```text
OK
```

### Hermes One-shot

```bash
sudo -iu hermes bash -lc 'export HERMES_HOME=/var/lib/hermes; cd /tmp; timeout 120 hermes -z "只回复 OK 两个字母，不要解释。" --ignore-rules'
```

返回：

```text
OK
```

### Service

```text
deepseek-claude-proxy.service: active / enabled
MainPID=468269
ActiveState=active
SubState=running
```

### Proxy Log

```text
CHAT_POST /v1/chat/completions ... tools=28 ... thinking=enabled effort=max
CHAT_DONE model=deepseek-v4-pro stream=true status=200
CHAT_POST /v1/chat/completions model=hermes-local->deepseek-v4-pro ...
CHAT_DONE model=deepseek-v4-pro stream=false status=200
```
