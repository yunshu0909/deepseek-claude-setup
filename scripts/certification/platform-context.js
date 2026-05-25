/**
 * 平台上下文采集
 *
 * 负责：
 * - 采集分支、commit、dirty 文件和 Node 运行信息
 * - 生成平台来源证明字段，防止三平台报告互相冒充
 * - 避免把用户绝对路径硬编码进认证逻辑
 *
 * @module scripts/certification/platform-context
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../../package.json');

/**
 * 安全执行 git 命令。
 * @param {string[]} args - git 参数。
 * @param {string} cwd - 仓库路径。
 * @returns {{ok: boolean, stdout: string, stderr: string}} 执行结果。
 */
function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * 生成不暴露主机名的稳定证明。
 * @param {string} hostname - 原始 hostname。
 * @returns {string} sha256 短 hash。
 */
function hashHostname(hostname) {
  return crypto.createHash('sha256').update(hostname || 'unknown').digest('hex').slice(0, 16);
}

/**
 * 采集认证报告需要的平台上下文。
 * @param {{cwd?: string, argv?: string[], startedAt?: string}} [options] - 采集选项。
 * @returns {object} 平台上下文字段。
 */
function collectPlatformContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const branch = git(['branch', '--show-current'], cwd);
  const commit = git(['rev-parse', '--short', 'HEAD'], cwd);
  const dirty = git(['status', '--porcelain'], cwd);
  const dirtyFiles = dirty.ok && dirty.stdout
    ? dirty.stdout.split(/\r?\n/).filter(Boolean)
    : [];

  return {
    repoPath: cwd,
    branch: branch.ok ? branch.stdout : null,
    commit: commit.ok ? commit.stdout : null,
    isDirty: dirtyFiles.length > 0,
    dirtyFiles,
    packageVersion: pkg.version,
    prdId: 'PRD-015-v1.5.0-provider-certification',
    testPlanId: 'PRD-015-v1.5.0-provider-certification-测试用例',
    baselineTestPlan: 'PRD-012-provider-onboarding-certification',
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    hostnameHash: hashHostname(os.hostname()),
    runnerId: `${process.platform}-${process.arch}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    startedAt: options.startedAt || new Date().toISOString(),
    runCommand: ['node', ...(options.argv || process.argv.slice(1))].join(' '),
    nodeExecPath: process.execPath,
    nodeVersion: process.version,
    gitAvailable: branch.ok && commit.ok && dirty.ok,
    gitError: branch.ok && commit.ok && dirty.ok ? null : [branch.stderr, commit.stderr, dirty.stderr].filter(Boolean).join('\n'),
  };
}

module.exports = {
  collectPlatformContext,
  hashHostname,
};
