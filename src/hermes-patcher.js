/**
 * Hermes 接入配置模块
 *
 * 负责：
 * - 发现并备份 Hermes Agent 的 config.yaml
 * - 将 Hermes 模型运行时切到 OpenAI Chat Completions + 本地 Provider Gateway
 * - 在关闭接入时还原原始 Hermes 配置
 * - 输出不泄露真实 key 的接入诊断信息
 *
 * @module src/hermes-patcher
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const DEFAULT_SYSTEM_CONFIG = '/var/lib/hermes/config.yaml';
const CONFIG_PATH = process.env.HERMES_CONFIG_PATH
  || (fs.existsSync(DEFAULT_SYSTEM_CONFIG) ? DEFAULT_SYSTEM_CONFIG : path.join(HERMES_HOME, 'config.yaml'));
const BACKUP_PATH = `${CONFIG_PATH}.deepseek-backup`;
const PROXY_URL = process.env.DEEPSEEK_CLAUDE_PROXY_URL
  || (process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? `http://127.0.0.1:${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}` : 'http://127.0.0.1:17861');
const LOCAL_TOKEN = 'deepseek-claude-local';

/**
 * 判断当前机器是否存在可接管的 Hermes 配置。
 * @returns {boolean} true 表示 config.yaml 存在
 */
function isAvailable() {
  return fs.existsSync(CONFIG_PATH);
}

function read() {
  if (!fs.existsSync(CONFIG_PATH)) return '';
  return fs.readFileSync(CONFIG_PATH, 'utf-8');
}

function backup() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  if (!fs.existsSync(BACKUP_PATH)) {
    fs.writeFileSync(BACKUP_PATH, read());
  }
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function sectionBounds(lines, section) {
  const start = lines.findIndex(line => new RegExp(`^${section}:\\s*$`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function setSectionValue(content, section, key, value) {
  const lines = content.split('\n');
  let bounds = sectionBounds(lines, section);
  if (!bounds) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`${section}:`);
    bounds = { start: lines.length - 1, end: lines.length };
  }

  const pattern = new RegExp(`^(\\s*)${key}:\\s*.*$`);
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const match = lines[i].match(pattern);
    if (match && match[1].length > 0) {
      lines[i] = `${match[1]}${key}: ${value}`;
      return lines.join('\n');
    }
  }

  lines.splice(bounds.start + 1, 0, `  ${key}: ${value}`);
  return lines.join('\n');
}

function hermesReasoningEffort(config) {
  if (config.thinking === 'disabled') return 'low';
  return 'high';
}

/**
 * 将 Hermes Agent 接入当前 DeepSeek Gateway。
 *
 * Hermes 自身不认识 DeepSeek/Codex 里的 `max`/`xhigh`，直接写入会降级并刷 warning。
 * 这里显式写 `high/low`，真正的 DeepSeek thinking 强度仍由本地 proxy config 控制。
 *
 * @param {object} config - Provider Gateway 配置
 * @returns {boolean} true 表示已写入配置
 */
function patch(config = {}) {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`找不到 Hermes config.yaml：${CONFIG_PATH}`);
  }
  backup();
  const model = config.model || 'deepseek-v4-pro';
  let content = read();
  content = setSectionValue(content, 'model', 'api_mode', yamlScalar('chat_completions'));
  content = setSectionValue(content, 'model', 'provider', yamlScalar('custom'));
  content = setSectionValue(content, 'model', 'default', yamlScalar(model));
  content = setSectionValue(content, 'model', 'base_url', yamlScalar(`${PROXY_URL}/v1`));
  content = setSectionValue(content, 'model', 'api_key', yamlScalar(LOCAL_TOKEN));
  content = setSectionValue(content, 'agent', 'reasoning_effort', yamlScalar(hermesReasoningEffort(config)));
  fs.writeFileSync(CONFIG_PATH, content.endsWith('\n') ? content : `${content}\n`);
  return true;
}

/**
 * 还原 Hermes Agent 原始配置。
 * @returns {boolean} true 表示成功从备份还原
 */
function restore() {
  if (!fs.existsSync(BACKUP_PATH)) return false;
  fs.writeFileSync(CONFIG_PATH, fs.readFileSync(BACKUP_PATH, 'utf-8'));
  fs.unlinkSync(BACKUP_PATH);
  return true;
}

function sectionValue(content, section, key) {
  const lines = content.split('\n');
  const bounds = sectionBounds(lines, section);
  if (!bounds) return null;
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`);
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    return match[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * 判断 Hermes 是否已由本工具接管到 OpenAI Chat Completions 链路。
 * @returns {boolean} true 表示当前配置指向本地 Provider Gateway
 */
function isPatched() {
  const content = read();
  return sectionValue(content, 'model', 'api_mode') === 'chat_completions'
    && sectionValue(content, 'model', 'base_url') === `${PROXY_URL}/v1`;
}

function redact(value) {
  if (value == null) return value;
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-****')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ****');
}

/**
 * 读取 Hermes 接管状态。
 * @returns {object} Hermes config 路径、关键 model 字段和接管状态
 */
function getStatus() {
  const available = isAvailable();
  const content = available ? read() : '';
  return {
    available,
    configPath: CONFIG_PATH,
    backupPath: BACKUP_PATH,
    patched: available ? isPatched() : false,
    model: {
      provider: redact(sectionValue(content, 'model', 'provider')),
      default: redact(sectionValue(content, 'model', 'default')),
      base_url: redact(sectionValue(content, 'model', 'base_url')),
      api_mode: redact(sectionValue(content, 'model', 'api_mode')),
      api_key: sectionValue(content, 'model', 'api_key') ? '****' : null,
    },
    agent: {
      reasoning_effort: redact(sectionValue(content, 'agent', 'reasoning_effort')),
    },
  };
}

/**
 * 生成 Hermes 诊断对象，不包含任何明文 provider key。
 * @param {object|null} proxyHealth - proxy /__health 返回值
 * @param {object} serviceStatus - autostart 或 systemd 状态
 * @returns {object} 可直接展示的诊断信息
 */
function diagnose(proxyHealth = null, serviceStatus = {}) {
  const status = getStatus();
  const directExternal = Boolean(status.model.base_url && !String(status.model.base_url).startsWith(PROXY_URL));
  return {
    target: 'Hermes Agent',
    config: status,
    proxy: proxyHealth ? {
      ok: Boolean(proxyHealth.ok),
      provider: redact(proxyHealth.provider),
      model: redact(proxyHealth.model),
      thinking: redact(proxyHealth.thinking),
      effort: redact(proxyHealth.effort),
    } : { ok: false },
    service: {
      installed: Boolean(serviceStatus.installed),
      scope: serviceStatus.scope || 'unknown',
      path: redact(serviceStatus.path || ''),
      supported: serviceStatus.supported !== false,
    },
    warnings: [
      directExternal ? 'Hermes 当前 base_url 不是本地 proxy，模型配置尚未被本工具接管。' : null,
      '已知边界：Hermes browser_vision 发送的 image_url 形状可能被 DeepSeek Chat Completions 拒绝；本版只诊断，不修复 vision。',
    ].filter(Boolean),
  };
}

module.exports = {
  patch,
  restore,
  isPatched,
  isAvailable,
  getStatus,
  diagnose,
  CONFIG_PATH,
  PROXY_URL,
  LOCAL_TOKEN,
};
