# TEST_REPORT（V1.6.5）

## 1. 结果摘要

- 日期：2026-06-14
- 分支：`codex/custom-model-crud`
- PRD：`docs/prd/已开发完成/md/03-provider-gateway/PRD-020-v1.6.5-custom-model-crud.md`
- 结论：PASS

## 2. 执行命令与结果

| Command | Result | Notes |
|---|---|---|
| `node --check test/config-wizard-flow.test.js` | PASS | 新增测试文件语法检查通过 |
| `node test/config-wizard-flow.test.js` | PASS | 4/4；覆盖新增、修改、删除、取消不落盘 |
| `npm test` | PASS | 145/145；主回归、配置向导全流程、Hermes、certification、proxy-bundle 全部通过 |
| `git diff --check` | PASS | 无 whitespace error |
| `npm pack --dry-run` | PASS | `deepseek-claude-setup@1.6.5` 打包清单包含新增测试与模型 helper |
| `npm run certify:provider -- --provider zai --dry-run --report-root /tmp/deepseek-v165-zai-dry-run` | PASS command / dry-run report not certified | `planReady=true`，`passed=false`，不调用真实 API |

## 3. 分层覆盖结果

- Unit：73/73 PASS（包含自定义模型 CRUD 纯函数与旧配置兼容）
- Integration：51/51 PASS（certification/report/release gate/token usage 相关回归）
- E2E：4/4 PASS（配置向导 prompt harness 全流程）
- Hermes：12/12 PASS
- Proxy bundle：5/5 PASS

## 4. 失败用例

- 用例 ID：E2E-01
- 现象：新增 ZAI 自定义模型时，`customModels` 意外包含 DeepSeek 的 `ds-custom`。
- 根因：`configWizard()` 切换到未配置 provider 时，使用了旧 active provider 的 `normalized.model` / `normalized.apiKey` 作为 fallback。
- 修复状态：已修复。现在 API Key 与模型预填只读取当前 `providers[providerId]`；旧版扁平 DeepSeek 配置仍由 `normalizeConfig()` 迁移后读取。

## 5. 剩余风险（人工补测）

- 风险点：真实终端里的交互顺滑度、文案理解成本、用户误操作感受。
- 自动化无法完全覆盖原因：prompt harness 验证逻辑分支和落盘结果，但不评估真实终端视觉体验。

## 6. 发布门禁

- 门禁检查状态：本机离线发布前门禁通过。
- 最终决策：可进入 review/合并；正式发布仍按项目流程在 `main` 上做最终回归和 tag。
