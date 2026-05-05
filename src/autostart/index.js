/**
 * 跨平台开机自启抽象层 — 按 process.platform 路由到具体 adapter
 *
 * 核心契约（PRD-003 §3.1）：
 * - 所有平台特定代码必须封装在 darwin.js / win32.js / linux.js 内
 * - 调用方（src/proxy-manager.js / src/ui.js / cli.js）禁止出现 process.platform 判断
 *
 * 各 adapter 必须实现的统一接口：
 * - install(): void              注册开机自启
 * - uninstall(): void            取消注册
 * - isInstalled(): boolean       是否已注册
 * - getSpawnOptions(): object    spawn(...) 用的平台特定 options
 *
 * @module src/autostart
 */
const platform = process.platform;

const impl = platform === 'darwin' ? require('./darwin')
           : platform === 'win32' ? require('./win32')
           : platform === 'linux' ? require('./linux')
           : null;

const noop = {
  install() {},
  uninstall() {},
  isInstalled() { return false; },
  getSpawnOptions() { return { detached: true, stdio: 'ignore' }; },
};

module.exports = impl || noop;
