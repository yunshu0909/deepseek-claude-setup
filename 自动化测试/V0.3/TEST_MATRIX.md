# 深度测试矩阵 (V0.3 / Windows 适配 + 全场景回归)

> 本文档是 deepseek-claude-setup v1.4.0 release 验收的完整 checklist，同时作为
> 未来所有版本的回归基准。覆盖 Codex / Claude Code 两条路径、跨平台、升级降级、
> 异常恢复全场景。每个测试用例可独立执行，给出明确的验证命令。

最后更新：2026-05-05  
适用版本：v1.4.0-rc 起  
依赖：`自动化测试/codex实际测试/REPORT.md` (codex 闭环测试协议)

---

## 文档使用方式

- **新版本发布前**：跑完所有 P0 用例 + 至少 70% P1 用例
- **bug 修复后**：跑相关章节的 P0 用例确认无回归
- **跨平台合并前**：§3 跨平台所有 P0 必跑，两端各跑一次
- 每条用例失败 → 按"失败兜底"诊断步骤排查

每个用例格式：
```
### TC-XXX-NNN: 名称
- 优先级 / 平台 / 前置 / 步骤 / 期望 / 验证命令 / 失败兜底
```

---

## 通用前置条件

### 隔离测试代理（不影响生产 17861）

```bash
# Mac
TMPDIR_TEST=$(mktemp -d)
APIKEY=$(python3 -c "import json; print(json.load(open('$HOME/.deepseek-claude/config.json'))['apiKey'])")
cp <repo>/proxy/proxy.js $TMPDIR_TEST/proxy.js
cat > $TMPDIR_TEST/config.json <<EOF
{"apiKey":"$APIKEY","model":"deepseek-v4-flash","thinking":"enabled","effort":"high"}
EOF
DEEPSEEK_CLAUDE_CONFIG_DIR=$TMPDIR_TEST DEEPSEEK_CLAUDE_PROXY_PORT=17862 \
  nohup node $TMPDIR_TEST/proxy.js > $TMPDIR_TEST/proxy.out 2>&1 &
sleep 2 && curl -s http://127.0.0.1:17862/__health
```

```powershell
# Windows
$TMPDIR_TEST = New-Item -ItemType Directory -Path "$env:TEMP\dsctest_$(Get-Random)"
$APIKEY = (Get-Content "$HOME\.deepseek-claude\config.json" | ConvertFrom-Json).apiKey
Copy-Item <repo>\proxy\proxy.js "$TMPDIR_TEST\proxy.js"
@"
{"apiKey":"$APIKEY","model":"deepseek-v4-flash","thinking":"enabled","effort":"high"}
"@ | Out-File "$TMPDIR_TEST\config.json" -Encoding utf8
$env:DEEPSEEK_CLAUDE_CONFIG_DIR = $TMPDIR_TEST.FullName
$env:DEEPSEEK_CLAUDE_PROXY_PORT = "17862"
Start-Process node -ArgumentList "$($TMPDIR_TEST.FullName)\proxy.js" -RedirectStandardOutput "$($TMPDIR_TEST.FullName)\proxy.out" -WindowStyle Hidden
Start-Sleep 2; Invoke-RestMethod http://127.0.0.1:17862/__health
```

### codex exec 模板（指向隔离代理）

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -c 'model_provider="ds_test"' -c 'model_providers.ds_test.name="DS"' \
  -c 'model_providers.ds_test.base_url="http://127.0.0.1:17862/v1"' \
  -c 'model_providers.ds_test.wire_api="responses"' \
  -c "model_providers.ds_test.experimental_bearer_token=\"$APIKEY\"" \
  -c 'model="deepseek-v4-flash"' -c 'model_reasoning_effort="high"' \
  -C $WORKDIR "<prompt>"
