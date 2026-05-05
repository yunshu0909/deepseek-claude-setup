/**
 * Windows 开机自启 adapter
 *
 * 主路径：schtasks /SC ONLOGON 注册用户级任务（普通权限可，对应 macOS LaunchAgent）
 * 降级路径：Startup 文件夹 .vbs（VBScript 静默 spawn node，不弹黑窗）
 *
 * 不需要管理员权限。不依赖任何 npm 包。失败时逐级降级，永不向用户抛错。
 *
 * @module src/autostart/win32
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const PROXY_SCRIPT = path.join(CONFIG_DIR, 'proxy.js');

const TASK_NAME = 'DeepSeekClaudeProxy';
const STARTUP_DIR = path.join(
  os.homedir(),
  'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const VBS_PATH = path.join(STARTUP_DIR, 'deepseek-claude-proxy.vbs');

const NODE_EXE = process.execPath;

// schtasks 命令在双引号内时，内部双引号需用 \" 转义
function shellQuote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// VBS 字符串字面量内的双引号用两个双引号 ""
function vbsQuote(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * 注册开机自启
 *
 * 步骤：
 * 1. 优先 schtasks 注册 onlogon 任务（与 macOS launchctl LaunchAgent 等价）
 * 2. schtasks 失败（极少见，企业 GPO 禁用等）→ 降级写 Startup 文件夹 .vbs
 * 3. 两条路径都失败 → 静默不抛错（用户当次仍可用代理，下次开机需手动开主面板）
 */
function install() {
  const tr = `${shellQuote(NODE_EXE)} ${shellQuote(PROXY_SCRIPT)}`;
  // /F 强制覆盖已存在任务（升级场景：proxy.js 路径或 node 路径变化时重新注册）
  // /RL LIMITED 普通权限运行（不需要管理员）
  // /SC ONLOGON 用户登录时启动（与 LaunchAgent KeepAlive 行为最接近的非常驻方案）
  const cmd = `schtasks /Create /F /TN ${shellQuote(TASK_NAME)} /SC ONLOGON /TR ${shellQuote(tr)} /RL LIMITED`;
  try {
    execSync(cmd, { stdio: 'ignore', windowsHide: true });
    return;
  } catch {
    // fall through to startup folder fallback
  }

  // 降级：Startup 文件夹写 VBS（CreateObject WScript.Shell + Run intWindowStyle=0 静默）
  try {
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
    const cmdLine = `${vbsQuote(NODE_EXE)} & " " & ${vbsQuote(PROXY_SCRIPT)}`;
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run ${cmdLine}, 0, False`,
    ].join('\r\n') + '\r\n';
    fs.writeFileSync(VBS_PATH, vbs);
  } catch {
    // 静默忽略 — 用户当次仍可用代理，下次开机需手动进主面板再开启
  }
}

/**
 * 取消开机自启 — 两条路径都尝试清理，确保升级或降级残留都被收拾干净
 */
function uninstall() {
  try {
    execSync(`schtasks /Delete /F /TN ${shellQuote(TASK_NAME)}`, {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {}
  try { fs.unlinkSync(VBS_PATH); } catch {}
}

/**
 * 检查是否注册了开机自启（任一路径存在即视为已注册）
 */
function isInstalled() {
  try {
    execSync(`schtasks /Query /TN ${shellQuote(TASK_NAME)}`, {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return fs.existsSync(VBS_PATH);
  }
}

/**
 * 子进程 spawn 选项 — Windows 必须 windowsHide:true 不弹黑窗；
 * stdio:'ignore' 避免 stderr 钉住父进程（Windows 上 'pipe' 行为与 macOS 不同）
 */
function getSpawnOptions() {
  return { detached: true, stdio: 'ignore', windowsHide: true };
}

module.exports = { install, uninstall, isInstalled, getSpawnOptions };
