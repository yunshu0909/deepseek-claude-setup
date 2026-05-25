/**
 * Provider 认证报告生成器
 *
 * 负责：
 * - 创建唯一 run 目录并写入 JSON / Markdown 报告
 * - 重新聚合用例状态，阻断 SKIPPED/BLOCKED/零断言假绿
 * - 扫描报告产物，防止真实 API Key 明文泄露
 *
 * @module scripts/certification/report-writer
 */

const fs = require('fs');
const path = require('path');
const { STATUSES } = require('./provider-profiles');

const REPORT_ROOT = path.join(process.cwd(), 'reports', 'provider-certification');

/**
 * 生成唯一报告目录。
 * @param {string} providerId - provider id。
 * @param {string} platform - 当前平台。
 * @param {string} [rootDir] - 报告根目录。
 * @returns {{runId: string, runDir: string}} run 信息。
 */
function createRunDir(providerId, platform, rootDir = REPORT_ROOT) {
  fs.mkdirSync(rootDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let i = 0; i < 100; i++) {
    const suffix = i === 0 ? '' : `-${i}`;
    const runId = `${providerId}-${platform}-${stamp}${suffix}`;
    const runDir = path.join(rootDir, runId);
    try {
      fs.mkdirSync(runDir);
      return { runId, runDir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('无法创建唯一认证报告目录');
}

/**
 * 构造单条用例结果。
 * @param {object} testCase - 用例元数据。
 * @param {object} patch - 结果覆盖字段。
 * @returns {object} 标准化用例结果。
 */
function makeCaseResult(testCase, patch = {}) {
  return {
    id: testCase.id,
    name: testCase.name,
    stage: testCase.stage,
    priority: testCase.priority,
    evidenceType: testCase.evidenceType,
    evidenceRefs: [],
    status: STATUSES.BLOCKED,
    failureClass: testCase.defaultFailureClass || 'preflight',
    message: 'not executed',
    positiveAssertions: 0,
    ...patch,
  };
}

/**
 * 重新计算用例与整体结论。
 * @param {object} profile - provider profile。
 * @param {object[]} testCases - 用例结果。
 * @returns {{passed: boolean, counts: object, failures: object[], testCases: object[]}} 聚合结果。
 */
function aggregateResults(profile, testCases, options = {}) {
  const normalized = testCases.map(tc => {
    const next = { evidenceRefs: [], ...tc };
    if (next.status === STATUSES.PASS && Number(next.positiveAssertions || 0) <= 0) {
      next.status = STATUSES.FAIL;
      next.failureClass = next.failureClass || 'cleanup';
      next.message = `${next.message || 'case passed'}; rejected because positiveAssertions=0`;
    }
    return next;
  });

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
  for (const tc of normalized) counts[tc.status] = (counts[tc.status] || 0) + 1;
  const requiredCaseIds = options.requiredP0Cases || profile.requiredP0Cases || [];
  const requiredIds = new Set(requiredCaseIds);
  const gateCases = normalized.filter(tc => requiredIds.has(tc.id));
  const failures = gateCases.filter(tc => tc.status !== STATUSES.PASS);
  const presentIds = new Set(normalized.map(tc => tc.id));
  for (const id of requiredIds) {
    if (!presentIds.has(id)) {
      failures.push({
        id,
        status: STATUSES.BLOCKED,
        failureClass: 'cleanup',
        message: 'required P0 case missing from report',
      });
    }
  }

  return {
    passed: failures.length === 0,
    counts,
    failures,
    testCases: normalized,
  };
}

function redactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets.filter(Boolean)) {
    if (secret.length < 8) continue;
    out = out.split(secret).join('[REDACTED]');
    for (const length of sensitiveFragmentLengths(secret)) {
      out = out.split(secret.slice(0, length)).join('[REDACTED_PREFIX]');
    }
  }
  return out;
}

function sensitiveFragmentLengths(secret) {
  if (!secret || secret.length < 8) return [];
  const minimum = Math.min(secret.length, 12);
  return [...new Set([minimum, Math.min(secret.length, 16), Math.min(secret.length, 24)])]
    .sort((a, b) => b - a);
}

function secretFragments(secrets = []) {
  return secrets.filter(Boolean).flatMap(secret => sensitiveFragmentLengths(secret).map(length => ({
    fragment: secret.slice(0, length),
    matchedLength: length,
    secretLength: secret.length,
  })));
}

function scanFileForSecrets(file, fragments) {
  if (!fragments.length) return null;
  const maxFragmentLength = Math.max(...fragments.map(item => item.fragment.length));
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return null;
      const content = carry + buffer.subarray(0, bytesRead).toString('utf8');
      const hit = fragments.find(item => content.includes(item.fragment));
      if (hit) return { file, secretLength: hit.secretLength, matchedLength: hit.matchedLength };
      carry = content.slice(Math.max(0, content.length - maxFragmentLength + 1));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function scanForSecrets(runDir, secrets = []) {
  const hits = [];
  const fragments = secretFragments(secrets);
  const pending = [runDir];
  while (pending.length) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      continue;
    }
    const hit = scanFileForSecrets(current, fragments);
    if (hit) hits.push(hit);
  }
  return hits;
}

