const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deepseek.claude-proxy.plist');
const PROXY_SCRIPT = path.join(CONFIG_DIR, 'proxy.js');

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
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'ignore' });
}

function uninstall() {
  try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(PLIST_PATH); } catch {}
}

function isInstalled() {
  return fs.existsSync(PLIST_PATH);
}

module.exports = { install, uninstall, isInstalled };
