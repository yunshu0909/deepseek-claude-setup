/**
 * 代理文件包部署模块
 *
 * 负责：
 * - 枚举 proxy 目录下的运行时代码文件
 * - 比对已部署代理文件是否为当前版本
 * - 将代理文件包复制到本地配置目录供 LaunchAgent/子进程启动
 *
 * @module proxy-bundle
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_DIR = path.join(__dirname, '..', 'proxy');

/**
 * 枚举代理文件包中的 JS 运行时文件
 * @param {string} [sourceDir] - proxy 源码目录
 * @returns {{name: string, source: string}[]} 代理文件清单
 */
function listProxyBundleFiles(sourceDir = DEFAULT_SOURCE_DIR) {
  const files = [];

  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push({ name: rel, source: full });
      }
    }
  }

  walk(sourceDir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 判断目标目录中的代理文件包是否与当前源码一致
 * @param {string} targetDir - 已部署代理目录
 * @param {string} [sourceDir] - proxy 源码目录
 * @returns {boolean} true 表示所有代理文件都已是最新
 */
function isProxyBundleCurrent(targetDir, sourceDir = DEFAULT_SOURCE_DIR) {
  return listProxyBundleFiles(sourceDir).every(file => {
    const target = path.join(targetDir, file.name);
    try {
      return fs.readFileSync(file.source, 'utf-8') === fs.readFileSync(target, 'utf-8');
    } catch {
      return false;
    }
  });
}

/**
 * 将代理文件包部署到目标目录
 * @param {string} targetDir - 已部署代理目录
 * @param {string} [sourceDir] - proxy 源码目录
 * @returns {boolean} true 表示文件被写入或更新
 */
function deployProxyBundle(targetDir, sourceDir = DEFAULT_SOURCE_DIR) {
  const files = listProxyBundleFiles(sourceDir);
  const current = isProxyBundleCurrent(targetDir, sourceDir);
  if (current) return false;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const target = path.join(targetDir, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.source, target);
  }
  return true;
}

module.exports = { listProxyBundleFiles, isProxyBundleCurrent, deployProxyBundle };
