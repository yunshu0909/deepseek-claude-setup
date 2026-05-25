# PRD-015 实现覆盖独立审查报告

- 审查日期：2026-05-25
- PRD：`/Users/yunshu/Documents/projects/deepseek/docs/prd/未开发完成/md/PRD-015-v1.5.0-provider-certification.md`
- 测试用例：`/Users/yunshu/Documents/projects/deepseek/docs/prd/未开发完成/md/PRD-015-v1.5.0-provider-certification-测试用例.md`
- 实现工作树：`/Users/yunshu/Documents/projects/deepseek/deepseek-claude-setup-v1.5.0`
- 目标分支：`codex/v1.5.0-provider-certification`
- 审查方式：只读静态比对现有代码与已有产物；未运行会产生认证新产物或修改用户配置的测试命令。

## 1. 结论

**结论：FAIL。当前实现不能满足 PRD-015 的正式 release gate。**

实现工作树已经具备认证入口、profile、分阶段执行、报告生成、Claude/Codex true-key runner、capture、Linux Hermes runner 与 release gate 的主体代码。但存在两个 P0 阻断：

1. 真实 macOS 报告会被来源校验固定判失败，因采集的 `osRelease` 与门禁期望格式不一致。
2. 三平台报告中的证据引用为各平台本机绝对路径，release gate 在汇总机器上要求这些路径均可读取，正常收集 Mac/Windows/Linux 报告后无法完成汇总门禁。

此外，阶段 0 未隔离真 Key、安全扫描存在漏检路径、长任务执行合同被收紧并改写。现有文件证据只能证明一份 dirty 的 Darwin 开发树报告宣称适用的 55 项 PASS；不能证明 clean Mac、Windows、Linux/Hermes 或最终发布门禁通过。

## 2. 严重发现

### P0-01 真实 Darwin 报告会被 release gate 错误拒绝

**影响**：即使 Mac 在真实环境完成全部认证并生成 clean 报告，正式三平台 gate 仍不能通过，直接阻断 US-04、US-05 与 TC-055。

**需求证据**

- PRD 要求三平台真实报告可汇总并在全绿后进入发布决策：`PRD-015-v1.5.0-provider-certification.md:199-226,230-258,276-283`。
- TC-055 要求来源字段与平台一致，不能复制冒充：`PRD-015-v1.5.0-provider-certification-测试用例.md:938-952`。

**实现证据**

- 报告采集把 `osRelease` 写为 `os.release()`：`scripts/certification/platform-context.js:51-81`。
- 门禁对 Darwin 要求 `osRelease` 字符串包含 `Darwin`：`scripts/certification/release-gate.js:41-47,56-71`。
- 已存在的真实 Darwin 报告记录 `platform="darwin"`、`osRelease="25.2.0"`：`reports/provider-certification/deepseek-darwin-2026-05-25T10-51-43-758Z/report.json:20-28`；它不含门禁要求的 `Darwin` 字面值。
- 单测通过伪造 `osRelease: "Darwin 25.0.0"` 回避了真实采集格式：`test/certification.test.js:57-63,143-147`。

**复核结果**

- 对上述现有报告调用只读的 `evaluateReleaseGate({ requiredPlatforms: ['darwin'] })`，结果包含失败原因 `platform provenance conflicts with expected platform`（另有该报告本身 `isDirty=true`）。

**判定**：明显实现偏差；真实 Mac 平台 gate 当前不可达。

### P0-02 三平台证据引用不可移交，release gate 无法正常汇总独立报告

**影响**：US-04/US-05 的“三平台独立执行后汇总报告”无法按实现完成。Windows/Linux 报告即使真实生成，将报告目录拷回发布汇总机后，门禁会因本机无法读取生成机绝对路径而失败。

**需求证据**

- PRD 要求 Mac、Windows、Linux 分别生成报告并汇总三份报告：`PRD-015-v1.5.0-provider-certification.md:205-226,237-254`。
- TC-049/TC-053 要求 release gate 读取三平台报告并核验矩阵：`PRD-015-v1.5.0-provider-certification-测试用例.md:842-856,906-920`。

**实现证据**

