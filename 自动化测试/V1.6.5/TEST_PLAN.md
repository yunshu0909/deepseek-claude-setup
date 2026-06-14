# TEST_PLAN（V1.6.5）

## 1. 测试范围

- PRD：`docs/prd/已开发完成/md/03-provider-gateway/PRD-020-v1.6.5-custom-model-crud.md`
- 范围内：
  - 内置模型组只读，只允许选择，不允许新增、编辑、删除。
  - 用户自定义模型组支持新增、查看、修改、删除。
  - 删除当前自定义模型时必须显式选择替代模型。
  - 配置向导从 provider 选择到确认保存的真实交互路径。
  - 旧配置兼容、不同 provider 的 `customModels` 隔离。
- 非范围：
  - 真实 provider API 调用。
  - 真实用户 `~/.deepseek-claude`、`~/.claude`、`~/.codex` 配置改写。
  - 主面板开关和真实 provider certification 长链路。

## 2. 完成门槛

1. 计划内用例全部通过。
2. P0 用例通过率 100%。
3. 新增配置向导全流程测试不调用真实 provider API。
4. 新增配置向导全流程测试只写临时 `DEEPSEEK_CLAUDE_CONFIG_DIR`。
5. 无阻断/严重缺陷遗留。

## 3. 用例清单

### Unit

- UT-01：内置模型不会被写入 `customModels`。
- UT-02：新增自定义模型会 trim、去重，并置为当前模型。
- UT-03：修改自定义模型会替换数组项；若旧 ID 是当前模型，同步更新当前模型。
- UT-04：删除非当前自定义模型只移除数组项。
- UT-05：删除当前自定义模型必须提供替代模型，并同步当前 `model`。
- UT-06：不能编辑/删除内置模型。
- UT-07：不同 provider 的 `customModels` 互不影响。

### Integration

- IT-01：旧配置归一化仍保留 `customModels`。
- IT-02：`buildProviderConfig()` 仅覆盖当前 provider 的 `apiKey/model/customModels`，保留其它 provider 配置。
- IT-03：切换到未配置 provider 时，不继承上一 active provider 的 key/model。

### E2E

- E2E-01：选择 ZAI，输入 key，新增 `glm-5.2`，确认保存。
- E2E-02：DeepSeek 当前自定义模型 `ds-old` 修改为 `ds-new`，确认保存。
- E2E-03：Kimi 删除当前自定义模型 `kimi-custom`，选择内置 `kimi-k2.6` 替代，确认保存。
- E2E-04：管理自定义模型过程中 cancel，`configWizard()` 返回 `null`，临时 `config.json` 不被改写。

## 4. 执行顺序

1. `node --check test/config-wizard-flow.test.js`
2. `node test/config-wizard-flow.test.js`
3. `npm test`
4. `git diff --check`
5. `npm pack --dry-run`
6. `npm run certify:provider -- --provider zai --dry-run --report-root /tmp/deepseek-v165-zai-dry-run`

## 5. 输出产物

- `test/config-wizard-flow.test.js`
- `自动化测试/V1.6.5/TEST_REPORT.md`
- README 测试数量更新到 `145`
- PRD-020 与测试用例补充配置向导全流程证据
