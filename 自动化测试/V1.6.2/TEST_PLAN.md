# V1.6.2 Provider Certification Trust + Token Usage TEST_PLAN

## Scope

本计划覆盖 PRD-017 / V1.6.2。目标是修复多 provider certification 的假绿风险，补齐新增模型显式认证入口，并在真实 API 认证报告里记录 tokenUsage。

## Branch

- 开发分支：`codex/fix-provider-certification-tests`
- 目标版本：`v1.6.2`
- Provider：`deepseek` / `zai` / `kimi`

## Required Commands

### Offline gates

```bash
node test/certification.test.js
npm test
npm run certify:provider -- --provider zai --dry-run --report-root /tmp/deepseek-token-usage-zai-dry
CLIENT_E2E_PROVIDER=deepseek CLIENT_E2E_SEQUENCE='claude:pro:on:max -> codex:pro:on:max -> claude:flash:off:- -> codex:flash:off:-' CLIENT_E2E_MODE=capture npm run e2e:clients
CLIENT_E2E_PROVIDER=zai CLIENT_E2E_SEQUENCE='claude:pro:on:max -> codex:pro:on:max -> claude:flash:off:- -> codex:flash:off:-' CLIENT_E2E_MODE=capture npm run e2e:clients
CLIENT_E2E_PROVIDER=kimi CLIENT_E2E_SEQUENCE='claude:pro:on:max -> codex:pro:on:max -> claude:flash:off:- -> codex:flash:off:-' CLIENT_E2E_MODE=capture npm run e2e:clients
```

### macOS true-key gates

```bash
set -a; source .env; set +a
npm run certify:provider -- --provider deepseek --expected-branch codex/fix-provider-certification-tests
npm run certify:provider -- --provider zai --expected-branch codex/fix-provider-certification-tests
npm run certify:provider -- --provider kimi --expected-branch codex/fix-provider-certification-tests
```

### New model certification gate

```bash
npm run certify:provider -- --provider <id> --model <new-model> --flash-model <secondary-model>
```

### Release gate after merge

```bash
npm run certify:release -- <mac-report> <windows-report> <linux-report>
```

正式 release gate 必须在 clean worktree、目标分支、同一 commit 的三平台报告上执行。本轮 macOS 开发分支报告不能单独声明三平台发布全绿。

## Case Mapping

| Area | Runner | Expected Evidence |
|---|---|---|
| Capability-aware capture | `scripts/lib/capture-runner.js` + `capture-asserts.js` | `health.provider` 正确；ZAI/Kimi 无 DeepSeek effort 字段 |
| New model args | `scripts/certify-provider.js` / `scripts/provider-smoke.js` | `--model` / `--flash-model` 生效，`pro/flash` 按 provider profile 解析 |
| Token usage runtime | `proxy/usage.js` + gateway logs | `MSG_DONE` / `RESPONSES_DONE` / `CHAT_DONE` 输出 usage |
| Token usage report | `scripts/lib/token-usage.js` | final `report.json.tokenUsage` 汇总 |
| True-key certification | `certify:provider` | 三 provider macOS `PASS 55/55` |

## Acceptance Gate

- capture 模式不得把 `zai/kimi` 实际跑成 `deepseek`。
- ZAI/Kimi capture 不得出现 DeepSeek-only effort 字段。
- `certify:provider -- --model/--flash-model` 可用于新增模型认证。
- dry-run 报告包含空 `tokenUsage`，且仍 `passed=false`。
- 完整 true-key 报告包含非空 `tokenUsage.records`。
- provider 未返回 usage 时只增加 `missingUsageCount`，不阻断认证。
- 不输出金额估算。
- README、package version、PRD registry 都同步到 `v1.6.2`。
