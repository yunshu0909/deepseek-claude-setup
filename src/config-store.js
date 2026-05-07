/**
 * 配置存储模块
 *
 * 负责：
 * - 读写 ~/.deepseek-claude/config.json
 * - 将 v0.1-v0.4 DeepSeek-only 配置归一化为 v0.5 Provider Gateway 配置
 * - 为旧调用方保留 apiKey/model 顶层兼容字段
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
 * 将历史配置或新配置归一化为 Provider Gateway 结构
 * @param {object|null} config - 原始配置对象
 * @returns {object|null} 归一化配置；无法读取时返回 null
 */
function normalizeConfig(config) {
  return runtimeConfig.normalizeConfig(config);
}

/**
 * 读取并归一化配置，但不写回文件
 * @returns {object|null} Provider Gateway 结构配置
 */
function readNormalized() {
  return normalizeConfig(read());
}

function write(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { read, readNormalized, normalizeConfig, write, DIR, CONFIG_PATH };