- 认证器把 `execution.evidenceDir` 下证据文件的本机路径直接写为 `evidenceRefs`：`scripts/certify-provider.js:83-87,136-184,210-237`。
- 已生成 Darwin 报告的 `evidenceRefs` 是 `/Users/.../reports/.../evidence/...` 绝对路径：`reports/provider-certification/deepseek-darwin-2026-05-25T10-51-43-758Z/report.json:76-108`。
- release gate 不以报告目录解析证据，而是对报告内每个原路径直接 `fs.existsSync(ref)`：`scripts/certification/release-gate.js:50-53,82-97`。

**判定**：明显未实现可移交的三平台报告验证协议；正常跨平台汇总路径不可用。需要可携带的相对 evidence 引用或明确的证据包重定位/验证机制。

## 3. 高优先级发现

### P1-01 阶段 0 没有落实“不费 Key”的隔离边界

**影响**：在维护者已设置 `DEEPSEEK_API_KEY` 的完整认证中，阶段 0 执行的 `npm test` 会继承真实 Key。当前测试是否实际使用该 Key 不能由静态代码证明，但认证器没有保证“阶段 0 不费 Key”，后续基础测试扩展时可能在前置门禁前调用真实上游。

**需求证据**

- PRD 规定阶段 0 运行资格地基“不费 Key”，阶段 0 失败时不得进入真 Key：`PRD-015-v1.5.0-provider-certification.md:135-145`。
- TC-001 明确基础测试“无需 API Key”：`PRD-015-v1.5.0-provider-certification-测试用例.md:38-52`。

**实现证据**

- `runBaselineTests()` 直接执行 `npm test`，没有清除 provider Key：`scripts/certify-provider.js:72-80`。
- 公共命令执行器默认继承 `process.env`：`scripts/certification/runner-utils.js:37-47`。
- 基线测试发生在 `DEEPSEEK_API_KEY` 是否缺失的判断之前：`scripts/certify-provider.js:678-687`。

**判定**：实现边界偏差；阶段 0 未被技术性保证为无真 Key 环境。

### P1-02 TC-046 的敏感信息扫描存在可漏检路径

**影响**：报告可能在未覆盖全部产物的情况下把 TC-046 标为 PASS；Linux Hermes 真实链路尤其无法证明临时 gateway 日志中没有 Key 长片段。

**需求证据**

- TC-046 要求扫描“本次 run 目录全部文本文件”，不得出现真实 Key 明文或长片段：`PRD-015-v1.5.0-provider-certification-测试用例.md:794-808`。

**实现证据**

- 通用扫描器遇到大于 1 MiB 的文件直接跳过，不再搜索 key 或前缀：`scripts/certification/report-writer.js:126-146`。
- Linux Hermes smoke 将 gateway log 放在临时目录，退出时删除临时目录：`scripts/certification/linux-hermes-smoke.js:28-34,41`。
- Linux 运行脚本只用 `grep -F "$DEEPSEEK_API_KEY"` 检查完整 Key，不检查长片段；JS 返回值只携带脱敏后的 stdout/stderr，而非供统一扫描的 gateway log：`scripts/certification/linux-hermes-smoke.js:50-52,90-110`。
- 通用 report writer 的长片段策略本来会检查 12/16/24 字符前缀：`scripts/certification/report-writer.js:107-146`，但已删除的 Linux 临时 log 不会进入它的扫描范围。

**判定**：TC-046 部分覆盖但不满足完整门禁要求。

### P1-03 TC-037/TC-038 长任务执行合同与测试用例不一致

**影响**：符合 PRD 的 11 至 20 轮成功任务会被实现误判失败；同时认证执行的 prompt 并非测试用例冻结的首轮 prompt，产生的通过证据不是文档指定场景。

**需求证据**

- Codex 长任务规定最少 3 轮、最多 20 轮，并冻结首轮 prompt：`PRD-015-v1.5.0-provider-certification-测试用例.md:624-657`。
- Claude Code 长任务沿用相同 prompt 与 `[3,20]` 轮数范围：`PRD-015-v1.5.0-provider-certification-测试用例.md:659-676`。

**实现证据**

- runner 将最大轮数定义为 `10`，并在自己的 prompt 中要求尽量控制在 10 次以内：`scripts/client-e2e.js:23-34`。
- Claude 和 Codex 长任务通过条件均以 `<= LONG_TASK_MAX_TOOL_ROUNDS`（即 10）判断：`scripts/client-e2e.js:553-580,632-659`。
- 新增单测也将错误边界固化为 10：`test/certification.test.js:310-313`。

