# TEST_REPORT（V1.0）

## 1. 结果摘要
- 日期：2026-05-03
- PRD：/Users/yunshu/Documents/cc-diaodu/六幺/docs/prd/PRD-001.md
- 结论：PASS

## 2. 执行命令与结果
- `npm test`
  - result：12 passed, 0 failed
- `for f in cli.js proxy/proxy.js src/*.js test.js; do node --check "$f" || exit 1; done`
  - result：passed
- `npm pack --dry-run`
  - result：passed，tarball 包含 13 个文件

## 3. 分层覆盖结果
- Unit：6/6
- Integration：5/5
- E2E：1/1

## 4. 失败用例
- 无

## 5. 剩余风险（人工补测）
- 风险点：终端交互 UI 的键盘选择、取消流程、文案体验仍需人工走一遍。
- 风险点：LaunchAgent 真实开机自启需要在 macOS 用户环境中人工验证。
- 风险点：真实 DeepSeek API 返回格式和长流式会话仍建议用少量真实请求冒烟。

## 6. 发布门禁
- 门禁检查状态：自动化门禁通过
- 最终决策：PASS
