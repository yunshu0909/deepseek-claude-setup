# V1.5.0 Provider Certification TEST_REPORT

## Current Round

- 分支：`codex/v1.5.0-provider-certification`
- 本机平台：macOS / `darwin`
- 本机 CLI：`claude` 与 `codex` 均存在
- 当前发布口径：v1.5.0 发布 Provider Certification Automation 开发者认证底座，不声明三平台 true-key 正式认证报告已全部归档
- 当前修复轮次真 Key：Mac 开发树完整认证已通过；开发树报告 `PASS=55, FAIL=0, BLOCKED=0, SKIPPED=0`
- Linux：`TC-044` 改为只接受服务器本机生成的 Linux 报告，需后续在服务器本机重跑归档

## Commands Run

| Command | Result | Notes |
|---|---|---|
| `npm test` | PASS | 发布前最终回归：主测试 57/0，Hermes 12/0，认证测试 42/0 |
| `npm run certify:provider -- --provider deepseek --dry-run` | PASS command / report not certified | 标准默认报告目录可用；`planReady=true`，`passed=false` |
| `CLIENT_E2E_SEQUENCE='claude:pro:on:high -> claude:flash:off:- -> codex:pro:on:max -> codex:flash:off:-' npm run e2e:clients` | PASS | 同一临时配置根目录内重启 gateway；验证切到 Flash 后首请求无 Pro 残留 |
| `env -u DEEPSEEK_API_KEY npm run certify:provider -- --provider deepseek` | expected BLOCKED | 标准默认报告目录可用；`TC-001` 引用完整 `npm test`；`TC-009` 引用缺 Key 证据；Darwin 报告不含 Linux-only `TC-044`，`PASS=9, BLOCKED=46, FAIL=0, passed=false` |
| `env -u DEEPSEEK_API_KEY npm run e2e:clients` | expected BLOCKED | `status=BLOCKED`，message=`DEEPSEEK_API_KEY is required` |
| `DEEPSEEK_API_KEY=<redacted> CLIENT_E2E_MODEL=deepseek-v4-flash CLIENT_E2E_THINKING=disabled CLIENT_E2E_TARGETS=claude-text npm run e2e:clients` | PASS | Flash + thinking off 的固定 `TEXT_OK` marker、health 与 gateway 字段均命中 |
| `DEEPSEEK_API_KEY=<redacted> CLIENT_E2E_TARGETS=codex-long CLIENT_E2E_LONG_TIMEOUT_MS=900000 npm run e2e:clients` | PASS | `toolRounds=8`；模型自测、runner 黑盒复测、静态检查和 workspace 快照均通过 |
| `DEEPSEEK_API_KEY=<redacted> npm run certify:provider -- --provider deepseek` | PASS on dirty Mac worktree | Darwin 适用用例 `55/55 PASS`；不含 Linux-only `TC-044`；报告 `dirty=true`，不得作为正式 release report |

## Implemented Evidence

- `scripts/client-e2e.js` 已实现 capture 与 true-key 双模式。
- true-key 模式会使用临时 gateway、临时 `CLAUDE_CONFIG_DIR`、临时 `CODEX_HOME`、临时 workspace。
- 已实现 `claude-text`、`claude-tool`、`claude-command`、`codex-tool`、`codex-command`、`codex-long`、`claude-long`。
- 每轮 gateway 支持独立 `DEEPSEEK_CLAUDE_LOG_PATH`，client report 会记录 stdout/stderr 摘要、gateway log slice、workspace 文件快照、正向断言与 evidence refs。
- `scripts/certify-provider.js` 已按 runner case 映射 TC-014~TC-023、TC-037~TC-038、TC-051~TC-052；TC-024~TC-031 使用同一临时配置根目录的重启切换序列逐条断言；TC-039~TC-047 不再批量硬编码 PASS。
- true-key case 会校验 gateway health，并从本轮 gateway 日志核对 model/thinking/effective effort；Claude 与 Codex 均纳入该门禁。
- 长任务门禁会校验生成文件、模型自测、runner 黑盒复测、静态检查及工具轮次数范围；不再只接受模型自报成功。
- 工具任务的期望随机值不再写入 prompt，避免未读取文件也命中 marker。
- 阶段 0 会实际执行完整 `npm test`、缺 provider、未知 provider 和阶段阻断 fixture，并将证据保存在 run 目录。
- client evidence 改为每轮独立文件，包含真实配置 before/after hash、临时目录清理结果和证据扫描结果；泄露 Key 时 TC-046 自动失败。
- release gate 已校验目标发布分支、相同 commit、唯一 runnerId、平台 provenance、P0 可读 evidence 引用，并拒绝 capture-only/BLOCKED/零断言假绿。
- `package.json` 已提供 `certify:release`，release gate 不需要维护者手工调用内部文件。
- `scripts/certification/linux-hermes-smoke.js` 只允许在 Linux 服务器本机纳入正式报告，使用临时 Hermes config 与 transient systemd gateway 执行 `HERMES_OK` smoke，要求输出 `systemctl status` 摘要、gateway log 非空、存在完成标记，并扫描完整 key 与 12/16/24 位长片段；结束后自动清理，不改真实 Hermes config。
- Linux runner 的 Key 仅通过子进程环境传递，不再被拼入 SSH 命令参数；Mac 发起的远端 smoke 不可冒充 Linux report；`TC-044` 还必须从 transient gateway 的 `/__health` 实际回包验证模型与 thinking/effort。
- 通用 secret scan 改为分块扫描所有大小文件，不再跳过大于 1 MiB 的日志或证据产物。
- 真实长任务首次执行发现黑盒断言错误绑定了 todo 列表标点格式；已修为校验顺序、内容与完成状态语义，重跑通过。
- 完整认证首次执行发现 `codex-command` 已运行测试成功但因最终自然语言未复述 marker 被误判；已改为以独立 `node test.js` 输出为执行证据，单项和完整重跑均通过。
- 本轮完整认证首次执行发现 Flash 短文本按较长固定 marker 回答时出现模型转写误差；保持“精确 marker”门禁，将固定 marker 缩短为 `TEXT_OK` 后定向及完整重跑通过。
- 本轮完整认证第二次执行发现 `test.js` 通过变量路径读取 `todo.json` 时被静态规则误判；已支持实际执行的变量路径读取，并在报告中保留脱敏 workspace 内容与 hash，定向及完整重跑通过。

## Post-release Validation

- Mac true-key 正式基准报告：建议在 v1.5.0 clean commit 上重跑 `DEEPSEEK_API_KEY=<redacted> npm run certify:provider -- --provider deepseek` 并归档。
- Linux Hermes 真场景：需要将 v1.5.0 同步至服务器后，在 Linux 仓库本机执行 `--target hermes-linux` 生成独立 report。
- Windows 报告：由 Windows 真机独立运行同一认证命令，用户人工合并结果。
- 这些是后续基准证据归档，不再阻断 v1.5.0 作为开发者认证底座发布。

## Certification Conclusion

v1.5.0 的自动化认证逻辑已达到开发者可用状态，发布目标是把 Provider Certification Automation 作为后续接入和回归的底座交付给仓库。Mac 开发树已完成真实 DeepSeek 自动化认证，Darwin 适用用例 `55/55 PASS`，包含 Claude/Codex 短长任务、模型与 thinking/effort 控制、隔离清理、脱敏和防假绿门禁。DeepSeek 三平台正式 true-key 报告仍需在 v1.5.0 clean commit 上逐台重跑并归档。