**判定**：实现偏离已冻结测试合同；具备 runner 不等于覆盖 TC-037/TC-038 原场景。

## 4. 次要偏差

### P2-01 TC-056 报告字段名与契约不一致

**影响**：功能判断逻辑已存在，但依赖测试文档 schema 的审阅器无法按约定读取黑盒复测退出码。

**需求证据**

- TC-056 明确要求长任务 report 存在 `blackboxRetest.exitCode=0`：`PRD-015-v1.5.0-provider-certification-测试用例.md:954-967`。

**实现证据**

- runner 直接保留 `runCommand()` 返回的 `status` 字段，判断也读取 `blackboxRetest.status`：`scripts/client-e2e.js:681-713`、`scripts/certify-provider.js:395-402`。
- 已有 client 报告的 `blackboxRetest` 只有 `"status": 0`，没有 `exitCode`：`自动化测试/V1.5.0/CLIENT_E2E_REPORT_LATEST.json:85-91`。

**判定**：字段契约偏差；黑盒复测逻辑本体已有实现。

## 5. 用户故事与 AC 覆盖

| 用户故事 / AC | 状态 | 代码与产物证据 | 说明 |
|---|---|---|---|
| US-01 AC1 DeepSeek 认证入口与运行目录 | 已覆盖（当前工作树） | `package.json:9-14`; `scripts/certify-provider.js:627-735`; `scripts/certification/report-writer.js:25-40` | 当前实现文件仍为工作树未提交内容，正式分支提交态未证实。 |
| US-01 AC2 通过 provider id 选择 profile | 已覆盖 | `scripts/certification/provider-profiles.js:101-123,149-173`; `scripts/certify-provider.js:634-660` | 未见硬编码后静默回落 DeepSeek 的行为。 |
| US-01 AC3 未支持 provider 不假绿 | 已覆盖 | `scripts/certify-provider.js:643-660`; `test/certification.test.js:233-249` | 会返回 `passed=false` / `preflight`。 |
| US-02 AC1 阶段 0 失败阻断后续 | 已覆盖但有边界偏差 | `scripts/certify-provider.js:109-133,673-706`; `test/certification.test.js:251-263` | 阶段阻断实现存在；P1-01 指出正常阶段 0 仍继承 Key。 |
| US-02 AC2 BLOCKED/SKIPPED 不算 PASS | 已覆盖 | `scripts/certification/report-writer.js:70-105`; `scripts/certify-provider.js:176-184,716-734` | 聚合器会阻断门禁项非 PASS。 |
| US-02 AC3 capture-only 不得发布 | 已覆盖于逻辑，发布路径被 P0 阻断 | `scripts/certification/release-gate.js:82-111`; `test/certification.test.js:160-169` | 防假绿规则存在，但正式三平台汇总不可达。 |
| US-03 AC1 报告含代码上下文 | 已覆盖 | `scripts/certification/platform-context.js:51-81`; `scripts/certification/report-writer.js:190-227`; 现有报告 `report.json:1-75` | 报告能落 JSON/Markdown 并记录上下文。 |
| US-03 AC2 明细与结论一致 | 已覆盖 | `scripts/certification/report-writer.js:70-105`; `scripts/certify-provider.js:716-734` | P0 结果由 P0 明细重新聚合。 |
| US-03 AC3 无敏感泄露 | 未完整覆盖 | 见 P1-02 | 大文件与 Linux 临时日志长片段存在扫描盲区。 |
| US-04 AC1 三平台报告独立 | 部分覆盖 / 无法正式验收 | `scripts/certification/provider-profiles.js:101-134`; `scripts/certification/release-gate.js:125-160` | 能识别缺平台，但 P0-01/P0-02 使真实汇总不可用。 |
| US-04 AC2 Linux 必含 Hermes/systemd | 实现入口已覆盖，执行未证实 | `scripts/certification/linux-hermes-smoke.js:20-126`; `scripts/certify-provider.js:463-490` | 现有测试报告声明 TC-044 未执行：`自动化测试/V1.5.0/TEST_REPORT.md:8-9,45-49`。 |
| US-05 AC1 三平台全绿进入发布决策 | 未覆盖为可用流程 | 见 P0-01/P0-02 | gate 逻辑存在，但真实平台报告不能按当前实现完成通过。 |
| US-05 AC2 任一平台未测时阻断 | 已覆盖 | `scripts/certification/release-gate.js:136-160`; `test/certification.test.js:148-152` | 缺平台会标 `platform not executed`。 |

