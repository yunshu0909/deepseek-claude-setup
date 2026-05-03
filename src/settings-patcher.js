const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
const PROXY_URL = process.env.DEEPSEEK_CLAUDE_PROXY_URL
  || (process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? `http://localhost:${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}` : 'http://localhost:17861');
const DIRECT_URL = 'https://api.deepseek.com/anthropic';
const FLASH_MODEL = 'deepseek-v4-flash';
const SAVED_CONFIG_PATH = path.join(process.env.DEEPSEEK_CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.deepseek-claude'), 'config.json');

function read() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
}

function backup() {
  const src = read();
  if (!src) return;
  if (fs.existsSync(SETTINGS_PATH + '.deepseek-backup')) return;
  fs.writeFileSync(SETTINGS_PATH + '.deepseek-backup', JSON.stringify(src, null, 2));
}

function readSavedConfig() {
  try {
    if (!fs.existsSync(SAVED_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(SAVED_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function restore() {
  const bak = SETTINGS_PATH + '.deepseek-backup';
  if (fs.existsSync(bak)) {
    fs.writeFileSync(SETTINGS_PATH, fs.readFileSync(bak, 'utf-8'));
    fs.unlinkSync(bak);
    return true;
  }

  // Fallback for manually deleted backups: never leave Claude Code pointing at a stopped local proxy.
  if (fs.existsSync(SETTINGS_PATH)) {
    const s = read();
    if (s && s.env) {
      const saved = readSavedConfig();
      const model = saved.model || s.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';
      s.env.ANTHROPIC_BASE_URL = DIRECT_URL;
      if (saved.apiKey) {
        s.env.ANTHROPIC_AUTH_TOKEN = saved.apiKey;
      }
      s.env.ANTHROPIC_MODEL = model;
      s.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      s.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = FLASH_MODEL;
      if (s.env.CLAUDE_CODE_EFFORT_LEVEL && s.effortLevel === s.env.CLAUDE_CODE_EFFORT_LEVEL) {
        delete s.effortLevel;
      }
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
    }
  }
  return false;
}

function patch(config = {}) {
  if (!fs.existsSync(SETTINGS_PATH)) throw new Error('找不到 Claude Code settings.json，请确认 Claude Code 已安装');
  const s = read();
  if (!s.env) s.env = {};
  backup();

  const model = config.model || s.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';
  const effort = config.effort || s.env.CLAUDE_CODE_EFFORT_LEVEL || 'max';

  s.env.ANTHROPIC_BASE_URL = PROXY_URL;
  if (config.apiKey) {
    s.env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  }
  s.env.ANTHROPIC_MODEL = model;
  s.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  s.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model === FLASH_MODEL ? FLASH_MODEL : FLASH_MODEL;
  s.env.CLAUDE_CODE_SUBAGENT_MODEL = model === FLASH_MODEL ? FLASH_MODEL : FLASH_MODEL;
  s.env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  s.model = model;
  s.effortLevel = effort;
  s.alwaysThinkingEnabled = true;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function isPatched() {
  const s = read();
  if (!s || !s.env) return false;
  return s.env.ANTHROPIC_BASE_URL === PROXY_URL;
}

module.exports = { patch, restore, isPatched, SETTINGS_PATH, PROXY_URL, DIRECT_URL };
