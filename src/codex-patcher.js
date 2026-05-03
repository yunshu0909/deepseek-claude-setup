const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');
const PROXY_URL = process.env.DEEPSEEK_CLAUDE_PROXY_URL
  || (process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? `http://localhost:${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}` : 'http://localhost:17861');
const START = '# >>> deepseek-claude-setup codex';
const END = '# <<< deepseek-claude-setup codex';
const ORIG_START = '# --- original default profile ---';
const ORIG_END = '# --- end original ---';

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

function parseDefaultProfile(content) {
  const sectionMatch = content.match(/\[profiles\.default\]\n([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return null;
  const kv = {};
  for (const line of sectionMatch[1].split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.+)$/);
    if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return Object.keys(kv).length ? kv : null;
}

function parseOriginalFromComments(content) {
  const block = readManagedBlock(content);
  if (!block) return null;
  const m = block.match(new RegExp(`${ORIG_START.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n([\\s\\S]*?)${ORIG_END.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  if (!m) return null;
  const lines = m[1].trim();
  if (lines === '(none)') return { none: true };
  const kv = {};
  for (const line of lines.split('\n')) {
    const kvMatch = line.match(/^#\s*(\w+)\s*=\s*(.+)$/);
    if (kvMatch) kv[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, '').trim();
  }
  return Object.keys(kv).length ? kv : null;
}

function parseDefaultFromBackup() {
  const backupPath = `${CODEX_CONFIG_PATH}.deepseek-backup`;
  if (!fs.existsSync(backupPath)) return null;
  return parseDefaultProfile(fs.readFileSync(backupPath, 'utf-8'));
}

function readManagedBlock(content) {
  const pattern = new RegExp(`${START.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'g');
  const m = content.match(pattern);
  return m ? m[0] : null;
}

function originalDefaultsComment(original) {
  if (!original || Object.keys(original).length === 0) return '(none)';
  return Object.entries(original).map(([k, v]) => `# ${k} = ${JSON.stringify(String(v))}`).join('\n');
}

function managedBlock(config, original) {
  const model = config.model || 'deepseek-v4-pro';
  const effort = normalizeEffort(config);
  const origStr = originalDefaultsComment(original);
  return `${START}
[model_providers.deepseek_local]
name = "DeepSeek Local Proxy"
base_url = "${PROXY_URL}/v1"
wire_api = "responses"
experimental_bearer_token = ${toTomlString(config.apiKey || 'sk-placeholder')}
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 600000

${ORIG_START}
${origStr}
${ORIG_END}

[profiles.default]
model_provider = "deepseek_local"
model = ${toTomlString(model)}
model_reasoning_effort = ${toTomlString(effort)}
${END}`;
}

function patch(config = {}) {
  ensureDir();
  backup();
  const stripped = stripManagedBlock(read());
  const original = parseDefaultProfile(stripped);
  const next = `${stripped}\n\n${managedBlock(config, original)}\n`.trimStart();
  fs.writeFileSync(CODEX_CONFIG_PATH, next);
}

function restore() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  const current = read();

  // 尝试从注释提取原始 default profile
  let original = parseOriginalFromComments(current);

  // Fallback: 从 backup 文件提取
  if (!original) original = parseDefaultFromBackup();

  let next = stripManagedBlock(current);

  // 写回原始 default profile
  if (original && !original.none) {
    const existingDefaults = parseDefaultProfile(next);
    if (!existingDefaults) {
      const lines = Object.entries(original).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`);
      next = `${next}\n\n[profiles.default]\n${lines.join('\n')}\n`;
    }
  }

  fs.writeFileSync(CODEX_CONFIG_PATH, next ? `${next}\n` : '');
  return true;
}

function isPatched() {
  const content = read();
  if (!content.includes(START)) return false;
  // v0.1 旧格式：profiles.deepseek
  if (content.includes('[profiles.deepseek]')) return true;
  // v0.2 新格式：profiles.default 指向 deepseek_local
  return /\[profiles\.default\]/.test(content) && /model_provider\s*=\s*"deepseek_local"/.test(content);
}

module.exports = { patch, restore, isPatched, CODEX_CONFIG_PATH, PROXY_URL };