```

### 看代理日志

```bash
# Mac
LOG=$(node -e "console.log(require('os').tmpdir())")/deepseek-claude-proxy.log
tail -f $LOG | grep -E "RESPONSES_DONE|MSG_DONE|FAILED"
```
```powershell
# Windows
Get-Content -Tail 0 -Wait -Encoding UTF8 "$env:TEMP\deepseek-claude-proxy.log" | Select-String "RESPONSES_DONE|MSG_DONE|FAILED"
```

---

## §1 Codex 路径深度测试

### TC-CDX-101: thinking=enabled + effort=max 真实生效
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 隔离代理 thinking=enabled effort=max
- **步骤**: codex exec "为什么时间膨胀效应在高速运动下变得显著？用 100 字解释。"
- **期望**: 代理日志 `RESPONSES_DONE thinking=Y(N chars)`，N ≥ 100；effort=max 字段在请求体
- **验证**: `grep "RESPONSES_DONE" $LOG | tail -1`
- **失败兜底**: thinking=N → DeepSeek 没返回 reasoning，检查 proxy.js 是否发了 `reasoning_effort=max` 字段

### TC-CDX-102: thinking=enabled + effort=high
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 同上但 effort=high
- **步骤**: 同 TC-CDX-101 同 prompt
- **期望**: thinking=Y(N chars)，N>0；与 max 对比应该相近或略短
- **失败兜底**: 同上

### TC-CDX-103: thinking=disabled
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: thinking=disabled effort=任意
- **步骤**: 同 prompt
- **期望**: `thinking=N` 或 `thinking=Y(0chars)`；text 仍正常返回
- **失败兜底**: thinking=Y(N>0) → DeepSeek 仍在思考，检查 proxy.js 是否发了 `thinking={type:disabled}`

### TC-CDX-104: max vs high vs disabled 三组对比
- **优先级**: P0
- **平台**: Mac
- **前置**: 同一 prompt 跑 3 种配置
- **期望**: thinking_chars(max) ≈ thinking_chars(high) >> thinking_chars(disabled)=0
- **失败兜底**: 若 max 显著小于 high → effort 字段没生效，检查代理实际请求体

### TC-CDX-105: 单工具调用（基础）
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 隔离代理
- **步骤**: codex exec "用 echo 命令打印 hello"
- **期望**: 日志含 `tools=1`；exec_command 调用成功；2 轮内完成（call → 结果总结）
- **验证**: `grep "tools=" $LOG | tail -2`

### TC-CDX-106: 并行工具调用合并
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 隔离代理
- **步骤**: codex exec "同时 ls 两个目录 /tmp 和 /var，分别报告内容"
- **期望**: 日志含 `tools=2`；不报 `insufficient tool messages`；两个 tool_call 合并到一条 assistant 消息
- **失败兜底**: 报 `insufficient tool messages` → responsesInputToMessages 没合并并行 fc，检查 v1.3.2 修复是否还在

### TC-CDX-107: 多轮工具调用 + reasoning_content 回传
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 隔离代理
- **步骤**: codex exec "创建 hello.txt 写入 'test' 然后读回验证"（≥3 轮工具调用 + 文本回复）
- **期望**: 全程 0 RESPONSES_FAILED；最终输出含 'test'
- **失败兜底**: 报 `reasoning_content must be passed back` → 检查 ui.js syncCodexPatchOnStartup 是否触发，patcher 写顶层 model_provider

### TC-CDX-108: 长会话 21 轮压测
- **优先级**: P0
- **平台**: Mac
- **前置**: 隔离代理
- **步骤**: 跑 `自动化测试/codex实际测试/REPORT.md` §2.5 用例 5（HTTP 服务 + 7 测试断言）
- **期望**: 21+ 轮全过 0 失败，最终输出 `ALL 7 TESTS PASS`
- **失败兜底**: 任意失败贴日志，参考 codex 实测报告 §3 修复痕迹

### TC-CDX-109: TLS 抖动透明 retry
- **优先级**: P1
- **平台**: Mac, Win
- **前置**: 隔离代理
- **步骤**: 跑测试用 `npm test` 中 `transient connection error transparent retry` 用例
- **期望**: 模拟第一次连接被 destroy，第二次成功；客户端不感知错误
- **验证**: `npm test | grep "transient connection error"` 应 OK

### TC-CDX-110: ChatGPT 账号登录态接入
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: codex 已 `codex login` 登录 ChatGPT Plus 账号
- **步骤**: 主面板「开启 Codex 接入」→ 退出 → `codex` → 输入 prompt
- **期望**: codex 实际请求走 localhost:17861（代理日志有 RESPONSES_DONE），不走 chatgpt.com
- **失败兜底**: codex 走 chatgpt.com → 检查顶层是否有 `model_provider = "deepseek_local"`（v1.4.0+ 必须）

### TC-CDX-111: 双 section 自动修复
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 手工编辑 ~/.codex/config.toml 复制一份 `[model_providers.deepseek_local]` section 到 managed block 之外
- **步骤**: 跑 `npx -y github:.../#main` 进主面板
- **期望**: 自动触发 `⏳ 检测到 Codex 配置需要升级` 提示；`grep -c '\[model_providers.deepseek_local\]' ~/.codex/config.toml` 应为 1
- **失败兜底**: 检查 syncCodexPatchOnStartup 的 hasDuplicate 检测

