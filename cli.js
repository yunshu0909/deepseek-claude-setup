#!/usr/bin/env node
const { intro, outro } = require('@clack/prompts');
const https = require('https');
const fs = require('fs');
const path = require('path');
const configStore = require('./src/config-store');
const proxyManager = require('./src/proxy-manager');
const autostart = require('./src/autostart');
const settingsPatcher = require('./src/settings-patcher');
const codexPatcher = require('./src/codex-patcher');
const ui = require('./src/ui');
const pkg = require('./package.json');

const REPO = 'yunshu0909/deepseek-claude-setup';
const SHA_CACHE = path.join(configStore.DIR, '.cli_sha');

/**
 * 启动时异步检查 GitHub main 分支最新 commit，若与本地缓存的 SHA 不同
 * 则给出升级提示。1.5s 超时，无网时静默跳过。
 *
 * 不破坏 npx 缓存机制（缓存的破坏由用户决定执行升级命令），仅做"提示"。
 *
 * @returns {Promise<void>} 永不抛错
 */
function checkForUpdate() {
  return new Promise(resolve => {
    let cached = '';
    try { cached = fs.readFileSync(SHA_CACHE, 'utf-8').trim(); } catch {}

    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/commits/main`,
      method: 'GET',
      headers: { 'User-Agent': 'deepseek-claude-setup', 'Accept': 'application/vnd.github+json' },
      timeout: 1500,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          const latest = j.sha || '';
          if (!latest) return resolve();
          if (cached && cached === latest) return resolve();
          // 首次记录 SHA：不提示（避免新装用户误以为已经过期）
          if (!cached) {
            try { fs.mkdirSync(configStore.DIR, { recursive: true }); fs.writeFileSync(SHA_CACHE, latest); } catch {}
            return resolve();
          }
          // 检测到新版
          const short = latest.slice(0, 7);
          const subject = (j.commit?.message || '').split('\n')[0].slice(0, 60);
          console.log('');
          console.log(`⚠ 检测到新版 ${short}: ${subject}`);
          console.log(`  当前缓存版本：${cached.slice(0, 7)}`);
          console.log(`  立即升级：`);
          console.log(`    rm -rf ~/.npm/_npx && npx -y github:${REPO}`);
          console.log(`    （Windows: rm -r "$HOME\\.npm\\_npx" -ErrorAction SilentlyContinue）`);
          console.log(`  或继续使用当前版本 → 按回车进入主面板`);
          console.log('');
          // 写新 SHA 到缓存（让下次再有新提交才提示，避免重复打扰）
          try { fs.writeFileSync(SHA_CACHE, latest); } catch {}
          resolve();
        } catch { resolve(); }
      });
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

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
  // 启动时检查 GitHub 最新 commit（1.5s 超时，无网静默跳过）
  await checkForUpdate();

  const config = configStore.read();

  if (!config) {
    // 首次使用 → 配置向导
    const newCfg = await ui.configWizard(null);
    if (!newCfg) return;  // 用户取消
    // 配置完直接进主面板
    await ui.mainPanel(newCfg, proxyManager, autostart, settingsPatcher, codexPatcher);
  } else {
    // 已有配置 → 主面板
    await ui.mainPanel(config, proxyManager, autostart, settingsPatcher, codexPatcher);
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
