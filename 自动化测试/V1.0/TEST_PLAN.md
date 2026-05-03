# TEST_PLAN（V1.0）

## 1. 测试范围
- PRD：/Users/yunshu/Documents/cc-diaodu/六幺/docs/prd/PRD-001.md
- 范围内：
  - 配置持久化保存 API Key、模型、思考强度
  - Claude Code settings 指向本地代理，并同步模型、effort、auth env
  - 本地代理转发 Anthropic 请求到 DeepSeek Anthropic 路径
  - 本地代理强制注入/覆盖 `model`、`thinking.type`、`output_config.effort`
  - settings 多次 patch 后可还原原始配置
- 非范围：
  - 真实 DeepSeek API 计费请求
  - 终端交互 UI 人工体验细节
  - macOS LaunchAgent 的系统级启动验证

## 2. 完成门槛
1. 计划内自动化用例全部通过
2. P0 用例通过率 100%
3. 关键测试可在临时目录中重复执行，不污染真实 `~/.claude`
4. 无阻断/严重缺陷遗留

## 3. 用例清单
### Unit
- UT-01：`config-store` 可读写 `apiKey/model/effort`
- UT-02：`settings-patcher.patch(config)` 写入 Claude Code 所需 env 和 settings 字段
- UT-03：`settings-patcher.restore()` 在多次 patch 后仍还原原始 settings
- UT-04：备份缺失时的兜底 restore 不会让 Claude Code 指向已停止的本地代理
- UT-05：思考模式关闭时 settings 不写入强制 effort，并将 `alwaysThinkingEnabled=false`

### Integration
- IT-01：代理 `/__health` 返回当前模型、thinking、effort
- IT-02：代理把请求转发到 `/anthropic/v1/messages` 并保留 query string
- IT-03：代理转发前覆盖 `model`、`thinking.type`、`output_config.effort`
- IT-04：代理使用保存的 DeepSeek API Key 设置上游鉴权头
- IT-05：思考模式关闭时代理转发 `thinking.type=disabled` 且移除 `output_config`

### E2E
- E2E-01：在临时配置目录启动代理，向本地假 DeepSeek 上游发送请求，验证完整转发链路
- E2E-02：在临时配置目录切换到思考关闭模式，验证代理重启后的实际请求体

## 4. 执行顺序
1. Unit
2. Integration
3. E2E
4. 自动修复循环（最多 3 轮）

## 5. 输出产物
- TEST_REPORT.md
- 可复现命令：`npm test`