### TC-CDX-112: restore 不写回污染
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: codex 接入开着；`.deepseek-backup` 文件里的 topLevel 含 `model_provider="deepseek_local"`（v0.2 残留）
- **步骤**: 主面板「关闭 Codex 接入」→ 退出 → `codex`
- **期望**: codex 启动**不报** `Model provider 'deepseek_local' not found`
- **失败兜底**: 检查 sanitizeOriginalTopLevel 是否过滤 deepseek_local

### TC-CDX-113: function_call_output input 翻译
- **优先级**: P1
- **平台**: Mac
- **前置**: 跑 npm test
- **步骤**: 跑 `npm test`，看相关用例
- **期望**: 测试 `function_call_output translated to role=tool with tool_call_id` 通过
- **覆盖**: 多轮工具调用上下文不丢

### TC-CDX-114: 思考关闭实测验证
- **优先级**: P1
- **平台**: Mac
- **前置**: 隔离代理 thinking=disabled
- **步骤**: codex exec "解释相对论" → 计时 + 看 reasoning_chars
- **期望**: 响应时间显著缩短（无思考过程）；reasoning_chars 接近 0
- **失败兜底**: thinking_chars 仍很大 → 检查代理 handleResponses 的 thinking 字段

### TC-CDX-115: 配置切换后代理重启
- **优先级**: P1
- **平台**: Mac
- **前置**: 主面板代理已开启
- **步骤**: 主面板「关闭思考模式」或「修改配置」选不同 effort
- **期望**: 显示 spinner「自动重启代理使新配置生效」；`/__health` 返回新 effort
- **失败兜底**: 配置改了但代理仍用旧值 → 检查 ui.js restartProxy 调用

---

## §2 Claude Code 路径深度测试

### TC-CC-201: settings.json patch 完整性
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 主面板「开启 Claude Code 接入」
- **步骤**: 检查 `~/.claude/settings.json`
- **期望**: env 含 ANTHROPIC_BASE_URL=http://127.0.0.1:17861, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, CLAUDE_CODE_EFFORT_LEVEL；顶层 model + alwaysThinkingEnabled
- **验证**: `cat ~/.claude/settings.json | python3 -m json.tool`

### TC-CC-202: thinking 真实启用
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 接入开启，thinking=enabled
- **步骤**: 跑 Claude Code，问个复杂问题（"用一段话证明勾股定理"）
- **期望**: 代理日志 `MSG_DONE thinking=Y(N chars)`, N>0
- **失败兜底**: thinking=N → 检查 proxy 在 Anthropic 透传时是否注入 output_config.effort

### TC-CC-203: thinking 关闭
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 接入开启，thinking=disabled
- **步骤**: 同上 prompt
- **期望**: `thinking=N`；响应时间显著缩短
- **失败兜底**: 同上

### TC-CC-204: 工具调用透传
- **优先级**: P1
- **平台**: Mac
- **前置**: Claude Code 真实使用
- **步骤**: 让 Claude Code 调用 Read / Write / Bash 工具（自动）
- **期望**: 工具调用正常完成；代理日志看到对应请求 + 响应；不报错
- **覆盖**: Anthropic native tool_use 透传链路

### TC-CC-205: 长会话上下文累积
- **优先级**: P1
- **平台**: Mac
- **步骤**: Claude Code 一次会话内连续提问 10+ 个相关问题
- **期望**: 全程稳定；代理日志 usage 显示 input_tokens 单调累积
- **失败兜底**: 中途 502/504 → 检查 upstream timeout 设置

### TC-CC-206: settings restore
- **优先级**: P0
- **平台**: Mac, Win
- **前置**: 接入已开启
- **步骤**: 主面板「关闭 Claude Code 接入」→ 检查 settings.json
- **期望**: settings.json 还原到 backup 状态；env.ANTHROPIC_BASE_URL 不再是 localhost；备份文件被删
- **验证**: `cat ~/.claude/settings.json | grep ANTHROPIC_BASE_URL`

### TC-CC-207: backup 缺失 fallback
- **优先级**: P1
- **平台**: Mac
- **前置**: 接入开启后手动删 `~/.claude/settings.json.deepseek-backup`
- **步骤**: 主面板「关闭 Claude Code 接入」
- **期望**: settings.json env.ANTHROPIC_BASE_URL 改回 https://api.deepseek.com/anthropic（不留 localhost 死引用）
- **失败兜底**: 仍指向 localhost → 检查 settings-patcher fallback restore 逻辑

