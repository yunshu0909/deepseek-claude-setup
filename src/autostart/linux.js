/**
 * Linux 开机自启 adapter — 当前为静默 no-op
 *
 * v0.4 PRD-004 计划用 systemd --user unit 实现。Linux 用户在此期间能跑代理，
 * 但需手动启动（无开机自启）。
 *
 * @module src/autostart/linux
 */

function install() {}

function uninstall() {}

function isInstalled() { return false; }

function getSpawnOptions() {
  return { detached: true, stdio: 'pipe' };
}

module.exports = { install, uninstall, isInstalled, getSpawnOptions };
