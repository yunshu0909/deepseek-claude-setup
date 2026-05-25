/**
 * Linux systemd adapter
 *
 * 负责：
 * - 为 DeepSeek 本地代理生成 systemd unit
 * - 普通用户使用 systemd --user，root 使用 system service
 * - 在非 systemd 环境返回明确 unsupported，不伪装成功
 *
 * @module src/autostart/linux
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const PROXY_SCRIPT = path.join(CONFIG_DIR, 'proxy.js');
const UNIT_NAME = 'deepseek-claude-proxy.service';
const USER_SYSTEMD_DIR = process.env.DEEPSEEK_CLAUDE_SYSTEMD_USER_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
const SYSTEM_SYSTEMD_DIR = process.env.DEEPSEEK_CLAUDE_SYSTEMD_SYSTEM_DIR || '/etc/systemd/system';

function scope() {
  if (process.env.DEEPSEEK_CLAUDE_SYSTEMD_SCOPE) return process.env.DEEPSEEK_CLAUDE_SYSTEMD_SCOPE;
  return process.getuid?.() === 0 ? 'system' : 'user';
}

function unitDir() {
  return scope() === 'system' ? SYSTEM_SYSTEMD_DIR : USER_SYSTEMD_DIR;
}

function unitPath() {
  return path.join(unitDir(), UNIT_NAME);
}

function systemctlArgs(...args) {
  return scope() === 'system' ? ['systemctl', ...args] : ['systemctl', '--user', ...args];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runSystemctl(...args) {
  const cmd = systemctlArgs(...args).map(shellQuote).join(' ');
  execSync(cmd, { stdio: 'ignore' });
}

function systemdQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isSystemdAvailable() {
  if (process.env.DEEPSEEK_CLAUDE_DISABLE_SYSTEMD === '1') return false;
  if (process.env.DEEPSEEK_CLAUDE_FORCE_SYSTEMD === '1') return true;
  return fs.existsSync('/run/systemd/system') || Boolean(process.env.INVOCATION_ID);
}

/**
 * 构造 systemd unit 内容。
 * @returns {string} systemd service 文件内容
 */
function buildServiceUnit() {
  const env = [`DEEPSEEK_CLAUDE_CONFIG_DIR=${CONFIG_DIR}`];
  if (process.env.DEEPSEEK_CLAUDE_PROXY_PORT) {
    env.push(`DEEPSEEK_CLAUDE_PROXY_PORT=${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}`);
  }
  if (process.env.DEEPSEEK_CLAUDE_LOG_PATH) {
    env.push(`DEEPSEEK_CLAUDE_LOG_PATH=${process.env.DEEPSEEK_CLAUDE_LOG_PATH}`);
  }
  const envLines = env.map(item => `Environment="${systemdQuote(item)}"`).join('\n');
  const wantedBy = scope() === 'system' ? 'multi-user.target' : 'default.target';
  return `[Unit]
Description=DeepSeek Claude Proxy
After=network-online.target

[Service]
Type=simple
ExecStart="${systemdQuote(process.execPath)}" "${systemdQuote(PROXY_SCRIPT)}"
WorkingDirectory="${systemdQuote(CONFIG_DIR)}"
Restart=always
RestartSec=3
${envLines}

[Install]
WantedBy=${wantedBy}
`;
}

/**
 * 注册 systemd 常驻服务。
 * @returns {{ok:boolean,supported:boolean,installed:boolean,scope:string,path:string,message?:string}}
 */
function install() {
  const currentScope = scope();
  const currentPath = unitPath();
  if (!isSystemdAvailable()) {
    return {
      ok: false,
      supported: false,
      installed: false,
      scope: currentScope,
      path: currentPath,
      message: `当前环境未检测到 systemd，请手动运行：${process.execPath} ${PROXY_SCRIPT}`,
    };
  }

  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  fs.writeFileSync(currentPath, buildServiceUnit());
  try {
    runSystemctl('daemon-reload');
    runSystemctl('enable', '--now', UNIT_NAME);
  } catch (err) {
    return {
      ok: false,
      supported: true,
      installed: true,
      scope: currentScope,
      path: currentPath,
      message: err.message,
    };
  }
  return { ok: true, supported: true, installed: true, scope: currentScope, path: currentPath };
}

function uninstall() {
  const currentPath = unitPath();
  try { runSystemctl('disable', '--now', UNIT_NAME); } catch {}
  try { fs.unlinkSync(currentPath); } catch {}
  try { runSystemctl('daemon-reload'); } catch {}
}

function isInstalled() {
  return fs.existsSync(unitPath());
}

function status() {
  return {
    installed: isInstalled(),
    supported: isSystemdAvailable(),
    scope: scope(),
    path: unitPath(),
  };
}

function getSpawnOptions() {
  return { detached: true, stdio: 'pipe' };
}

module.exports = {
  install,
  uninstall,
  isInstalled,
  status,
  getSpawnOptions,
  buildServiceUnit,
  isSystemdAvailable,
  UNIT_NAME,
  unitPath,
};
