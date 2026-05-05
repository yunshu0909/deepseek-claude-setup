/**
 * Windows 开机自启 adapter（Phase 2 实现）
 *
 * 主路径：schtasks 用户级任务（普通权限可注册），ONLOGON 触发器 ≈ launchd LaunchAgent
 * 降级路径：Startup 文件夹 .vbs（VBScript 静默 spawn 不弹黑窗）
 *
 * Phase 1 仅提供空骨架，install/uninstall/isInstalled 全部返回安全默认值，
 * Windows 用户在 Phase 1 上跑代理仍能用（只是没开机自启），不会崩溃。
 *
 * @module src/autostart/win32
 */

function install() {
  // TODO Phase 2: schtasks /Create /SC ONLOGON ... + Startup .vbs fallback
}

function uninstall() {
  // TODO Phase 2: schtasks /Delete + 删除 Startup .vbs
}

function isInstalled() {
  return false;
}

function getSpawnOptions() {
  // Windows 必须 windowsHide:true 不弹黑窗；'ignore' 避免 stderr 钉住父进程
  return { detached: true, stdio: 'ignore', windowsHide: true };
}

module.exports = { install, uninstall, isInstalled, getSpawnOptions };