### TC-CC-208: subagent model 配置
- **优先级**: P2
- **平台**: Mac
- **前置**: 接入开启
- **步骤**: 检查 settings.json 的 CLAUDE_CODE_SUBAGENT_MODEL
- **期望**: 始终是 deepseek-v4-flash（不随主模型变）

---

## §3 跨平台适配测试

### TC-PLT-301: macOS LaunchAgent 注册
- **优先级**: P0
- **平台**: Mac
- **前置**: 任一接入开启
- **步骤**: 检查 `~/Library/LaunchAgents/com.deepseek.claude-proxy.plist` + `launchctl list | grep deepseek`
- **期望**: plist 存在；launchctl 列出该 service
- **验证**: `ls -la ~/Library/LaunchAgents/com.deepseek.claude-proxy.plist`

### TC-PLT-302: macOS 重启自启
- **优先级**: P1
- **平台**: Mac
- **前置**: 接入开启 + LaunchAgent 注册
- **步骤**: 重启 Mac → 重新登录 → `curl http://127.0.0.1:17861/__health`
- **期望**: 不需手动操作，`/__health` 返回 200
- **失败兜底**: 看 `/tmp/deepseek-claude-proxy.err` 或 LaunchAgent 启动日志

### TC-PLT-303: Windows schtasks 注册
- **优先级**: P0
- **平台**: Win
- **前置**: 任一接入开启
- **步骤**: `schtasks /Query /TN DeepSeekClaudeProxy /V /FO LIST`
- **期望**: 任务存在，TaskRun 含 node.exe + proxy.js 路径，TaskState=Ready
- **失败兜底**: 检查 launch agent 是否降级到 Startup .vbs（看 `$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\deepseek-claude-proxy.vbs`）

### TC-PLT-304: Windows 重启自启
- **优先级**: P1
- **平台**: Win
- **前置**: 接入开启
- **步骤**: 重启 Win → 重新登录 → `Invoke-RestMethod http://127.0.0.1:17861/__health`
- **期望**: 不需手动操作，返回 200

### TC-PLT-305: Windows schtasks 失败 → Startup .vbs 降级
- **优先级**: P1
- **平台**: Win
- **前置**: 模拟 schtasks 失败（如 GPO 限制）—— 难以模拟，可手工临时改 win32.js 让 schtasks 抛错
- **期望**: install 不抛错；`$env:APPDATA\...\Startup\deepseek-claude-proxy.vbs` 出现

### TC-PLT-306: 终端 emoji 渲染（Windows Terminal / VSCode / Git Bash）
- **优先级**: P1
- **平台**: Win
- **步骤**: 分别在 Windows Terminal / VSCode terminal / Git Bash 跑 `npx ...`
- **期望**: 主面板 emoji（🤖 ⌘ 🧠 🟢）正常显示

### TC-PLT-307: 终端 ASCII 降级（cmd / PowerShell 5.1 默认 console）
- **优先级**: P1
- **平台**: Win
- **步骤**: 在 conhost 默认的 cmd.exe 或 PowerShell 5.1 跑
- **期望**: 自动降级 emoji 为 ASCII（`[C]` `[X]` `[T]` `*`），主面板交互正常
- **覆盖**: supportsEmoji() 检测函数

### TC-PLT-308: 路径跨平台（os.homedir + path.join）
- **优先级**: P0
- **平台**: 两端
- **步骤**: 看 ~/.deepseek-claude/config.json 实际位置
- **期望**: Mac=/Users/xxx/.deepseek-claude/config.json；Win=C:\Users\xxx\.deepseek-claude\config.json

### TC-PLT-309: 日志路径跨平台
- **优先级**: P1
- **平台**: 两端
- **步骤**: `node -e "console.log(require('os').tmpdir())"` 看输出
- **期望**: Mac=/var/folders/.../T 或 /tmp（取决于 TMPDIR）；Win=C:\Users\xxx\AppData\Local\Temp\
- **覆盖**: proxy.js 日志写在 os.tmpdir()/deepseek-claude-proxy.log

### TC-PLT-310: PowerShell 执行策略容错
- **优先级**: P2
- **平台**: Win
- **步骤**: PowerShell 默认 Restricted 下跑 `npx ...`
- **期望**: 若被 npx.ps1 拦，README troubleshooting 给的 npx.cmd 替代命令应当 work

