# Codex 实际测试报告

> 用真实 codex CLI 跑长会话压力测试，验证多轮工具调用 + reasoning_content 上下文累积无回归。
> 自动化测试（`npm test`）的假上游不会触发 DeepSeek 端 schema 校验，**这份报告才是 Codex 路径真正的可用性凭据**。

最后更新：2026-05-05  
工具版本：v1.3.4  
DeepSeek 模型：deepseek-v4-flash（reasoning_effort=high）

---

## 1. 测试方法

### 隔离环境
- 临时端口 17862（与生产 17861 隔离，不影响用户运行中的代理）
- 临时配置目录 `mktemp -d` + 临时工作区
- 通过 `codex exec -c` 覆盖配置直接指向测试代理

### 启动模板
```bash
TMPDIR=$(mktemp -d)
APIKEY=$(python3 -c "import json; print(json.load(open('/Users/yunshu/.deepseek-claude/config.json'))['apiKey'])")
cp <repo>/proxy/proxy.js $TMPDIR/proxy.js
cat > $TMPDIR/config.json <<EOF
{"apiKey":"$APIKEY","model":"deepseek-v4-flash","thinking":"enabled","effort":"high"}
EOF
DEEPSEEK_CLAUDE_CONFIG_DIR=$TMPDIR DEEPSEEK_CLAUDE_PROXY_PORT=17862 \
  nohup node $TMPDIR/proxy.js > $TMPDIR/out 2>&1 &

WORKDIR=$(mktemp -d)
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -c 'model_provider="ds_test"' \
  -c 'model_providers.ds_test.name="DS Test"' \
  -c 'model_providers.ds_test.base_url="http://127.0.0.1:17862/v1"' \
  -c 'model_providers.ds_test.wire_api="responses"' \
  -c "model_providers.ds_test.experimental_bearer_token=\"$APIKEY\"" \
  -c 'model="deepseek-v4-flash"' \
  -c 'model_reasoning_effort="high"' \
  -C $WORKDIR \
  "<prompt>"
```

### 判定标准
- 看 `/tmp/deepseek-claude-proxy.log` 的 `RESPONSES_DONE` / `RESPONSES_FAILED` 行
- `RESPONSES_FAILED` 为 0 才算通过
- `thinking=Y(N chars)` 显示 DeepSeek 真返回了思考内容（不只是请求里发了 `reasoning_effort`）

---

## 2. 测试用例与结果

### 用例 1：多轮工具调用 + 文本总结（基线）

**Prompt**：
> 看一下 package.json 和 README.md，告诉我这是什么项目

**结果**：

| 轮 | thinking | tools | text | usage in/out | 耗时 |
|---|---|---|---|---|---|
| 1 | Y(107) | **2** (并行) | 0 | 16056/143 | 4307ms |
| 2 | Y(78) | 0 | 694 | 17632/326 | 5434ms |

✅ PASS — 0 RESPONSES_FAILED；并行 tools=2 没触发 "insufficient tool messages"

### 用例 2：写文件 + 读回验证

**Prompt**：
> 在 docs 目录下创建一个 hello.txt 写入 'codex test passed'，然后读回来验证内容正确

**结果**：

| 轮 | thinking | tools | text | usage in/out | 耗时 |
|---|---|---|---|---|---|
| 1 | Y(147) | 1 | 0 | 16067/104 | 3707ms |
| 2 | Y(73) | 0 | 33 | 16223/27 | 1835ms |

✅ PASS

### 用例 3：多文件读取 + 总结

**Prompt**：
> 分别 cat 一下 cli.js、proxy/proxy.js、src/ui.js 的前 3 行，最后告诉我每个文件的第一行分别是什么

**结果**：

| 轮 | thinking | tools | text | usage in/out | 耗时 |
|---|---|---|---|---|---|
| 1 | Y(158) | 1 | 0 | 16075/98 | 3570ms |
| 2 | Y(108) | 0 | 210 | 16335/101 | 2638ms |

✅ PASS

### 用例 4：todo CLI 完整项目（7 轮长会话）

**Prompt**：让 codex 写一个 Node.js todo CLI（add/list/done/delete 四子命令），跑端到端验证。

**结果**：

| 轮 | thinking | tools | text | usage in/out | 耗时 |
|---|---|---|---|---|---|
| 1 | Y(274) | 1 | 0 | 16343/170 | 5403ms |
| 2 | Y(30) | 1 | 0 | 16518/801 | 11202ms |
| 3 | Y(68) | 1 | 0 | 17366/115 | 2760ms |
| 4 | Y(69) | 1 | 0 | 17495/305 | 4918ms |
| 5 | Y(68) | 1 | 0 | 18011/107 | 2464ms |
| 6 | Y(92) | 1 | 0 | 18261/113 | 2565ms |
| 7 | Y(43) | 0 | 659 | 18388/335 | 5103ms |

✅ PASS — 0 失败；产物：todo.js (107 行) + .todos.json 验证完整通过

