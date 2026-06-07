/**
 * 配置存储模块
 *
 * 负责：
 * - 读写 ~/.deepseek-claude/config.json
 * - 将历史 DeepSeek-only 扁平配置归一化为 Provider Gateway 结构（{activeProvider, providers}）
 *
 * 注意：normalizeConfig 复用 ../proxy/runtime-config 的源码实现（CLI 侧直接 require 源码，
 * 不依赖已部署到 ~/.deepseek-claude/ 的运行时文件），保证 CLI 与 proxy 归一化逻辑同源。
 *
 * @module src/config-store
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const runtimeConfig = require('../proxy/runtime-config');

const DIR = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude');
const CONFIG_PATH = path.join(DIR, 'config.json');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function read() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 将历史扁平配置或新配置归一化为 Provider Gateway 结构
 * @param {object|null} config - 原始配置对象（可能是旧版 {apiKey,model,thinking,effort}）
 * @returns {object|null} 归一化后的 {activeProvider, thinking, effort, providers, apiKey, model}；无法归一化时返回 null
 */
function normalizeConfig(config) {
  return runtimeConfig.normalizeConfig(config);
}

function write(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { read, write, normalizeConfig, DIR };