## 6. 测试用例覆盖归类

此表中的“代码覆盖”只表示找到实现/断言路径，不代表已取得 release-ready 的真实平台证据。

| 用例范围 | 分类 | 证据与审查判断 |
|---|---|---|
| TC-002~TC-005、TC-007~TC-009 | 已覆盖 | scripts/profile/缺 Key/状态聚合实现存在：`scripts/certify-provider.js:109-200,627-735`; `scripts/certification/report-writer.js:70-105`。 |
| TC-001 | 实现偏差 | 基线命令已实现，但违反无需 Key 的阶段边界，见 P1-01。 |
| TC-006、TC-055 | 实现偏差 | 上下文采集与 provenance 校验都有实现，但真实 Darwin 格式必失败，见 P0-01。 |
| TC-010~TC-014、TC-016~TC-023、TC-051~TC-052 | 代码覆盖；仅 Darwin 现有执行可见 | smoke/client 映射：`scripts/provider-smoke.js:62-157`; `scripts/certify-provider.js:264-297,344-384`; `scripts/client-e2e.js:515-679`。现有 dirty Darwin 报告列为 PASS：`reports/provider-certification/deepseek-darwin-2026-05-25T10-51-43-758Z/report.json:198-327,445-651`。Windows/Linux 执行无法证实。 |
| TC-015、TC-019 | 代码覆盖；仅 Darwin 现有执行可见 | 隔离 workspace 中随机化 package name 的工具读取证明：`scripts/client-e2e.js:393-399,515-526,600-625`; 现有报告 `report.json:286-327`（TC-015）及 `:309-327` 附近（TC-019）。 |
| TC-024~TC-031 | 已覆盖（capture） | capture sequence 与逐字段判断：`scripts/client-e2e.js:287-360`; `scripts/certify-provider.js:300-338`。 |
| TC-032~TC-036、TC-039~TC-043 | 已覆盖（artifact baseline） | 映射由测试输出命中决定：`scripts/certify-provider.js:340-383,433-445`; 对应原测试断言见 `test.js:556-883` 与 `test/hermes-target.test.js:144-243`。 |
| TC-037~TC-038 | 实现偏差 | 长任务、黑盒与静态校验路径存在，但运行合同不等于 PRD 冻结场景，见 P1-03。 |
| TC-044 | 代码覆盖；真实执行无法证实 | Linux 本机 runner 存在：`scripts/certification/linux-hermes-smoke.js:20-126`; 现有 TEST_REPORT 明示未执行：`自动化测试/V1.5.0/TEST_REPORT.md:8-9,45-49`。 |
| TC-045 | 代码覆盖；跨平台证据无法证实 | 用户配置 hash 前后比对：`scripts/client-e2e.js:49-78,835-897`; Darwin 现有报告含快照。 |
| TC-046 | 未完整覆盖 | 见 P1-02。 |
| TC-047~TC-050、TC-053~TC-054 | 代码覆盖；正式 gate 不可用 | 清理与反假绿/dirty/缺平台检查存在：`scripts/client-e2e.js:880-897`; `scripts/certification/release-gate.js:56-160`; `scripts/certify-provider.js:493-625`；受 P0-01/P0-02 阻断正式发布流程。 |
| TC-056 | 部分覆盖 / schema 偏差 | 黑盒与静态判断存在，字段合同偏差见 P2-01。 |

## 7. 发布门禁逐项判断

