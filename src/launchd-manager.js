const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deepseek.claude-proxy.plist');
const PROXY_SCRIPT = path.join(CONFIG_DIR, 'proxy.js');

const SERVICE_TARGET = `gui/${process.getuid?.() ?? 501}/com.deepseek.claude-proxy`;

function install() {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deepseek.claude-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${PROXY_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/deepseek-claude-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/deepseek-claude-proxy.err</string>
</dict>
</plist>`;
  fs.writeFileSync(PLIST_PATH, plist);
  // 优先使用 bootstrap（macOS 10.10+ 推荐），失败时降级到 load 兼容旧系统
  try {
    execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`, { stdio: 'ignore', shell: '/bin/bash' });
  } catch {
    try { execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'ignore' }); } catch {}
  }
}

function uninstall() {
  // 先 bootout，失败再 unload
  try { execSync(`launchctl bootout ${SERVICE_TARGET}`, { stdio: 'ignore' }); } catch {
    try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }); } catch {}
  }
  try { fs.unlinkSync(PLIST_PATH); } catch {}
}

function isInstalled() {
  return fs.existsSync(PLIST_PATH);
}

module.exports = { install, uninstall, isInstalled };
