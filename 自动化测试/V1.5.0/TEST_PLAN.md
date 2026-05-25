# V1.5.0 Provider Certification TEST_PLAN

## Scope

本计划覆盖 PRD-015 / V1.5.0 Provider Certification 自动化认证器开发。目标是让 DeepSeek provider 的认证报告能区分真实 PASS、环境 BLOCKED 与失败，不允许用 capture-only、artifact-only 或 stub 结果冒充 release-ready。

## Branch

- 开发分支：`codex/v1.5.0-provider-certification`
- 版本范围：V1.5.0 Provider Certification Automation
- Provider：`deepseek`

## Required Commands

### Local artifact and capture gates

```bash
npm test
npm run certify:provider -- --provider deepseek --dry-run
env -u DEEPSEEK_API_KEY npm run certify:provider -- --provider deepseek
CLIENT_E2E_SEQUENCE='claude:pro:on:high -> codex:flash:off:-' npm run e2e:clients
env -u DEEPSEEK_API_KEY npm run e2e:clients
```

### Mac true-key gates

```bash
DEEPSEEK_API_KEY=... CLIENT_E2E_TARGETS=claude-text,claude-tool,claude-command,codex-tool,codex-command npm run e2e:clients
DEEPSEEK_API_KEY=... CLIENT_E2E_TARGETS=codex-long,claude-long CLIENT_E2E_LONG_TIMEOUT_MS=900000 npm run e2e:clients
DEEPSEEK_API_KEY=... npm run certify:provider -- --provider deepseek
```

### Linux Hermes gate（登录 Linux 服务器后在仓库本机执行）

```bash
cd /path/to/deepseek-claude-setup
DEEPSEEK_API_KEY=... npm run certify:provider -- --provider deepseek --target hermes-linux
```

SSH 仅用于进入服务器和同步该分支；正式 `report.json` 必须由 Linux 服务器本机生成，不能把远端 smoke 合并为 Mac/Windows 平台证据。

## Case Mapping

| TC Range | Runner | Expected Evidence |
|---|---|---|
| TC-001~TC-008 | `npm test` + certifier self-check | artifact report |
| TC-010~TC-013 | `scripts/provider-smoke.js` | true DeepSeek HTTP/gateway response |
| TC-014~TC-023, TC-051~TC-052 | `scripts/client-e2e.js` true-key CLI mode | Claude Code / Codex isolated temp homes, gateway log slices |
| TC-024~TC-031 | `scripts/client-e2e.js` capture mode | captured model/thinking/effort fields |
| TC-032~TC-036 | baseline unit tests | streaming/tool-call regression evidence |
| TC-037~TC-038 | `client-e2e` long tasks | generated todo CLI, blackbox retest, static checks |
| TC-039~TC-043, TC-045~TC-047 | Hermes/unit artifact tests | config/systemd/report-writer evidence |
| TC-044 | `scripts/certification/linux-hermes-smoke.js`（Linux 本机） | transient systemd active, isolated Hermes config, `HERMES_OK` |
| TC-048~TC-055 | release gate self-check | rejection of fake-green reports |
| TC-056 | long-task blackbox result | both Claude and Codex long task retests |

## Acceptance Gate

- `--dry-run` 只能输出 `planReady=true`，不得输出 `passed=true`。
- 缺 `DEEPSEEK_API_KEY`、缺 CLI 或缺 Linux SSH 信息时，对应用例必须 `BLOCKED`。
- 有真 Key 且本机 CLI 可用时，Mac 本机 P0 true-key 客户端项不得继续被批量 BLOCKED。
- `CLIENT_E2E_REAL_CLI=1` 不再作为真实 CLI 运行门槛。
- 长任务有效工具调用轮数必须在 `[3,10]`，超过 10 轮按 client 失败处理。
- 报告、stdout/stderr 摘要、gateway log slice 和证据产物不得包含真实 API Key。
- release gate 必须拒绝缺平台、dirty report、capture-only、artifact-only、SKIPPED、BLOCKED 与零断言假绿。
- `TC-044` 仅属于 Linux 报告；Mac/Windows 不得因缺 Linux 专项被假阻断，也不得代填 Linux PASS。
