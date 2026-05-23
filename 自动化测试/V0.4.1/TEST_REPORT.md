# V0.4.1 Hermes Target 测试报告

## 当前结论

本地自动化通过；服务器真实场景待 GitHub main / Release 发布后用最新 `npx` 复验。

## 本地自动化

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | PASS | `test.js` 57/0，`test/hermes-target.test.js` 12/0，总计 69/0 |
| `node cli.js --enable-hermes` isolated smoke | PASS | 临时 config/Hermes 文件验证非交互接管成功，且 Hermes 配置未写真实 key |

## 服务器真实场景

待 GitHub main / Release 发布后，用最新 `npx` 在服务器执行：

```bash
npx -y github:yunshu0909/deepseek-claude-setup --enable-hermes
```

验收证据需包含：

- proxy `/__health` 返回 OK
- Hermes config 指向 `http://127.0.0.1:17861/v1`
- `hermes -z ...` 返回 `OK`
- proxy 日志出现 `CHAT_POST` 与 `CHAT_DONE`

## 明确不覆盖

- 微信端到端不属于本次改动范围。
- Hermes vision/image_url 兼容性只诊断，不在 v1.4.1 修复。
