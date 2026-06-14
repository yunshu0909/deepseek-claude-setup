# V1.6.2 Provider Certification Trust + Token Usage TEST_REPORT

## Current Round

- 分支：`codex/fix-provider-certification-tests`
- 本机平台：macOS / `darwin`
- 目标版本：`v1.6.2`
- 本机 CLI：Claude Code `2.1.177`、Codex `0.140.0-alpha.2`
- 发布口径：macOS 三 provider 真 key 认证通过；三平台 release gate 仍需 Windows/Linux 同 commit 报告

## Commands Run

| Command | Result | Notes |
|---|---|---|
| `node test/certification.test.js` | PASS | 49/0；覆盖 token normalizer、log parser、usage merger、capture/provider args |
| `npm test` | PASS | 主测试 58/0，Hermes 12/0，certification 49/0，proxy-bundle 5/0 |
| `npm run certify:provider -- --provider zai --dry-run --report-root /tmp/deepseek-token-usage-zai-dry` | PASS command / report not certified | `planReady=true`、`passed=false`、`tokenUsage.requests=0` |
| `npm run certify:provider -- --provider deepseek --expected-branch codex/fix-provider-certification-tests` | PASS | macOS true-key `PASS 55/55`，带 tokenUsage |
| `npm run certify:provider -- --provider zai --expected-branch codex/fix-provider-certification-tests` | PASS | macOS true-key `PASS 55/55`，带 tokenUsage |
| `npm run certify:provider -- --provider kimi --expected-branch codex/fix-provider-certification-tests` | PASS | macOS true-key `PASS 55/55`，Kimi 部分请求未返回 usage，计入 missing |
| `git diff --check` | PASS | 无 whitespace error |

## True-key Reports

| Provider | Report | PASS | FAIL | BLOCKED | SKIPPED | Requests | Total Tokens | Missing Usage |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek | `reports/provider-certification/deepseek-darwin-2026-06-14T07-01-41-724Z/report.json` | 55 | 0 | 0 | 0 | 38 | 232,963 | 0 |
| ZAI | `reports/provider-certification/zai-darwin-2026-06-14T07-06-16-555Z/report.json` | 55 | 0 | 0 | 0 | 34 | 150,979 | 0 |
| Kimi | `reports/provider-certification/kimi-darwin-2026-06-14T07-11-28-857Z/report.json` | 55 | 0 | 0 | 0 | 32 | 130,203 | 13 |

## Implemented Evidence

- capture runner 使用 Provider Gateway config，按 provider profile 映射 `pro/flash`。
- capture 每步断言 `/__health.provider`，防止非 DeepSeek provider 跑偏。
- capture assertions 改为 capability-aware，ZAI/Kimi 禁止 DeepSeek-only effort 字段。
- `certify:provider` 新增 `--model` / `--flash-model` / `--expected-branch`。
- `provider-smoke` 的 `pro/flash` alias 改为 provider-aware。
- gateway 新增 usage normalizer，日志输出 `usage=input/output/total`。
- `client-e2e` 每个 case 和 attempt 都记录 `tokenUsage`。
- `certify-provider` 汇总 smoke、client、Linux Hermes 的 `tokenUsage` 到最终报告。
- `report.md` 增加 token 摘要。
- README、package version、package-lock version 更新到 `1.6.2`。
- PRD-017 和本测试计划/报告已补齐。

## Known Limits

- 本轮未跑 Windows/Linux 完整认证；正式 release gate 仍需三平台同 commit 报告。
- tokenUsage 只统计 token，不做金额估算。
- provider 未返回 usage 时计入 `missingUsageCount`；Kimi 本轮有 13 个请求未返回 usage。
- 旧报告没有 `tokenUsage` 仍可被 release gate 读取；当前 release gate 不以 tokenUsage 为硬门禁。

## Conclusion

V1.6.2 在 macOS 开发分支上完成代码实现、离线回归和三 provider 真 key 认证。自动化认证现在可以可信地区分 provider/model/thinking/effort 路由，并能在最终报告中展示真实 API token 用量。该分支可进入 review/commit；正式发布仍需按 PRD-015 的三平台 release gate 补齐 Windows/Linux 报告。
