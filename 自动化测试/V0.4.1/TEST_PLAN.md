# TEST_PLAN（V0.4.1）

## 1. 测试范围

- PRD：`/Users/yunshu/Documents/projects/deepseek/docs/prd/未开发完成/md/PRD-004.1-v0.4.1-hermes-target.md`
- 范围内：
  - proxy `/v1/chat/completions` OpenAI-compatible 入口。
  - Hermes config patch / restore / status。
  - Linux systemd 常驻 proxy 支持。
  - 主面板 Hermes target 状态和 proxy lifecycle。
  - key 隔离与诊断 redact。
- 非范围：
  - Hermes 源码改造。
  - `codex_app_server` 整轮工具接管。
  - Hermes vision/browser_vision 多模态兼容修复。
  - Cursor / Cline / OpenCode 等其他 target。

## 2. 完成门槛

1. 计划内自动化用例全部通过。
2. P0 用例通过率 100%。
3. `npm test` 连续两轮稳定通过。
4. 服务器 smoke 和微信手测完成前，不得标记 release-ready。
5. 测试报告必须写明 fake-upstream 证据不能证明真实 provider 可用。

## 3. 主回归基线

### REG

- REG-041-1：`npm test` 全量主回归。
- REG-041-2：`node test/provider-runtime.test.js` 验证既有 provider gateway runtime 不回归。

## 4. V0.4.1 增量用例

### API：Chat Completions Endpoint

- API-041-1：POST `/v1/chat/completions` 路由到 Chat handler，不进入 Anthropic handler。
- API-041-2：非流式请求覆盖 model，使用 active provider model。
- API-041-3：thinking enabled 时按 provider capability 注入 thinking / effort。
- API-041-4：thinking disabled 时不发送启用 thinking 字段。
- API-041-5：stream=true 时保持 SSE chunk 与 `[DONE]`，OpenAI SDK 可消费。
- API-041-6：带工具的 Chat 请求若 `max` effort 被上游 5xx/504 拒绝，自动降到 `high` 重试一次。

### MIG：Hermes Config

- MIG-042-1：临时 `HERMES_CONFIG_PATH` patch 后写入 `model.api_mode=chat_completions`、`model.base_url=<proxy>/v1`。
- MIG-042-2：连续 patch 两次幂等，无重复字段。
- MIG-042-3：restore 后原配置 byte-equivalent 恢复。
- MIG-042-4：config 缺失时清晰失败，不创建错误配置。

### KEY：Secret Safety

- KEY-042-1：Hermes config 不包含真实 provider key。
- KEY-045-1：诊断输出 redact key/token/secret/password。
- KEY-045-2：fake upstream 捕获到真实 provider Authorization 只由 proxy 注入，Hermes client 配置只用本地占位 token。

### ADP：Linux / Target Adapter

- ADP-043-1：mock Linux systemd 环境下生成 service，包含 config dir、proxy.js 路径和 Node runtime。
- ADP-043-2：非 systemd 环境返回 unsupported，不伪装自启成功。
- ADP-044-1：Hermes config 存在/缺失时 target availability 正确。

### SWC：State / Lifecycle

- SWC-044-1：Claude/Codex 关闭但 Hermes 开启时，proxy 不停止。
- SWC-044-2：Claude/Codex/Hermes 全关闭时，proxy 停止且 autostart 卸载。
- SWC-044-3：Hermes config drift 后 repair 恢复本地 proxy 配置。

### EVD：Server Evidence

- EVD-043-1：服务器上 `deepseek-claude-proxy.service` active，`/__health` 返回 OK。
- EVD-045-1：`hermes` 用户通过 Hermes chat runtime 经 proxy 获得文本回复。
- EVD-045-2：proxy 日志出现 `CHAT_DONE`，证明 Hermes 请求命中新 endpoint。

### MAN：Manual Release Checks

- MAN-045-1：微信发“只回复 OK”，收到 OK，日志无 proxy failure。
- MAN-045-2：触发 browser/vision 类请求时，如失败，诊断能解释为 DeepSeek/Hermes vision 非范围兼容问题。

## 5. 执行顺序

1. Unit：Hermes patcher、Linux adapter、diagnostic redact。
2. Integration：proxy fake upstream `/v1/chat/completions`、target lifecycle。
3. Regression：`npm test`。
4. Server Smoke：SSH 到 `ip-server-312532` 验证 service、health、Hermes chat。
5. Manual：微信端到端。
6. 自动修复循环最多 3 轮；环境阻塞时停止宣称通过。

## 6. 输出产物

- `自动化测试/V0.4.1/TEST_REPORT.md`
- `自动化测试/V0.4.1/SERVER_SMOKE.md`（实现和真机验证阶段生成）
- 命令执行结果摘要

## 7. 命令契约

工作目录：

```bash
cd /Users/yunshu/Documents/projects/deepseek/deepseek-claude-setup
```

本地门禁：

```bash
npm test
```

服务器 smoke 初稿：

```bash
ssh ip-server-312532 'curl -fsS http://127.0.0.1:17861/__health'
ssh ip-server-312532 'sudo -iu hermes bash -lc "export HERMES_HOME=/var/lib/hermes; hermes doctor"'
```

第三条 Hermes chat smoke 需在实现后从实际命令中验证，未验证前不得作为 release evidence。