| PRD 发布门禁 | 状态 | 依据 |
|---|---|---|
| 所有 P0 用例 PASS | 无法证实 | 当前仅找到 dirty Darwin 报告；`自动化测试/V1.5.0/TEST_REPORT.md:45-53` 明示仍缺 clean Mac、Windows、Linux。 |
| DeepSeek true-key 在 Mac/Windows/Linux 各自真实环境通过 | 未覆盖证据 | Darwin 开发树报告存在且为 dirty：`reports/.../report.json:1-75`；Windows/Linux 报告未见，现有 TEST_REPORT 明示未执行。 |
| Claude Code/Codex 覆盖切换、thinking、命令、工具、短长任务 | 部分证实 | Darwin dirty 报告声称相关项 PASS；长任务合同与 PRD 不一致（P1-03），Windows/Linux 无证据。 |
| Linux systemd + Hermes 真实链路 | 未覆盖证据 | runner 已写；`TEST_REPORT.md:8-9,47-49` 明示 TC-044 尚未执行。 |
| 三平台正式报告 `isDirty=false` | 未覆盖证据 | 现有 Darwin 报告 `isDirty=true`：`reports/.../report.json:3-15`。 |
| 缺平台/capture-only/artifact-only/BLOCKED/SKIPPED 不发布 | 逻辑已覆盖，整体不可用 | 防假绿逻辑见 `release-gate.js:56-160`，但 P0-01/P0-02 阻断实际 gate。 |
| 完整矩阵、true-key、provenance、目标分支/commit 一致 | 实现偏差 | 矩阵/分支/commit 检查已写；provenance 与证据引用分别存在 P0-01/P0-02。 |

## 8. 已覆盖项

- 通用 `certify:provider` / `certify:release` / `smoke:provider` / `e2e:clients` / Linux Hermes 命令入口已经落在当前工作树：`package.json:8-15`。
- DeepSeek profile 已注册 56 个测试元数据、五阶段与三平台要求：`scripts/certification/provider-profiles.js:27-145`。
- `FAIL / BLOCKED / SKIPPED` 与零正向断言的聚合防假绿逻辑已实现：`scripts/certification/report-writer.js:70-105`。
- 真 Key smoke、Claude/Codex 客户端短任务/工具/命令 runner、capture 字段检查和长任务黑盒复测均存在实现入口：`scripts/provider-smoke.js:62-157`; `scripts/client-e2e.js:248-360,515-747,782-897`。
- Linux Hermes 本机临时 systemd/gateway 路径存在代码入口：`scripts/certification/linux-hermes-smoke.js:20-126`。

## 9. 未覆盖或不符合项

- 可通过的真实 Darwin provenance 门禁：未实现正确，见 P0-01。
- 可移交并在一处汇总的三平台证据验证：未实现正确，见 P0-02。
- 阶段 0 的无真 Key 执行隔离：未落实，见 P1-01。
- TC-046 对全部文本证据及 Linux gateway 临时日志长片段的完整扫描：未落实，见 P1-02。
- TC-037/TC-038 冻结的 3 至 20 轮及首轮 prompt 合同：实现不一致，见 P1-03。
- TC-056 的 `blackboxRetest.exitCode` 报告 schema：未按合同输出，见 P2-01。

## 10. 无法证实项

- 当前分支提交态是否含认证实现：现有 Darwin 报告记录 `commit="aad165c"` 且 `dirtyFiles` 包含 `?? scripts/`、`?? test/certification.test.js` 与测试产物目录：`reports/provider-certification/deepseek-darwin-2026-05-25T10-51-43-758Z/report.json:1-15`。本审查纳入的是当前工作树实现，不等同于可发布 commit。
- clean worktree 上的 Mac 完整认证：现有报告 `isDirty=true`，不可作为正式门禁证据：同报告 `:3-15,67-75`。
- Windows 真实平台完整认证：现有 `TEST_REPORT.md:47-49` 明示尚缺 Windows release-ready 报告。
- Linux 真实平台完整认证及 TC-044 Hermes smoke：现有 `TEST_REPORT.md:8-9,47-49` 明示尚未执行。
- 三平台正式 release gate PASS：由于缺平台证据且存在 P0 实现阻断，无法证实。

## 11. 审查建议排序

1. 先修正 P0-01 与 P0-02，否则任何新增平台实跑都不能形成可通过的正式发布门禁。
2. 收紧 TC-046 证据扫描闭环，并确保 Linux 临时 gateway 日志在删除前按同一长片段规则扫描并形成可审计证据。
3. 将长任务 runner 恢复为冻结的 prompt 与 `[3,20]` 合同，或先正式变更 PRD/测试用例后再采纳新标准。
4. 在 clean commit 上重新生成 Mac、Windows、Linux（含 Hermes TC-044）独立报告，再运行正式 release gate。
