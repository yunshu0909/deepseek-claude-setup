const fs = require('fs');
const path = require('path');
const os = require('os');

// CODEX_CONFIG_PATH（测试用）> CODEX_HOME（OpenAI 未来可能引入的环境变量）> 默认 ~/.codex
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(CODEX_HOME, 'config.toml');
// 用 127.0.0.1 而不是 localhost：proxy 只 bind v4，部分系统 localhost 解析为 ::1 会连不上
const PROXY_URL = process.env.DEEPSEEK_CLAUDE_PROXY_URL
  || (process.env.DEEPSEEK_CLAUDE_PROXY_PORT ? `http://127.0.0.1:${process.env.DEEPSEEK_CLAUDE_PROXY_PORT}` : 'http://127.0.0.1:17861');
const START = '# >>> deepseek-claude-setup codex';
const END = '# <<< deepseek-claude-setup codex';
const ORIG_START = '# --- original default profile ---';
const ORIG_END = '# --- end original ---';
const TOP_LEVEL_KEYS = ['model', 'model_reasoning_effort', 'model_provider'];

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

/**
 * 清掉游离在 managed block 之外的同名 section（避免 TOML 1.0 同表重复定义错误）
 *
 * 实战触发：v0.2 旧 patcher 残留、用户手工编辑、异常退出会留下裸的
 *   [model_providers.deepseek_local] 或 [profiles.default] 段在 managed block 之外。
 * patch 时再写 managed block → 文件出现两个同名表 → TOML 1.0 不允许 →
 * codex 报 "Model provider 'deepseek_local' not found"（整个 model_providers 表被吞）。
 *
 * @param {string} content - 已 stripManagedBlock 后的 content
 * @param {string} sectionHeader - 例如 '[model_providers.deepseek_local]' 或 '[profiles.default]'
 * @returns {string} 删除该 section 整段（直到下一个 [...] 或文件末）后的 content
 */
function stripStrayTomlSection(content, sectionHeader) {
  // 匹配从 sectionHeader 到下一个 ^[...] 或文件末（不含下一段 header）
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)${escaped}\\s*\\n[\\s\\S]*?(?=\\n\\[|$)`, 'g');
  return content.replace(pattern, '').replace(/\n{3,}/g, '\n\n').trimEnd();
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
  const result = { topLevel: null, profile: null };

  // Parse sections within comment block
  let section = null;
  for (const line of lines.split('\n')) {
    const secMatch = line.match(/^#\s*\[(top-level|profiles\.default)\]/);
    if (secMatch) {
      section = secMatch[1];
      continue;
    }
    if (!section) continue;
    if (line === '# (none)') continue;
    const kvMatch = line.match(/^#\s*(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const val = kvMatch[2].replace(/^["']|["']$/g, '').trim();
      if (section === 'top-level') {
        if (!result.topLevel) result.topLevel = {};
        result.topLevel[kvMatch[1]] = val;
      } else {
        if (!result.profile) result.profile = {};
        result.profile[kvMatch[1]] = val;
      }
    }
  }
  return (result.topLevel || result.profile) ? result : null;
}

function parseFromBackup() {
  const backupPath = `${CODEX_CONFIG_PATH}.deepseek-backup`;
  if (!fs.existsSync(backupPath)) return null;
  const content = fs.readFileSync(backupPath, 'utf-8');
  const topLevel = parseTopLevelSettings(content);
  const profile = parseDefaultProfile(content);
  return (topLevel || profile) ? { topLevel, profile } : null;
}

function readManagedBlock(content) {
  const pattern = new RegExp(`${START.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'g');
  const m = content.match(pattern);
  return m ? m[0] : null;
}

