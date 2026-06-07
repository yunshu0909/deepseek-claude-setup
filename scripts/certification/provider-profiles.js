/**
 * Provider 认证档案
 *
 * 负责：
 * - 声明 V1.5.0 支持认证的 provider
 * - 维护阶段、用例、证据类型和真 Key 矩阵
 * - 为认证器和 release gate 提供统一事实源
 *
 * @module scripts/certification/provider-profiles
 */

const STATUSES = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  SKIPPED: 'SKIPPED',
});

const FAILURE_CLASSES = Object.freeze({
  PREFLIGHT: 'preflight',
  GATEWAY: 'gateway',
  PROVIDER: 'provider',
  CLIENT: 'client',
  CLEANUP: 'cleanup',
});

const TEST_CASES = [
  ['TC-001', 0, 'npm 基础测试退出码为 0', 'artifact-only', 'P0', 'gateway'],
  ['TC-002', 0, '认证 npm script 存在', 'artifact-only', 'P0', 'preflight'],
  ['TC-003', 0, '认证器要求显式 provider 参数', 'artifact-only', 'P0', 'preflight'],
  ['TC-004', 0, '未注册 provider 不得继续认证', 'artifact-only', 'P0', 'preflight'],
  ['TC-005', 0, 'DeepSeek profile 被识别为基准 provider', 'artifact-only', 'P0', 'preflight'],
  ['TC-006', 0, '报告记录分支、commit 与 dirty 状态', 'artifact-only', 'P0', 'cleanup'],
  ['TC-007', 0, '阶段失败会停止后续阶段', 'artifact-only', 'P0', 'gateway'],
  ['TC-008', 0, 'SKIPPED 不计入 PASS', 'artifact-only', 'P0', 'cleanup'],
  ['TC-009', 1, '缺少 DeepSeek Key 时真 Key 阶段 BLOCKED', 'artifact-only', 'P0', 'provider'],
  ['TC-010', 1, 'DeepSeek health 返回当前模型与 thinking', 'true-key', 'P0', 'gateway'],
  ['TC-011', 1, 'Anthropic Messages 真 Key 短文本 2xx', 'true-key', 'P0', 'provider'],
  ['TC-012', 1, 'Responses 真 Key 短文本 completed', 'true-key', 'P0', 'gateway'],
  ['TC-013', 1, 'Responses 真 Key 返回 output_text 非空', 'true-key', 'P0', 'gateway'],
  ['TC-014', 1, 'Claude Code 短文本返回固定 marker', 'true-key', 'P0', 'client'],
  ['TC-015', 1, 'Claude Code 工具调用读取随机文件', 'true-key', 'P0', 'client'],
  ['TC-016', 2, 'Claude Code 命令执行任务能创建文件并运行 node', 'true-key', 'P0', 'client'],
  ['TC-017', 2, 'Claude Code Flash + thinking off 短任务通过', 'true-key', 'P0', 'client'],
  ['TC-018', 2, 'Claude Code Pro + thinking on + max 短任务通过', 'true-key', 'P0', 'client'],
  ['TC-019', 1, 'Codex 工具调用读取随机文件', 'true-key', 'P0', 'client'],
  ['TC-020', 2, 'Codex 命令执行任务能创建文件并运行 node', 'true-key', 'P0', 'client'],
  ['TC-021', 2, 'Codex Flash + thinking off 工具任务通过', 'true-key', 'P0', 'client'],
  ['TC-022', 2, 'Codex Pro + thinking on + max 工具任务通过', 'true-key', 'P0', 'client'],
  ['TC-023', 2, 'Codex Responses 日志不含 RESPONSES_FAILED', 'true-key', 'P0', 'gateway'],
  ['TC-024', 2, 'Pro 模型抓包字段一致', 'capture', 'P0', 'gateway'],
  ['TC-025', 2, 'Flash 模型抓包字段一致且无 pro 残留', 'capture', 'P0', 'gateway'],
  ['TC-026', 2, 'Anthropic thinking on 发送 enabled', 'capture', 'P0', 'gateway'],
  ['TC-027', 2, 'Anthropic thinking on 发送 output_config.effort', 'capture', 'P0', 'gateway'],
  ['TC-028', 2, 'Anthropic thinking off 不发送 output_config', 'capture', 'P0', 'gateway'],
  ['TC-029', 2, 'Chat/Responses thinking on 发送 reasoning_effort', 'capture', 'P0', 'gateway'],
  ['TC-030', 2, 'Chat/Responses thinking off 不发送 reasoning_effort', 'capture', 'P0', 'gateway'],
  ['TC-031', 2, 'high 到 max 只改变强度', 'capture', 'P0', 'gateway'],
  ['TC-032', 2, 'Codex tool_calls 流式增量不被合并丢失', 'artifact-only', 'P0', 'gateway'],
  ['TC-033', 2, 'function_call_output 翻译为 tool message', 'artifact-only', 'P0', 'gateway'],
  ['TC-034', 2, '并行 function_call 合并成一条 assistant tool_calls', 'artifact-only', 'P0', 'gateway'],
  ['TC-035', 2, 'reasoning_content 附加到工具调用 assistant 消息', 'artifact-only', 'P0', 'gateway'],
  ['TC-036', 2, 'Chat 工具请求 max 5xx fallback 到 high', 'artifact-only', 'P0', 'gateway'],
  ['TC-037', 3, 'Codex 长任务 TASK-LONG-TODO', 'true-key', 'P0', 'client'],
  ['TC-038', 3, 'Claude Code 长任务 TASK-LONG-TODO', 'true-key', 'P0', 'client'],
  ['TC-039', 4, 'Hermes config 指向本地 Chat Completions', 'artifact-only', 'P0', 'gateway'],
  ['TC-040', 4, 'Hermes config 不写真实 DeepSeek Key', 'artifact-only', 'P0', 'cleanup'],
  ['TC-041', 4, 'Hermes Chat 请求被 proxy 覆盖 model/thinking/reasoning_effort', 'artifact-only', 'P0', 'gateway'],
  ['TC-042', 4, 'Linux systemd unit 生成 server scope', 'artifact-only', 'P0', 'gateway'],
  ['TC-043', 4, 'Linux 非 systemd 环境明确 unsupported', 'artifact-only', 'P0', 'preflight'],
  ['TC-044', 4, 'Linux 服务器 Hermes 真 Key smoke 通过', 'true-key', 'P0', 'client'],
  ['TC-045', 4, '真实用户配置跑前跑后 hash 不变', 'artifact-only', 'P0', 'cleanup'],
  ['TC-046', 4, '日志、报告、证据不含真实 Key', 'artifact-only', 'P0', 'cleanup'],
  ['TC-047', 4, '临时目录清理成功', 'artifact-only', 'P1', 'cleanup'],
  ['TC-048', 4, '正向断言为 0 的用例必须失败', 'artifact-only', 'P0', 'cleanup'],
  ['TC-049', 4, '三平台报告不能互相替代', 'artifact-only', 'P0', 'cleanup'],
  ['TC-050', 4, '正式 release gate 要求 clean worktree', 'artifact-only', 'P0', 'cleanup'],
  ['TC-051', 2, 'Claude Code Pro + thinking on + high 真 Key短任务通过', 'true-key', 'P0', 'client'],
  ['TC-052', 2, 'Codex Pro + thinking on + high 真 Key工具任务通过', 'true-key', 'P0', 'client'],
  ['TC-053', 4, 'release gate 拒绝不完整平台矩阵', 'artifact-only', 'P0', 'cleanup'],
  ['TC-054', 4, 'release gate 拒绝 capture-only、仅 artifact-only 和 BLOCKED 假绿', 'artifact-only', 'P0', 'cleanup'],
  ['TC-055', 4, '平台来源证明防止复制报告冒充', 'artifact-only', 'P0', 'cleanup'],
  ['TC-056', 4, '长链路黑盒防作弊测试必须执行', 'artifact-only', 'P0', 'client'],
].map(([id, stage, name, evidenceType, priority, defaultFailureClass]) => ({
  id,
  stage,
  name,
  evidenceType,
  priority,
  defaultFailureClass,
}));

