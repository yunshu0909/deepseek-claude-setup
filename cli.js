#!/usr/bin/env node
/**
 * CLI 入口
 *
 * 负责：
 * - 检查 GitHub main 是否有新版并自动升级
 * - 读取/创建本地 Provider Gateway 配置
 * - 启动交互式主面板并注入代理、启动项、patcher 依赖
 *
 * @module cli
 */
const { intro, outro } = require('@clack/prompts');
const https = require('https');
const fs = require('fs');
const path = require('path');
const configStore = require('./src/config-store');
const proxyManager = require('./src/proxy-manager');
const autostart = require('./src/autostart');
const settingsPatcher = require('./src/settings-patcher');
const codexPatcher = require('./src/codex-patcher');
const hermesPatcher = require('./src/hermes-patcher');
const ui = require('./src/ui');
const pkg = require('./package.json');

const REPO = 'yunshu0909/deepseek-claude-setup';
const UPSTREAM_REF = 'main';
const SHA_CACHE = path.join(configStore.DIR, '.cli_sha');

/**
 * 启动时检查 GitHub 最新 commit，发现新版**自动**清 npx 缓存 + 重新 npx +
 * 重启进程。用户感知：进入工具时短暂等待 1-2 秒，自动拉到最新版。
 *
 * 死锁防护：自动升级时给子进程设 DEEPSEEK_CLAUDE_SKIP_UPDATE=1 环境变量，
 * 子进程跳过此检查，避免无限重启循环。
 *
 * 1.5s 超时；无网络/API 失败/spawn 失败均静默 fallback，让当前版本继续跑。
 *
 * @returns {Promise<void>} 永不抛错；触发自动升级时不会 resolve（直接 process.exit）
 */
function checkForUpdate() {
  // 子进程或显式跳过：不再递归检查
  if (process.env.DEEPSEEK_CLAUDE_SKIP_UPDATE) return Promise.resolve();

  return new Promise(resolve => {
    let cached = '';
    try { cached = fs.readFileSync(SHA_CACHE, 'utf-8').trim(); } catch {}

    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/commits/${UPSTREAM_REF}`,
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
          // 首次记录 SHA：不触发升级（避免新装用户误升级）
          if (!cached) {
            try { fs.mkdirSync(configStore.DIR, { recursive: true }); fs.writeFileSync(SHA_CACHE, latest); } catch {}
            return resolve();
          }
          // 检测到新版 → 自动升级
          const short = latest.slice(0, 7);
          const subject = (j.commit?.message || '').split('\n')[0].slice(0, 60);
          console.log('');
          console.log(`⏳ 检测到新版 ${short}: ${subject}`);
          console.log(`   正在自动升级（清 npx 缓存 + 重新拉取最新代码）...`);
          console.log('');

          // 清 npx 缓存
          const npxCache = path.join(require('os').homedir(), '.npm', '_npx');
          try { fs.rmSync(npxCache, { recursive: true, force: true }); } catch {}

          // 同步 spawn 重新跑 npx，stdio:inherit 让用户看到下载/启动过程
          // shell:true 跨 cmd/PowerShell/bash 通用；DEEPSEEK_CLAUDE_SKIP_UPDATE 防递归
          const { spawnSync } = require('child_process');
          // 跨平台都用引号包 ref，Windows cmd/PS 把 # 当注释起始，加引号永远安全
          const cmd = `npx -y "github:${REPO}#${UPSTREAM_REF}"`;
          const result = spawnSync(cmd, [], {
            stdio: 'inherit',
            shell: true,
            env: { ...process.env, DEEPSEEK_CLAUDE_SKIP_UPDATE: '1' },
          });

          // 子进程成功才更新 cache（失败留下旧 cache，下次启动重试）
          if (result.status === 0) {
            try { fs.writeFileSync(SHA_CACHE, latest); } catch {}
          }
          process.exit(result.status || 0);
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

  const config = configStore.readNormalized();

  if (!config) {
    // 首次使用 → 配置向导
    const newCfg = await ui.configWizard(null);
    if (!newCfg) return;  // 用户取消
    // 配置完直接进主面板
    await ui.mainPanel(newCfg, proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
  } else {
    // 已有配置 → 主面板
    await ui.mainPanel(config, proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
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