---

## §4 升级 / 降级测试

### TC-UPG-401: 自动升级触发
- **优先级**: P0
- **平台**: 两端
- **前置**: cli.js 已运行过一次（cache_sha 已写入）
- **步骤**: 远程推一个新 commit；本地再跑 `npx -y github:.../#main`
- **期望**: 启动时 1.5s 内显示 `⏳ 检测到新版 abc1234... 正在自动升级...`；自动清缓存 + 重 npx + 重启进程
- **失败兜底**: cache_sha 未更新 → 检查 cli.js checkForUpdate 死锁防护逻辑

### TC-UPG-402: 升级时无网络
- **优先级**: P1
- **平台**: 两端
- **前置**: 离线 / GitHub API 不可达
- **步骤**: 跑 npx
- **期望**: 1.5s 超时后静默走原版本，主面板正常显示

### TC-UPG-403: proxy.js 自动热升级（cli.js 不变 only proxy.js 变）
- **优先级**: P0
- **平台**: 两端
- **前置**: 接入已开启，代理在跑
- **步骤**: 改 ~/.deepseek-claude/proxy.js 内容（模拟升级）→ 进主面板
- **期望**: spinner 显示 `⏳ 检测到 proxy 已升级...`，自动 stop+start

### TC-UPG-404: 从 v1.3.x 升级到 v1.4.0
- **优先级**: P0
- **平台**: 两端
- **前置**: 已装 v1.3.x，codex 接入开着
- **步骤**: 升级到 v1.4.0
- **期望**: syncCodexPatchOnStartup 自动触发；config.toml 更新到新格式（顶层 model_provider="deepseek_local" + 单一 managed block）；codex 启动正常

### TC-UPG-405: 干净安装 v1.4.0
- **优先级**: P0
- **平台**: 两端
- **前置**: 全新机器（`rm -rf ~/.deepseek-claude ~/.codex/config.toml.deepseek-backup ~/.claude/settings.json.deepseek-backup` + 删除自启项）
- **步骤**: `npx -y github:.../v1.4.0` 走完整向导
- **期望**: 配置向导→主面板→开启接入→codex/claude 真实可用

### TC-UPG-406: 完全卸载（暂未实现）
- **优先级**: P1
- **平台**: 两端
- **前置**: 接入已开启
- **步骤**: 主面板「🗑 完全卸载」按钮（PRD-003 §3.3 计划）
- **期望**: 所有自启项 / 代理进程 / 配置 / 日志全部清干净
- **状态**: 未实现，跳过（v1.4.0 不阻塞）

---

## §5 异常状态恢复

### TC-ERR-501: 代理 crash 自动恢复
- **优先级**: P0
- **平台**: 两端
- **前置**: 接入开启，代理在跑
- **步骤**: 手动 kill node 代理进程 → 进主面板
- **期望**: spinner 显示 `⏳ 检测到代理崩溃...`，自动 start
- **覆盖**: ui.js syncProxyOnStartup 崩溃自愈

### TC-ERR-502: 端口 17861 被占
- **优先级**: P1
- **平台**: 两端
- **前置**: 启动一个占用 17861 的服务
- **步骤**: 主面板「开启接入」
- **期望**: 报错"端口 17861 被其他服务占用"；不污染 settings.json / config.toml
- **失败兜底**: 看 doStart 的回滚逻辑

### TC-ERR-503: DeepSeek 上游 4xx
- **优先级**: P1
- **平台**: 两端
- **前置**: 隔离代理 + 故意填错 apiKey
- **步骤**: codex exec "test"
- **期望**: 代理日志 `RESPONSES_FAILED upstream_error` 含 DeepSeek 原始错误信息

### TC-ERR-504: TLS bad record mac（公网抖动）
- **优先级**: P1
- **平台**: 两端
- **步骤**: 真实使用中偶发触发
- **期望**: 代理自动 retry 1 次（v1.3.5 引入）；2 次都失败才报错
- **覆盖**: proxy.js attemptRequest 透明 retry

### TC-ERR-505: 手工编辑 config.toml 后异常状态
- **优先级**: P1
- **平台**: 两端
- **前置**: 用户手工往 ~/.codex/config.toml 加重复 section / 删 managed block 部分内容
- **步骤**: 进主面板
- **期望**: syncCodexPatchOnStartup 自动检测到异常 → 自动重 patch → 修复

---

## §6 长会话压测（主线性能 + 稳定性）

