/**
 * 代理运行时配置模块
 *
 * 负责：
 * - 读取 ~/.deepseek-claude/config.json
 * - 将历史 DeepSeek-only 配置归一化为 Provider Gateway 结构
 * - 为 proxy.js 提供 active provider 的兼容 apiKey/model 字段
 *
 * @module proxy/runtime-config
 */
const fs = require('fs');
const providers = require('./providers');

const DEFAULT_PROVIDER = 'deepseek';

/**
 * 将历史配置或新配置归一化为 Provider Gateway 结构
 * @param {object|null} config - 原始配置对象
 * @returns {object|null} 归一化配置；无法归一化时返回 null
 */
function normalizeConfig(config) {
  if (!config || typeof config !== 'object') return null;

  const activeProvider = config.activeProvider || DEFAULT_PROVIDER;
  const rawProviders = config.providers && typeof config.providers === 'object'
    ? { ...config.providers }
    : {};

  if ((config.apiKey || config.model) && !rawProviders.deepseek) {
    rawProviders.deepseek = {
      apiKey: config.apiKey,
      model: config.model,
    };
  }

  const normalizedProviders = {};
  for (const [id, providerConfig] of Object.entries(rawProviders)) {
    const provider = providers.getProvider(id);
    normalizedProviders[id] = provider
      ? provider.normalizeConfig(providerConfig || {})
      : { ...(providerConfig || {}) };
  }

  if (!normalizedProviders[activeProvider]) {
    const provider = providers.getProvider(activeProvider);
    normalizedProviders[activeProvider] = provider
      ? provider.normalizeConfig({})
      : {};
  }

  const activeConfig = normalizedProviders[activeProvider] || {};
  return {
    activeProvider,
    thinking: config.thinking === 'disabled' ? 'disabled' : 'enabled',
    effort: config.effort || 'max',
    providers: normalizedProviders,
    apiKey: activeConfig.apiKey,
    model: activeConfig.model,
  };
}

/**
 * 读取并归一化代理运行时配置
 * @param {string} configPath - config.json 路径
 * @returns {object} 归一化后的 Provider Gateway 配置
 */
function readConfig(configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const config = normalizeConfig(raw);
  if (!config?.apiKey) throw new Error('缺少 apiKey');
  return config;
}

module.exports = { normalizeConfig, readConfig };
