# V0.5 Provider Gateway 测试报告

> 日期：2026-05-09  
> 分支：`codex/v0.5-provider-gateway`  
> 范围：智谱 BigModel 大陆版真实接口、Claude Code CLI、Codex CLI

## 1. 测试结论

智谱 BigModel 作为 v0.5 第二 provider 的基础接入已通过真实验证：

- 真实 Gateway smoke 通过。
- 真实 Claude Code CLI 文本闭环通过。
- 真实 Claude Code CLI 工具闭环通过。
- 真实 Codex CLI 单工具闭环通过。
- `glm-5.1` / `glm-5` / `glm-5-turbo` / `glm-4.7` 四个模型兼容矩阵通过。
- `glm-5.1` Codex 长链路项目闭环通过，最终 `ALL 7 TESTS PASS`。
- 本轮真实测试未写入用户真实 `~/.claude/settings.json` 或 `~/.codex/config.toml`；全部使用临时 gateway、临时 config dir、临时 `CODEX_HOME`。

## 2. 自动化回归

```text
npm test
```

结果：

```text
node test.js                       66 passed, 0 failed
node test/provider-runtime.test.js  3 passed, 0 failed
```

## 3. 真实 Provider Smoke

模型：`glm-5.1`  
Endpoint：`https://open.bigmodel.cn/api/paas/v4`

| 模式 | Anthropic Messages | Responses bridge | 结果 |
|------|--------------------|------------------|------|
| `thinking=enabled` | HTTP 2xx，body 非空 | completed，output_text 非空 | PASS |
| `thinking=disabled` | HTTP 2xx，body 非空 | completed，output_text 非空 | PASS |

## 4. 模型兼容矩阵

每个模型都跑三项：

- Direct gateway：Anthropic Messages + Responses bridge。
- Claude Code CLI：`claude --bare --print` 文本闭环。
- Codex CLI：`codex exec -c` 指向临时 gateway，实际调用 shell 读取 `package.json`。

| 模型 | Direct gateway | Claude Code CLI | Codex CLI tool | 结果 |
|------|----------------|-----------------|----------------|------|
| `glm-5.1` | PASS | PASS | PASS | PASS |
| `glm-5` | PASS | PASS | PASS | PASS |
| `glm-5-turbo` | PASS | PASS | PASS | PASS |
| `glm-4.7` | PASS | PASS | PASS | PASS |

## 5. Claude Code 工具闭环

模型：`glm-5.1`

真实命令形态：

```text
claude --bare --print --model glm-5.1 --dangerously-skip-permissions
```

验证内容：

- Claude Code 通过本地 gateway 走智谱 Anthropic 兼容端点。
- Claude Code 实际调用 Bash 工具读取 `package.json`。
- 最终输出包含包名 `deepseek-claude-setup`。

结果：

```text
CLAUDE_TOOL_PASS
```

## 6. Codex 长链路项目闭环

模型：`glm-5.1`

Prompt：

```text
写一个 Node.js HTTP 文件管理服务，只使用 Node 内置模块。
1. 创建 server.js，支持 GET /、GET /files、GET /files/:name、POST /files/:name、DELETE /files/:name。
2. 文件存到 ./data。
3. 创建 test.sh，用 curl 跑 7 个断言，最后输出 ALL 7 TESTS PASS。
4. 实际运行 bash test.sh，修到测试通过。
```

结果：

```text
ALL 7 TESTS PASS
CODEX_LONG_PASS server=true test=true
```

代理日志摘要：

| 时间段 | 结果 |
|--------|------|
| 16:15–16:19 | 连续 `RESPONSES_DONE`，无本次长链路 `RESPONSES_FAILED` |

说明：

- 过程中 Codex 先写出 `server.js` 与 `test.sh`。
- 首次 `test.sh` 因 bash `set -e` + `((PASS++))` 退出码陷阱失败。
- Codex 自行定位并修复为 `PASS=$((PASS + 1))`。
- 复跑 `bash test.sh` 后 7 个 curl 断言全部通过。

## 7. 剩余门槛

- DeepSeek provider 的 0 回归长链路仍需在最终发版前再跑一次，确认 v0.5 抽象没有破坏既有生产路径。
- 智谱 Coding Plan endpoint 未测；本轮按用户要求只测普通 BigModel endpoint。
