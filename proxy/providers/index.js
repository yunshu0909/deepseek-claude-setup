/**
 * Provider 注册表
 *
 * 负责：
 * - 集中注册可用 provider
 * - 按 id 查询 provider 定义
 * - 提供 provider 列表给配置归一化与 runtime proxy 使用
 *
 * @module proxy/providers
 */

const deepseek = require('./deepseek');
const zai = require('./zai');
const kimi = require('./kimi');

// v1.6.1：接入智谱 BigModel + Kimi（Moonshot）。全部走 gateway 能力声明驱动，核心层 0 provider id 分支。
const PROVIDERS = {
  [deepseek.id]: deepseek,
  [zai.id]: zai,
  [kimi.id]: kimi,
};

/**
 * 按 id 查询 provider 定义
 * @param {string} id - provider id
 * @returns {object|null} provider 定义；未知 id 返回 null
 */
function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * 列出所有 provider 定义
 * @returns {object[]} provider 定义数组
 */
function listProviders() {
  return Object.values(PROVIDERS);
}

module.exports = { getProvider, listProviders };