const STAGES = [
  { id: 0, name: '资格地基', gate: '任一 P0 不过，全流程停' },
  { id: 1, name: '真 Key 连通', gate: '任一 P0 不过，停在连通阶段' },
  { id: 2, name: '能力回归', gate: '任一 P0 不过，不进长链路' },
  { id: 3, name: '复杂长链路', gate: '任一不过，DeepSeek 不通过' },
  { id: 4, name: 'Hermes/Linux 与安全', gate: '任一 P0 不过，不得 release' },
];

const PROFILES = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    releaseBranch: 'codex/v1.6.0-deepseek-gateway',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    flashModel: 'deepseek-v4-flash',
    thinkingEfforts: ['high', 'max'],
    stages: STAGES,
    testCases: TEST_CASES,
    requiredPlatforms: ['darwin', 'win32', 'linux'],
    requiredTrueKeyCases: TEST_CASES
      .filter(tc => tc.priority === 'P0' && tc.evidenceType === 'true-key')
      .map(tc => tc.id),
    requiredP0Cases: TEST_CASES
      .filter(tc => tc.priority === 'P0')
      .map(tc => tc.id),
    platformOnlyCases: {
      linux: ['TC-044'],
    },
  },
};

/**
 * 返回某平台必须执行的 P0 用例。
 * @param {object} profile - provider 认证档案。
 * @param {string} platform - Node 平台标识。
 * @returns {string[]} 当前平台必测 P0 ID。
 */
function requiredP0CasesForPlatform(profile, platform) {
  const platformCases = new Set(Object.values(profile.platformOnlyCases || {}).flat());
  const selected = new Set(profile.platformOnlyCases?.[platform] || []);
  return profile.requiredP0Cases.filter(id => !platformCases.has(id) || selected.has(id));
}

/**
 * 返回某平台必须执行的 true-key 用例。
 * @param {object} profile - provider 认证档案。
 * @param {string} platform - Node 平台标识。
 * @returns {string[]} 当前平台必测 true-key ID。
 */
function requiredTrueKeyCasesForPlatform(profile, platform) {
  const p0 = new Set(requiredP0CasesForPlatform(profile, platform));
  return profile.requiredTrueKeyCases.filter(id => p0.has(id));
}

/**
 * 获取 provider 认证档案。
 * @param {string} providerId - provider id，例如 deepseek。
 * @returns {object|null} provider 档案，不存在时为 null。
 */
function getProviderProfile(providerId) {
  return PROFILES[providerId] || null;
}

/**
 * 列出已注册的 provider id。
 * @returns {string[]} provider id 列表。
 */
function listProviderIds() {
  return Object.keys(PROFILES);
}

module.exports = {
  FAILURE_CLASSES,
  STATUSES,
  TEST_CASES,
  getProviderProfile,
  listProviderIds,
  requiredP0CasesForPlatform,
  requiredTrueKeyCasesForPlatform,
};
