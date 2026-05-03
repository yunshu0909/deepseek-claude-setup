#!/usr/bin/env node
const { intro, outro } = require('@clack/prompts');
const configStore = require('./src/config-store');
const proxyManager = require('./src/proxy-manager');
const launchdManager = require('./src/launchd-manager');
const settingsPatcher = require('./src/settings-patcher');
const codexPatcher = require('./src/codex-patcher');
const ui = require('./src/ui');
const pkg = require('./package.json');

const HELP = `DeepSeek × Claude Code / Codex 一键配置工具

Usage:
  npx github:yunshu0909/deepseek-claude-setup
  deepseek-claude-setup

Options:
  -h, --help      显示帮助
  -v, --version   显示版本
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

async function main() {
  const config = configStore.read();

  if (!config) {
    // 首次使用 → 配置向导
    const newCfg = await ui.configWizard(null);
    if (!newCfg) return;  // 用户取消
    // 配置完直接进主面板
    await ui.mainPanel(newCfg, proxyManager, launchdManager, settingsPatcher, codexPatcher);
  } else {
    // 已有配置 → 主面板
    await ui.mainPanel(config, proxyManager, launchdManager, settingsPatcher, codexPatcher);
  }
}

function exitCleanly(code = 0) {
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.exit(code);
}

process.on('SIGINT', () => exitCleanly(130));

main().then(() => {
  exitCleanly(0);
}).catch(err => {
  console.error('错误:', err.message);
  exitCleanly(1);
});
