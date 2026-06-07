# TEST_REPORT（V0.4.1）

## 1. 结果摘要

- 日期：2026-05-24
- PRD：`/Users/yunshu/Documents/projects/deepseek/docs/prd/未开发完成/md/PRD-004.1-v0.4.1-hermes-target.md`
- 分支：`codex/v0.4.1-hermes-target`
- npm 版本：v1.4.1（发版准备）
- 本地自动化结论：PASS
- 服务器真实 smoke：PASS
- 发布结论：待用户确认发版（微信端到端未跑，且本版代码当前通过 rsync 部署到服务器，不是 npx/main 分发）

## 2. 执行命令与结果

- `node test/hermes-target.test.js`
  - result：PASS
  - total：21 passed, 0 failed

- `npm test`
  - round：1
  - result：PASS
  - summary：`test.js 71/0`、`provider-runtime 3/0`、`adapter 11/0`、`hermes-target 21/0`
  - total：106 passed, 0 failed

- `npm test`
  - round：2
  - result：PASS
  - summary：`test.js 71/0`、`provider-runtime 3/0`、`adapter 11/0`、`hermes-target 21/0`
  - total：106 passed, 0 failed

- Server smoke
  - result：PASS
  - artifact：`自动化测试/V0.4.1/SERVER_SMOKE.md`

- Weixin manual E2E
  - result：not-run
  - reason：本次代码只接管 Hermes 模型出口，不改微信 gateway；微信账号真实手测仍需用户触发。

## 3. 分层覆盖结果

- Unit：12/12
- Integration：9/9
- Regression：85/85
- Local automated total：106/106
- Server true-env：3/3
- Manual：0/2（未运行）

## 4. V0.4.1 用例结果

| ID | Result | Evidence |
|---|---|---|
| REG-041-1 | PASS | `npm test` 两轮全绿 |
| REG-041-2 | PASS | `node test/provider-runtime.test.js` 随 `npm test` 通过 |
| API-041-1 | PASS | fake upstream 捕获 `/chat/completions` 与 model override |
| API-041-2 | PASS | non-stream JSON 透传 |
| API-041-3 | PASS | thinking enabled 注入 `thinking.type=enabled` + `reasoning_effort=max` |
| API-041-4 | PASS | thinking disabled 不发送 `reasoning_effort` |
| API-041-5 | PASS | SSE chunk 与 `[DONE]` 透传 |
| API-041-6 | PASS | 工具请求上游 5xx 后，proxy 降到 `high` 重试一次 |
| MIG-042-1 | PASS | Hermes config 写 `api_mode=chat_completions`、`base_url=<proxy>/v1` |
| MIG-042-2 | PASS | 连续 patch 幂等 |
| MIG-042-3 | PASS | restore byte-equivalent 恢复 |
| MIG-042-4 | PASS | 缺失 config 清晰报错且不创建文件 |
| KEY-042-1 | PASS | Hermes config 不含真实 provider key |
| KEY-045-1 | PASS | diagnose 输出不含 mock 真 key |
| KEY-045-2 | PASS | 上游 Authorization 由 proxy 注入 |
| ADP-043-1 | PASS | mock systemd 生成 service unit |
| ADP-043-2 | PASS | 非 systemd 返回 unsupported |
| ADP-044-1 | PASS | Hermes available/patched 状态正确 |
| SWC-044-1 | PASS | Hermes 仍接入时 proxy 不停止 |
| SWC-044-2 | PASS | 三 target 全关时 stop + uninstall |
| SWC-044-3 | PASS | drift 后 re-patch 修回本地 proxy |
| EVD-043-1 | PASS | 服务器 `deepseek-claude-proxy.service` active/enabled，health OK |
| EVD-045-1 | PASS | `sudo -iu hermes hermes -z ...` 返回 `OK` |
| EVD-045-2 | PASS | proxy log 出现 `CHAT_DONE`，Hermes 默认请求 `tools=28` 命中新 endpoint |
| MAN-045-1 | not-run | 微信真实会话需用户触发 |
| MAN-045-2 | not-run | vision 边界人工确认，本版不修 vision |

## 5. 失败用例与修复

- 初始现象：Hermes 默认 oneshot 在 `reasoning_effort=max` + `tools=28` 时出现 504。
- 根因：DeepSeek 对大工具集 + max effort 的 Chat Completions 请求偶发/稳定超时。
- 修复：Chat endpoint 对带工具请求保留首发 `max`；若上游返回 5xx/504 且尚未向客户端写响应，则自动降到 `high` 重试一次。
- 修复验证：
  - fake-upstream：API-041-6 PASS。
  - 服务器：Hermes 默认 oneshot 返回 `OK`；日志显示 `msgs=2 tools=28 ... effort=max` 后 `CHAT_DONE`。

## 6. 剩余风险（人工补测）

- 微信端到端：未跑。原因是需要用户真实微信入口触发；本版没有修改微信 gateway。
- vision/browser_vision：未修。原因是 DeepSeek 对 Hermes `image_url` 形状不兼容属于 PRD 非范围；当前只诊断并标边界。
- npx 分发：服务器当前通过 rsync 部署本分支代码；普通 `npx github:yunshu0909/deepseek-claude-setup` 仍取 `main`，需合并/推送后才能分发。

## 7. 发布门禁

- Implementation Gate：PASS（`npm test` 连续两轮通过）
- Server Smoke Gate：PASS
- Manual Weixin Gate：not-run
- 最终决策：代码可以进入发版准备；是否跳过微信手测发布，需用户确认。
