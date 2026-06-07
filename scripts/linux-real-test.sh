#!/usr/bin/env bash
#
# v1.6.0 Linux 真实测试 —— 在你的 Linux 服务器上跑
# 真启动 Codex + Claude Code + Hermes 去打真 DeepSeek，确认迁移后 gateway 在 Linux 0 问题。
#
# 用法（在 Linux 服务器上）：
#   export DEEPSEEK_API_KEY=sk-你的真key
#   bash scripts/linux-real-test.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

ok=0; fail=0
section() { echo ""; echo "========== $1 =========="; }
pass()    { echo "✅ $1"; ok=$((ok+1)); }
bad()     { echo "❌ $1"; fail=$((fail+1)); }

section "0. 前置检查"
command -v node >/dev/null 2>&1 && echo "node: $(node -v)" || { bad "缺 node (>=16)"; exit 1; }
command -v claude >/dev/null 2>&1 && echo "claude: $(claude --version 2>&1 | head -1)" || bad "缺 claude CLI（Claude Code）—— 认证的 true-key 用例需要它"
command -v codex  >/dev/null 2>&1 && echo "codex:  $(codex --version 2>&1 | head -1)"  || bad "缺 codex CLI —— 认证的 true-key 用例需要它"
[ -n "${DEEPSEEK_API_KEY:-}" ] && echo "DEEPSEEK_API_KEY: 已设置 (len=${#DEEPSEEK_API_KEY})" || bad "未设置 DEEPSEEK_API_KEY —— 真实测试必须"
[ -d node_modules ] || { echo "首次运行，npm install ..."; npm install >/dev/null 2>&1 && echo "deps 安装完成" || bad "npm install 失败"; }

section "1. 本地单测（应 116/0，与 Mac 一致）"
if npm test 2>&1 | tail -6; then pass "npm test 全绿"; else bad "npm test 有失败 —— 看上面输出"; fi

section "2. 正式认证：真 Codex/Claude Code/Hermes → DeepSeek（PRD-015 56 例）"
echo "（真花钱、含长任务，约 10~15 分钟）"
if DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" node scripts/certify-provider.js --provider deepseek 2>&1 | grep -iE "\"passed\"|\"status\"|PASS|FAIL|BLOCKED|report:" | tail -20; then
  echo "（认证报告在 reports/provider-certification/deepseek-linux-*/report.json）"
else
  bad "certify:provider 异常退出"
fi

section "3. Linux 专属：Hermes systemd 常驻 smoke"
if DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" npm run smoke:hermes-linux 2>&1 | grep -iE "HERMES_OK|PASS|FAIL|systemd|status" | tail -10; then
  pass "Linux Hermes smoke 跑完（看上面 HERMES_OK / status）"
else
  bad "smoke:hermes-linux 异常"
fi

section "结果"
echo "前置/收尾检查：$ok 通过 / $fail 失败"
echo "真正的判定看上面第 2 步认证报告里每个用例的 PASS/FAIL/BLOCKED，"
echo "以及第 3 步 Linux Hermes 的 HERMES_OK。把 reports/ 里的 report.json/.md 发我，我帮你核。"
[ "$fail" -eq 0 ] || echo "⚠️ 有前置/收尾失败项，先处理（多半是缺 claude/codex CLI 或 key）。"
