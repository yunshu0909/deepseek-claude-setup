# Client E2E Switching Matrix Report (PRD-007)

> ⚠️ **capture 模式产物，非真实 API**：本矩阵 gateway 上游被覆写为本机
> capture-server（假上游），**0 字节真实 DeepSeek/智谱 流量、token 全 0、
> DS 用 dummy key**。仅证明字段注入/路由/切换/state-leak 在字段路由层不回归，
> **不证明 provider 真实可用**。真实 API 可用性见
> `../V0.5/CLIENT_E2E_{DEEPSEEK,ZAI}_DEFAULT_REPORT.md`（EVD-2 真 happy-path）。
> 另：zai 行的正向断言（clear_thinking/tool_stream）因 runConfig 写死未触发，
> zai 行 ≈ 仅 mustNotHave，勿当"zai 真断言通过"（PRD-007 遗留，v0.7 修）。

- Status: PASS
- Run ID: 1778918253987-51341
- Started: 2026-05-16T07:57:33.988Z
- Mode: matrix=switch
- Provider: zai
- Models: glm-5.1
- Targets: claude-text, claude-tool, codex-tool
- Claude Code: 2.1.143 (Claude Code)
- Codex CLI: codex-cli 0.131.0-alpha.9
- Temp root: (removed)

| Case | Desc | Steps | PASS / FAIL | Violations |
|------|------|-------|-------------|------------|
| DS-M1 | model v4-pro → v4-flash | 2 | 2 / 0 | 0 |
| DS-M2 | model v4-flash → v4-pro | 2 | 2 / 0 | 0 |
| DS-T1 | thinking on → off | 2 | 2 / 0 | 0 |
| DS-T2 | thinking off → on | 2 | 2 / 0 | 0 |
| DS-E1 | effort high → max | 2 | 2 / 0 | 0 |
| DS-E2 | effort max → high | 2 | 2 / 0 | 0 |
| ZAI-M1 | model glm-5.1 → glm-5 | 2 | 2 / 0 | 0 |
| ZAI-M2 | model glm-5 → glm-5-turbo | 2 | 2 / 0 | 0 |
| ZAI-M3 | model glm-5-turbo → glm-4.7 | 2 | 2 / 0 | 0 |
| ZAI-M4 | model glm-4.7 → glm-5.1 | 2 | 2 / 0 | 0 |
| ZAI-T1 | thinking on → off | 2 | 2 / 0 | 0 |
| ZAI-T2 | thinking off → on | 2 | 2 / 0 | 0 |
| ZAI-E1 | effort 切换应被忽略 | 2 | 2 / 0 | 0 |
| X-1 | cross DS → zai | 2 | 2 / 0 | 0 |
| X-2 | cross zai → DS | 2 | 2 / 0 | 0 |
| X-3 | DS→zai→DS 配置保留 | 3 | 3 / 0 | 0 |
| X-4 🛰️ | state leak zai → DS | 2 | 2 / 0 | 0 |
| X-5 🛰️ | state leak DS → zai | 2 | 2 / 0 | 0 |
| X-6 | zai→DS→zai 配置保留 | 3 | 3 / 0 | 0 |
| X-7 | 跨切同时改 thinking | 2 | 2 / 0 | 0 |
| X-8 | 5 步循环切换 | 5 | 5 / 0 | 0 |
| X-9 | 跨切 + 工具调用 | 2 | 2 / 0 | 0 |

## Step Detail（每步独立 capture 断言）

| Case | Step | Provider:Model:Thinking:Effort | Probe | Status | Captures | Violations |
|------|------|---------------------------------|-------|--------|----------|------------|
| DS-M1 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-M1 | step-2-ds_flash_on_max | deepseek:deepseek-v4-flash: | claude+codex | PASS | 2 | - |
| DS-M2 | step-1-ds_flash_on_max | deepseek:deepseek-v4-flash: | claude+codex | PASS | 2 | - |
| DS-M2 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-T1 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-T1 | step-2-ds_pro_off_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-T2 | step-1-ds_pro_off_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-T2 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-E1 | step-1-ds_pro_on_high | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-E1 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-E2 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| DS-E2 | step-2-ds_pro_on_high | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| ZAI-M1 | step-1-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-M1 | step-2-zai_5_on_- | zai:glm-5: | claude+codex | PASS | 2 | - |
| ZAI-M2 | step-1-zai_5_on_- | zai:glm-5: | claude+codex | PASS | 2 | - |
| ZAI-M2 | step-2-zai_5-turbo_on_- | zai:glm-5-turbo: | claude+codex | PASS | 2 | - |
| ZAI-M3 | step-1-zai_5-turbo_on_- | zai:glm-5-turbo: | claude+codex | PASS | 2 | - |
| ZAI-M3 | step-2-zai_4.7_on_- | zai:glm-4.7: | claude+codex | PASS | 2 | - |
| ZAI-M4 | step-1-zai_4.7_on_- | zai:glm-4.7: | claude+codex | PASS | 2 | - |
| ZAI-M4 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-T1 | step-1-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-T1 | step-2-zai_5.1_off_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-T2 | step-1-zai_5.1_off_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-T2 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-E1 | step-1-zai_5.1_on_high | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| ZAI-E1 | step-2-zai_5.1_on_max | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-1 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-1 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-2 | step-1-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-2 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-3 | step-1-ds_flash_on_high | deepseek:deepseek-v4-flash: | claude+codex | PASS | 2 | - |
| X-3 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-3 | step-3-ds_flash_on_high | deepseek:deepseek-v4-flash: | claude+codex | PASS | 2 | - |
| X-4 | step-1-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-4 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-5 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-5 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-6 | step-1-zai_5.1_off_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-6 | step-2-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-6 | step-3-zai_5.1_off_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-7 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude+codex | PASS | 2 | - |
| X-7 | step-2-zai_5.1_off_- | zai:glm-5.1: | claude+codex | PASS | 2 | - |
| X-8 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude | PASS | 1 | - |
| X-8 | step-2-zai_5.1_on_- | zai:glm-5.1: | claude | PASS | 1 | - |
| X-8 | step-3-ds_flash_on_high | deepseek:deepseek-v4-flash: | claude | PASS | 1 | - |
| X-8 | step-4-zai_5-turbo_off_- | zai:glm-5-turbo: | claude | PASS | 1 | - |
| X-8 | step-5-ds_pro_on_max | deepseek:deepseek-v4-pro: | claude | PASS | 1 | - |
| X-9 | step-1-ds_pro_on_max | deepseek:deepseek-v4-pro: | codex | PASS | 1 | - |
| X-9 | step-2-zai_5.1_on_- | zai:glm-5.1: | codex | PASS | 1 | - |

## Safety Checks

- User config changes: none
- Blocking config changes: none
- Secret scan hits: none
- Cleanup: ok