### 用例 5（核心）：HTTP 文件管理服务 5 端点 + 7 测试（21 轮长会话）

**Prompt**：
> 写一个 Node.js HTTP 文件管理服务（5 端点：GET / / GET /files / GET /files/:name / POST /files/:name / DELETE /files/:name），加 test.sh 跑 7 个 curl 断言，最后输出 ALL 7 TESTS PASS。

**最长 21 轮，input token 从 16450 累积到 21254**：

| 轮 | thinking | tools | text | usage in/out | 耗时 |
|---|---|---|---|---|---|
| 1 | Y(283) | 1 | 0 | 16450/195 | 4872ms |
| 2 | Y(493) | 1 | 0 | 16647/978 | 13125ms |
| 3 | Y(52) | 1 | 0 | 17644/724 | 10448ms |
| 4 | Y(26) | 1 | 0 | 18419/117 | 2895ms |
| 5 | **Y(1296)** | 1 | 0 | 18550/1136 | 15998ms |
| 6 | Y(18) | 1 | 0 | 19737/116 | 3157ms |
| 7 | N | 1 | 0 | 19867/117 | 2625ms |
| 8 | **Y(1031)** | 1 | 56 | 20245/416 | 6603ms |
| 9 | Y(54) | 1 | 0 | 21120/120 | 3521ms |
| 10 | N | 0 | 1054 | 21254/428 | 6671ms |
| ... | | | | | (合计 21 轮) |

✅ **PASS** — 全程 0 RESPONSES_FAILED；产物 server.js (83 行) + test.sh (58 行)；test.sh 实际输出 `ALL 7 TESTS PASS`

---

## 3. 修复痕迹

### 用例 5 在 v1.3.3 是失败的（**这就是这份报告的价值**）

`v1.3.3` 同样 prompt 跑：
- 第 5 轮（thinking=Y(94) text=63 tools=1）成功
- 之后**连续 4 次 RESPONSES_FAILED**：
  ```
  "The reasoning_content in the thinking mode must be passed back to the API"
  ```

### 根因（在测试代理里临时加 input dump 抓出的）

codex 第 6 轮发的 input 序列：
```
[0..2] developer + 2 user
[3] reasoning
[4] function_call call_a (update_plan)
[5] function_call_output call_a
[6] reasoning
[7] function_call call_b (exec_command)
[8] function_call_output call_b
[9] reasoning              ← 关键
[10] message role=assistant ← 消化掉了 #9 reasoning
[11] function_call call_c   ← 没有自己的 reasoning！
[12] function_call_output call_c
```

之前 `responsesInputToMessages` 把 `pendingReasoning` 在 `#10 message` 处用掉清空，到 `#11 function_call` flush 时 reasoning_content 为空，DeepSeek 拒绝。

### v1.3.4 修复

引入 `lastReasoning` fallback：

```js
function consumeReasoning() {
  if (pendingReasoning) {
    lastReasoning = pendingReasoning;
    const v = pendingReasoning;
    pendingReasoning = '';
    return v;
  }
  return lastReasoning;  // 没有新 reasoning 时复用上一次
}
```

`flushToolCalls()` 和 `message` 处理都通过 `consumeReasoning()` 拿值。`user` 消息出现时同时清空 `pendingReasoning` 和 `lastReasoning`（开启新轮次组）。

新增测试用例 `orphan function_call after assistant message reuses last reasoning`（test.js）。

---

## 4. 已知非阻塞警告

### 4.1 supported_reasoning_levels schema mismatch

```
ERROR codex_models_manager::manager: failed to refresh available models:
  invalid type: string "low", expected struct ReasoningEffortPreset
```

代理 `/v1/models` 端点返回的 `supported_reasoning_levels` 字符串数组 codex 不接受。已改为空数组 `[]` 不再报这个错；但又出现新错误：

```
missing field `shell_type`
```

codex 期望 model 列表里有 `shell_type` 字段（具体 schema 未公开）。**非阻塞**——codex 会 fallback 到 `-c` 配置继续工作。

**未来动作**：找到 codex 真实 schema 字段补齐，让启动时不再报红字。

### 4.2 DeepSeek TLS 偶发抖动

```
RESPONSES_FAILED connection_error: Client network socket disconnected before secure TLS connection
```

不是逻辑 bug，是 DeepSeek 服务端偶发 TLS 抖动。codex 自身 retry 即可恢复。

---

## 5. 使用此协议的指引

后续任何 Codex 路径修改，**必须按本协议跑一次回归**才能算修复完成：

1. 启隔离代理（17862 端口）
2. 至少跑用例 4（todo CLI，7 轮）+ 用例 5（HTTP 文件服务，21 轮长会话）
3. 全程 0 RESPONSES_FAILED 才算通过
4. 把当次 RESPONSES_DONE 行表追加到本报告，留下时间序列

**不接受用 `npm test` 通过即视为修复完成**——假上游不模拟 DeepSeek 端 schema 校验，会漏掉 reasoning_content 回传、tool_calls 配对、上下文累积这一类 bug。