// Extract the part of content before any [section] header — these are the true top-level keys.
function topLevelRegion(content) {
  const idx = content.search(/^\[/m);
  return idx === -1 ? content : content.slice(0, idx);
}

function parseTopLevelSettings(content) {
  const region = topLevelRegion(content);
  const kv = {};
  for (const key of TOP_LEVEL_KEYS) {
    const m = region.match(new RegExp(`^${key}\\s*=\\s*["']?([^"'\n]+)["']?\\s*$`, 'm'));
    if (m) kv[key] = m[1].trim();
  }
  return Object.keys(kv).length ? kv : null;
}

function stripTopLevelSettings(content) {
  const tlr = topLevelRegion(content);
  if (!tlr) return content.trim();
  let result = tlr;
  for (const key of TOP_LEVEL_KEYS) {
    result = result.replace(new RegExp(`^${key}\\s*=\\s*["']?[^"'\n]+["']?\\s*\\n?`, 'm'), '');
  }
  // Re-attach the sectioned portion
  const idx = content.search(/^\[/m);
  const sections = idx === -1 ? '' : content.slice(idx);
  result = (result.trim() + '\n\n' + sections).trim();
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function originalDefaultsComment(original, topLevel) {
  const parts = [];
  if (topLevel && Object.keys(topLevel).length > 0) {
    parts.push('# [top-level]');
    parts.push(...Object.entries(topLevel).map(([k, v]) => `# ${k} = ${JSON.stringify(String(v))}`));
  }
  if (!original || Object.keys(original).length === 0) {
    parts.push('# [profiles.default]\n# (none)');
  } else {
    parts.push('# [profiles.default]');
    parts.push(...Object.entries(original).map(([k, v]) => `# ${k} = ${JSON.stringify(String(v))}`));
  }
  return parts.join('\n');
}

function managedBlock(config, original, topLevel) {
  const model = config.model || 'deepseek-v4-pro';
  const effort = normalizeEffort(config);
  const origStr = originalDefaultsComment(original, topLevel);
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
  let content = read();
  content = stripManagedBlock(content);
  // 关键：清理游离的同名 section（避免 TOML 1.0 同表重复定义导致 codex 解析失败）
  // v0.2 残留 / 手工编辑 / 异常退出会留下裸的 [model_providers.deepseek_local]
  // 或 [profiles.default] 在 managed block 之外。下一次 patch 写 managed block →
  // 文件出现双 section → TOML 解析吞表 → codex 报 "Model provider not found"
  content = stripStrayTomlSection(content, '[model_providers.deepseek_local]');
  // 备份原顶层 model/effort/provider 到 managed block 注释（restore 时还原）
  const originalTopLevel = parseTopLevelSettings(content);
  if (originalTopLevel) content = stripTopLevelSettings(content);
  const originalProfile = parseDefaultProfile(content);

  // 顶层写入 deepseek 覆盖：codex 0.128 在 ChatGPT 账号登录态下，顶层
  // model_provider 是路由的决定性字段，[profiles.default] 在登录态下被
  // 视为次要建议会被无视。Windows 用户实战暴露此问题（Mac 上因 v0.2 期间
  // 残留而碰巧 work，不是设计 work）。
  const model = config.model || 'deepseek-v4-pro';
  const effort = normalizeEffort(config);
  const topLevelOverride = [
    `model = ${toTomlString(model)}`,
    `model_reasoning_effort = ${toTomlString(effort)}`,
    `model_provider = "deepseek_local"`,
  ].join('\n');

  const next = `${topLevelOverride}\n\n${content}\n\n${managedBlock(config, originalProfile, originalTopLevel)}\n`.trimStart();
  fs.writeFileSync(CODEX_CONFIG_PATH, next);
}

/**
 * 过滤"原顶层"里 v0.2 残留的我们自己的污染，不能当作用户原值还原
 *
 * 实战：用户 .deepseek-backup 里可能保存的"原顶层"已经包含 model_provider="deepseek_local"
 * 或 model="deepseek-v4-*"（这是 v0.2 旧 patcher 写入但来不及消毒的污染）。
 * restore 时若机械还原会写回 deepseek_local 引用 → managed block 已删 →
 * codex 找不到 [model_providers.deepseek_local] 报 'not found'。
 */
function sanitizeOriginalTopLevel(topLevel) {
  if (!topLevel) return topLevel;
  const cleaned = { ...topLevel };
  if (cleaned.model_provider === 'deepseek_local') delete cleaned.model_provider;
  if (typeof cleaned.model === 'string' && /^deepseek-v4-/.test(cleaned.model)) delete cleaned.model;
  return Object.keys(cleaned).length ? cleaned : null;
}

function restore() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  const current = read();

  // 尝试从注释提取原始配置
  let parsed = parseOriginalFromComments(current);

  // Fallback: 从 backup 文件提取
  if (!parsed) parsed = parseFromBackup();

  // 消毒 v0.2 残留的污染 topLevel（避免还原回死引用）
  if (parsed) parsed = { ...parsed, topLevel: sanitizeOriginalTopLevel(parsed.topLevel) };

  let next = stripManagedBlock(current);
  // 清理我们在顶层写过的 deepseek 覆盖值
  next = stripTopLevelSettings(next);
  // 关键：清理任何游离的 [model_providers.deepseek_local] section（v0.2 残留 / 双 section）
  next = stripStrayTomlSection(next, '[model_providers.deepseek_local]');

  // 写回 top-level settings
  if (parsed && parsed.topLevel && Object.keys(parsed.topLevel).length > 0) {
    const topLines = Object.entries(parsed.topLevel).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`);
    next = `${topLines.join('\n')}\n\n${next}`;
  }

  // 写回原始 [profiles.default]（仅当文件中没有时）
  if (parsed && parsed.profile && Object.keys(parsed.profile).length > 0) {
    const existingDefaults = parseDefaultProfile(next);
    if (!existingDefaults) {
      const lines = Object.entries(parsed.profile).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`);
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