### TC-LONG-601: Codex 21 轮 HTTP 文件服务（用例 5）
- **优先级**: P0
- **平台**: Mac
- **前置**: 隔离代理
- **步骤**: 跑 `自动化测试/codex实际测试/REPORT.md` §2.5 用例 5
- **期望**: 21 轮全过 0 失败；最终输出 `ALL 7 TESTS PASS`；input_tokens 从 ~16k 增长到 ~21k

### TC-LONG-602: Codex todo CLI 项目（7 轮）
- **优先级**: P0
- **平台**: Mac
- **前置**: 隔离代理
- **步骤**: 跑 §2.4 用例 4
- **期望**: 7 轮全过；产物 todo.js + .todos.json 验证通过

### TC-LONG-603: Claude Code 长会话冒烟
- **优先级**: P1
- **平台**: Mac
- **前置**: 接入开启
- **步骤**: Claude Code 一次会话内做完整 PRD 设计任务（10+ 个 prompt）
- **期望**: 全程无中断；代理日志 0 ERROR / FAILED

---

## §7 性能基准

### TC-PERF-701: cli.js 启动延迟
- **优先级**: P2
- **平台**: 两端
- **测量**: `time node cli.js --version`
- **基准**: < 200ms（不触发 checkForUpdate 的快路径）；< 2s（触发 update check）

### TC-PERF-702: 代理首字延迟
- **优先级**: P2
- **平台**: Mac
- **测量**: codex exec 跑简单 prompt 看代理日志 `RESPONSES_DONE ... Nms`
- **基准**: 思考关闭 < 1500ms；思考开启 < 3000ms（DeepSeek 端决定）

### TC-PERF-703: 代理内存占用
- **优先级**: P2
- **平台**: 两端
- **测量**: 24h 持续运行后 `ps aux | grep proxy.js`
- **基准**: RSS < 100MB（健康；持续增长说明泄漏）

---

## §8 Codex 环境兼容性矩阵

| codex 版本 | ChatGPT 登录 | Mac | Win | 备注 |
|---|---|---|---|---|
| 0.128.0-alpha.1 | 未登录 | ✅ 验证 | - | v1.3.x 时代基线 |
| 0.128.0-alpha.1 | 已登录 | ✅ 验证 | - | Mac 因 v0.2 残留 work（不可靠） |
| 0.128.0 stable | 未登录 | 🟡 待测 | 🟡 待测 | 应该 work（profile 生效） |
| 0.128.0 stable | 已登录 | ✅ 验证 (TC-CDX-110) | ✅ 验证 (TC-CDX-110) | v1.4.0 必须支持，靠顶层 model_provider |
| 未来 0.129+ | - | 🔴 跟进 | 🔴 跟进 | 任何升级都要重跑 §1 P0 |

---

## §9 矩阵汇总

| 章节 | 用例数 | P0 | P1 | P2 |
|---|---|---|---|---|
| §1 Codex 路径 | 15 | 9 | 5 | 1 |
| §2 Claude Code | 8 | 4 | 3 | 1 |
| §3 跨平台 | 10 | 4 | 5 | 1 |
| §4 升级降级 | 6 | 4 | 1 | 1 |
| §5 异常恢复 | 5 | 1 | 4 | 0 |
| §6 长会话压测 | 3 | 2 | 1 | 0 |
| §7 性能 | 3 | 0 | 0 | 3 |
| **合计** | **50** | **24** | **19** | **7** |

## §10 v1.4.0 release 验收门槛

发布前必须达到：
- ✅ 24 个 P0 用例全过（Mac + Win 各跑一次）
- ✅ §6 长会话压测两个用例全过（Mac）
- ✅ §3 跨平台 P0 在 Win 真机跑过
- ✅ §1 TC-CDX-110 (登录态接入) 在 Win 真机验证
- 🟡 P1 用例至少 70% 过
- 🟢 P2 视需求选

任意 P0 失败 → 不能发布。

---

## §11 已知豁免（Known Skips）

- `TC-UPG-406 完全卸载按钮`: PRD-003 Phase 3 计划，v1.4.0 不阻塞，留 v1.4.1
- `TC-PLT-302 / TC-PLT-304 重启自启`: 需要真重启电脑，部分场景跳过
- `TC-LONG-603 Claude Code 长会话`: 与 Claude Code 真实使用强耦合，无法自动化
- `TC-ERR-504 TLS 抖动`: 公网偶发，无法稳定模拟，靠日志监控统计