function renderMarkdown(report) {
  const lines = [
    `# Provider Certification Report - ${report.providerId}`,
    '',
    `- passed: ${report.passed}`,
    `- platform: ${report.platform}`,
    `- branch: ${report.branch}`,
    `- commit: ${report.commit}`,
    `- dirty: ${report.isDirty}`,
    `- runId: ${report.runId}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt}`,
    '',
    '## Summary',
    '',
    `- PASS: ${report.counts.PASS}`,
    `- FAIL: ${report.counts.FAIL}`,
    `- BLOCKED: ${report.counts.BLOCKED}`,
    `- SKIPPED: ${report.counts.SKIPPED}`,
    '',
    '## Gate Failures',
    '',
  ];
  if (!report.failures.length) {
    lines.push('- none');
  } else {
    for (const f of report.failures) lines.push(`- ${f.id}: ${f.status} (${f.failureClass || '-'}) ${f.message || ''}`);
  }
  lines.push('', '## Test Cases', '');
  for (const tc of report.testCases) {
    lines.push(`- ${tc.id} ${tc.status} [${tc.evidenceType}] assertions=${tc.positiveAssertions || 0} - ${tc.message || ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 写入认证报告。
 * @param {object} report - 报告对象。
 * @param {string[]} [secrets] - 需要脱敏扫描的秘密。
 * @returns {object} 写入后的报告对象。
 */
function writeReport(report, secrets = []) {
  fs.mkdirSync(report.runDir, { recursive: true });
  const safeReport = JSON.parse(redactText(JSON.stringify(report, null, 2), secrets));
  const jsonPath = path.join(report.runDir, 'report.json');
  const mdPath = path.join(report.runDir, 'report.md');
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(safeReport, null, 2));
    fs.writeFileSync(mdPath, renderMarkdown(safeReport));
  } catch (err) {
    safeReport.passed = false;
    safeReport.failures = [...(safeReport.failures || []), {
      id: 'report-write',
      status: STATUSES.FAIL,
      failureClass: 'cleanup',
      message: `report output failed: ${err.message}`,
    }];
    safeReport.reportWriteFailure = { failureClass: 'cleanup', message: err.message };
    // 若 Markdown 失败但 JSON 仍可写，保留机器可读的失败结论供门禁审查。
    try { fs.writeFileSync(jsonPath, JSON.stringify(safeReport, null, 2)); } catch {}
    throw err;
  }
  const secretHits = scanForSecrets(report.runDir, secrets);
  if (secretHits.length) {
    safeReport.passed = false;
    safeReport.secretScan = { passed: false, hits: secretHits };
    const secretCase = (safeReport.testCases || []).find(tc => tc.id === 'TC-046');
    if (secretCase && secretCase.status === STATUSES.PASS) {
      secretCase.status = STATUSES.FAIL;
      secretCase.failureClass = 'cleanup';
      secretCase.message = `secret scan found ${secretHits.length} evidence hit(s)`;
      safeReport.counts.PASS -= 1;
      safeReport.counts.FAIL += 1;
      safeReport.failures.push(secretCase);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(safeReport, null, 2));
    fs.writeFileSync(mdPath, renderMarkdown(safeReport));
  }
  return { ...safeReport, reportJsonPath: jsonPath, reportMarkdownPath: mdPath };
}

module.exports = {
  REPORT_ROOT,
  aggregateResults,
  createRunDir,
  makeCaseResult,
  redactText,
  scanForSecrets,
  writeReport,
};
