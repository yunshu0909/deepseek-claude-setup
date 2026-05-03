const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');
const PROXY_URL = process.env.DEEPSEEK_CLAUDE_PROXY_URL
  || (process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? `http://localhost:${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}` : 'http://localhost:17861');
const START = '# >>> deepseek-claude-setup codex';
const END = '# <<< deepseek-claude-setup codex';

function ensureDir() {
  fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true });
}

function read() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return '';
  return fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
}

function backup() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;
  const backupPath = `${CODEX_CONFIG_PATH}.deepseek-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, read());
  }
}

function stripManagedBlock(content) {
  const pattern = new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n?`, 'g');
  return content.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function toTomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeEffort(config) {
  if (config.thinking === 'disabled') return 'minimal';
  if (config.effort === 'max') return 'xhigh';
  return config.effort || 'high';
}

function managedBlock(config) {
  const model = config.model || 'deepseek-v4-pro';
  const effort = normalizeEffort(config);
  return `${START}
[model_providers.deepseek_local]
name = "DeepSeek Local Proxy"
base_url = "${PROXY_URL}/v1"
wire_api = "responses"
experimental_bearer_token = ${toTomlString(config.apiKey || 'sk-placeholder')}
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 600000

[profiles.deepseek]
model_provider = "deepseek_local"
model = ${toTomlString(model)}
model_reasoning_effort = ${toTomlString(effort)}
${END}`;
}

function patch(config = {}) {
  ensureDir();
  backup();
  const next = `${stripManagedBlock(read())}\n\n${managedBlock(config)}\n`.trimStart();
  fs.writeFileSync(CODEX_CONFIG_PATH, next);
}

function restore() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  const next = stripManagedBlock(read());
  fs.writeFileSync(CODEX_CONFIG_PATH, next ? `${next}\n` : '');
  return true;
}

function isPatched() {
  return read().includes(START) && read().includes('[profiles.deepseek]');
}

module.exports = { patch, restore, isPatched, CODEX_CONFIG_PATH, PROXY_URL };
