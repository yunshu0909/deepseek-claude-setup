/**
 * 三平台发布门禁
 *
 * 负责：
 * - 读取 Mac / Windows / Linux 三平台认证报告
 * - 重新计算 P0、true-key、dirty 和 provenance 门禁
 * - 防止 capture-only、artifact-only 或 BLOCKED 报告冒充 release 通过
 *
 * @module scripts/certification/release-gate
 */

const fs = require('fs');
const path = require('path');
const { getProviderProfile, requiredP0CasesForPlatform, requiredTrueKeyCasesForPlatform, STATUSES } = require('./provider-profiles');

const REQUIRED_PROVENANCE_FIELDS = [
  'platform',
  'osType',
  'osRelease',
  'arch',
  'hostnameHash',
  'runnerId',
  'startedAt',
  'finishedAt',
  'runCommand',
  'nodeExecPath',
  'repoPath',
  'branch',
  'commit',
];

function readReport(input) {
  if (typeof input === 'object' && input !== null) return input;
  const file = fs.statSync(input).isDirectory() ? path.join(input, 'report.json') : input;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasRequiredProvenance(report) {
  return REQUIRED_PROVENANCE_FIELDS.every(field => report[field]);
}

function platformProvenanceMatches(report, expectedPlatform) {
  const execPath = String(report.nodeExecPath || '');
  const osType = String(report.osType || '');
  // os.release() is a version string on macOS; os.type() carries the OS family name.
  if (expectedPlatform === 'darwin') return osType === 'Darwin' && !/^[A-Za-z]:\\/.test(execPath);
  if (expectedPlatform === 'win32') return osType === 'Windows_NT' && /^[A-Za-z]:\\/.test(execPath);
  if (expectedPlatform === 'linux') return osType === 'Linux' && !/^[A-Za-z]:\\/.test(execPath);
  return true;
}

function evidenceRefsAreReadable(testCase) {
  return Array.isArray(testCase.evidenceRefs)
    && testCase.evidenceRefs.length > 0
    && testCase.evidenceRefs.every(ref => typeof ref === 'string' && fs.existsSync(ref));
}

function validatePlatformReport(report, profile, expectedPlatform) {
  const failures = [];
  const cases = Array.isArray(report.testCases) ? report.testCases : [];
  const byId = new Map(cases.map(tc => [tc.id, tc]));

  if (report.providerId !== profile.id) {
    failures.push(`provider mismatch: expected ${profile.id}, got ${report.providerId || 'missing'}`);
  }
  if (report.platform !== expectedPlatform) {
    failures.push(`platform mismatch: expected ${expectedPlatform}, got ${report.platform || 'missing'}`);
  }
  if (!hasRequiredProvenance(report)) {
    failures.push('missing platform provenance fields');
  } else if (!platformProvenanceMatches(report, expectedPlatform)) {
    failures.push('platform provenance conflicts with expected platform');
  }
  if (report.isDirty) {
    failures.push('worktree is dirty');
  }
  if (report.passed !== true) {
    failures.push('platform report did not pass');
  }
  if (report.secretScan?.passed === false) {
    failures.push('platform report contains secret scan hits');
  }

  for (const id of requiredP0CasesForPlatform(profile, expectedPlatform)) {
    const tc = byId.get(id);
    if (!tc) {
      failures.push(`${id} missing`);
      continue;
    }
    if (tc.status !== STATUSES.PASS) {
      failures.push(`${id} is ${tc.status}`);
    }
    if (tc.status === STATUSES.PASS && Number(tc.positiveAssertions || 0) <= 0) {
      failures.push(`${id} has zero positive assertions`);
    }
    if (tc.status === STATUSES.PASS && !evidenceRefsAreReadable(tc)) {
      failures.push(`${id} has no readable evidence references`);
    }
  }

  for (const id of requiredTrueKeyCasesForPlatform(profile, expectedPlatform)) {
    const tc = byId.get(id);
    if (!tc) {
      failures.push(`${id} true-key missing`);
      continue;
    }
    if (tc.evidenceType !== 'true-key') failures.push(`${id} evidence is ${tc.evidenceType}, expected true-key`);
    if (tc.status !== STATUSES.PASS) failures.push(`${id} true-key is ${tc.status}`);
  }

  if (!cases.some(tc => tc.evidenceType === 'true-key' && tc.status === STATUSES.PASS)) {
    failures.push('no passed true-key evidence');
  }

  return {
    platform: expectedPlatform,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * 汇总 release gate。
 * @param {{providerId?: string, reports?: Array<object|string>, requiredPlatforms?: string[], expectedBranch?: string, expectedCommit?: string}} options - 门禁选项。
 * @returns {object} release gate 汇总。
 */
function evaluateReleaseGate(options = {}) {
  const providerId = options.providerId || 'deepseek';
  const profile = getProviderProfile(providerId);
  if (!profile) throw new Error(`unknown provider: ${providerId}`);
  const requiredPlatforms = options.requiredPlatforms || profile.requiredPlatforms;
  const reports = (options.reports || []).map(readReport);
  const byPlatform = new Map(reports.map(report => [report.platform, report]));
  const expectedBranch = options.expectedBranch || profile.releaseBranch;
  const expectedCommit = options.expectedCommit || reports[0]?.commit;
  const runnerIds = reports.map(report => report.runnerId).filter(Boolean);
  const duplicateRunnerIds = new Set(runnerIds.filter((id, index) => runnerIds.indexOf(id) !== index));
  const platforms = requiredPlatforms.map(platform => {
    const report = byPlatform.get(platform);
    if (!report) {
      return {
        platform,
        passed: false,
        failures: ['platform not executed'],
      };
    }
    const result = validatePlatformReport(report, profile, platform);
    if (!expectedBranch || report.branch !== expectedBranch) result.failures.push(`branch is not target release branch ${expectedBranch || 'missing'}`);
    if (!expectedCommit || report.commit !== expectedCommit) result.failures.push('commit differs across platform reports or is missing');
    if (duplicateRunnerIds.has(report.runnerId)) result.failures.push('runnerId duplicated across platform reports');
    result.passed = result.failures.length === 0;
    return result;
  });

  return {
    providerId,
    passed: platforms.every(item => item.passed),
    requiredPlatforms,
    expectedBranch,
    expectedCommit,
    platforms,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const reports = args.filter(arg => !arg.startsWith('--'));
  const providerArg = args.find(arg => arg.startsWith('--provider='));
  const providerId = providerArg ? providerArg.split('=')[1] : 'deepseek';
  try {
    const summary = evaluateReleaseGate({ providerId, reports });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.passed ? 0 : 1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_PROVENANCE_FIELDS,
  evaluateReleaseGate,
  platformProvenanceMatches,
  validatePlatformReport,
};
