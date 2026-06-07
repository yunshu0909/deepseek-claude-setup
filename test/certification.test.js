/**
 * Provider Certification 自动化测试
 *
 * 负责：
 * - 验证 PRD-015 认证入口、provider profile 与报告聚合
 * - 验证 release gate 拒绝缺平台、dirty、缺 true-key 和假绿报告
 * - 验证 capture runner 能抓到模型、thinking 与 effort 字段
 *
 * @module test/certification
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { getProviderProfile, requiredP0CasesForPlatform, STATUSES } = require('../scripts/certification/provider-profiles');
const { collectPlatformContext } = require('../scripts/certification/platform-context');
const { aggregateResults, makeCaseResult, scanForSecrets, writeReport } = require('../scripts/certification/report-writer');
const { evaluateReleaseGate } = require('../scripts/certification/release-gate');
const { buildLinuxScript, runLinuxHermesSmoke } = require('../scripts/certification/linux-hermes-smoke');
const { runCommand } = require('../scripts/certification/runner-utils');
const { parseArgs, runCertification } = require('../scripts/certify-provider');
const { blackboxRetest, claudeArgs, gatewayFieldsMatch, healthMatches, LONG_TASK_MAX_TOOL_ROUNDS, LONG_TASK_MIN_TOOL_ROUNDS, parseSequence, runCaptureMatrix, runTrueKeyClient, snapshotWorkspace, staticCheckLongTask, trueTargets } = require('../scripts/client-e2e');

let passed = 0;
let failed = 0;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cert-fixture-'));
const fixtureEvidence = path.join(fixtureRoot, 'evidence.json');
fs.writeFileSync(fixtureEvidence, '{"fixture":true}\n');

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++;
        console.log(`  OK ${name}`);
      }).catch(err => {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${err.message}`);
      });
    }
    passed++;
    console.log(`  OK ${name}`);
    return null;
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    return null;
  }
}

function platformContext(platform) {
  const base = collectPlatformContext();
  const shared = { ...base, branch: 'codex/v1.6.0-deepseek-gateway', commit: 'fixture123', runnerId: `fixture-${platform}` };
  if (platform === 'win32') return { ...shared, platform, osType: 'Windows_NT', osRelease: '10.0.22631', nodeExecPath: 'C:\\nodejs\\node.exe' };
  if (platform === 'linux') return { ...shared, platform, osType: 'Linux', osRelease: '6.8.0-linux', nodeExecPath: '/usr/bin/node' };
  return { ...shared, platform: 'darwin', osType: 'Darwin', osRelease: '25.2.0', nodeExecPath: '/opt/homebrew/bin/node' };
}

function passingReport(profile, platform, context = platformContext(platform)) {
  return {
    ...context,
    providerId: profile.id,
    platform,
    isDirty: false,
    passed: true,
    finishedAt: new Date().toISOString(),
    testCases: requiredP0CasesForPlatform(profile, platform).map(id => makeCaseResult(profile.testCases.find(tc => tc.id === id), {
      status: STATUSES.PASS,
      positiveAssertions: 1,
      evidenceRefs: [fixtureEvidence],
    })),
  };
}

async function run() {
  const profile = getProviderProfile('deepseek');
  console.log('\n-- certification profiles --');
  check('DeepSeek profile has 56 PRD-015 cases and three required platforms', () => {
    assert.strictEqual(profile.testCases.length, 56);
    assert.deepStrictEqual(profile.requiredPlatforms, ['darwin', 'win32', 'linux']);
    assert(profile.requiredTrueKeyCases.includes('TC-044'));
    assert(profile.requiredTrueKeyCases.includes('TC-052'));
  });
  check('parseArgs requires explicit provider shape', () => {
    assert.deepStrictEqual(parseArgs(['--provider', 'deepseek', '--dry-run']).provider, 'deepseek');
    assert.strictEqual(parseArgs(['--provider=deepseek']).provider, 'deepseek');
    assert.strictEqual(parseArgs(['--provider=deepseek']).reportRoot, undefined);
  });
  check('package exposes provider and release certification scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.match(pkg.scripts['certify:provider'], /scripts\/certify-provider\.js/);
    assert.match(pkg.scripts['certify:release'], /scripts\/certification\/release-gate\.js/);
    assert.match(pkg.scripts['smoke:hermes-linux'], /linux-hermes-smoke\.js/);
  });

  console.log('\n-- report aggregation --');
  check('SKIPPED P0 does not count as PASS', () => {
    const summary = aggregateResults(profile, [
      makeCaseResult(profile.testCases[0], { status: STATUSES.SKIPPED, positiveAssertions: 1 }),
    ]);
    assert.strictEqual(summary.passed, false);
    assert.strictEqual(summary.counts.SKIPPED, 1);
  });
  check('zero positive assertions cannot remain PASS', () => {
    const summary = aggregateResults(profile, [
      makeCaseResult(profile.testCases[0], { status: STATUSES.PASS, positiveAssertions: 0 }),
    ]);
    assert.strictEqual(summary.testCases[0].status, STATUSES.FAIL);
    assert.strictEqual(summary.passed, false);
  });
  check('secret scan turns leaked TC-046 evidence into FAIL', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-secret-report-'));
    const evidenceDir = path.join(runDir, 'evidence');
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(path.join(evidenceDir, 'leak.log'), 'sk-test-secret-should-fail');
    const report = writeReport({
      ...passingReport(profile, 'darwin'),
      runDir,
      runId: 'secret-fixture',
      counts: { PASS: 56, FAIL: 0, BLOCKED: 0, SKIPPED: 0 },
      failures: [],
      finishedAt: new Date().toISOString(),
    }, ['sk-test-secret-should-fail']);
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.testCases.find(tc => tc.id === 'TC-046').status, STATUSES.FAIL);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
  check('secret scan rejects long credential fragments, not only full keys', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-secret-fragment-'));
    const key = 'sk-this-is-a-long-sensitive-secret-value';
    fs.writeFileSync(path.join(runDir, 'fragment.log'), key.slice(0, 16));
    assert.strictEqual(scanForSecrets(runDir, [key]).length, 1);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
  check('secret scan checks files larger than one MiB', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-secret-large-'));
    const key = 'sk-large-file-sensitive-secret-value';
    fs.writeFileSync(path.join(runDir, 'large.log'), `${'x'.repeat(1024 * 1024 + 32)}${key.slice(0, 24)}`);
    assert.strictEqual(scanForSecrets(runDir, [key]).length, 1);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  console.log('\n-- release gate --');
  check('release gate accepts a complete clean same-commit platform matrix', () => {
    const reports = profile.requiredPlatforms.map(platform => passingReport(profile, platform));
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, true);
  });
  check('release gate accepts a real macOS-style numeric os.release value', () => {
    const summary = evaluateReleaseGate({
      providerId: 'deepseek',
      requiredPlatforms: ['darwin'],
      reports: [passingReport(profile, 'darwin')],
    });
    assert.strictEqual(summary.passed, true);
  });
  check('release gate rejects missing platform report', () => {
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports: [passingReport(profile, 'darwin')] });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms.find(p => p.platform === 'win32').failures.join('\n'), /platform not executed/);
  });
  check('release gate rejects dirty reports', () => {
    const reports = profile.requiredPlatforms.map(platform => passingReport(profile, platform));
    reports[1].isDirty = true;
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[1].failures.join('\n'), /dirty/);
  });
  check('release gate rejects capture-only fake green', () => {
    const reports = profile.requiredPlatforms.map(platform => {
      const report = passingReport(profile, platform);
      report.testCases = report.testCases.filter(tc => tc.evidenceType !== 'true-key');
      return report;
    });
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /true-key missing|missing/);
  });
  check('release gate rejects missing provenance', () => {
    const reports = profile.requiredPlatforms.map(platform => passingReport(profile, platform));
    delete reports[2].runnerId;
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[2].failures.join('\n'), /provenance/);
  });
  check('release gate rejects a copied mac report relabeled as windows', () => {
    const copied = passingReport(profile, 'win32', platformContext('darwin'));
    copied.platform = 'win32';
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports: [copied], requiredPlatforms: ['win32'] });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /provenance conflicts/);
  });
  check('release gate rejects reports from different commits', () => {
    const reports = profile.requiredPlatforms.map(platform => passingReport(profile, platform));
    reports[2].commit = 'othercommit';
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[2].failures.join('\n'), /commit differs/);
  });
  check('release gate rejects reports from a non-target branch', () => {
    const reports = profile.requiredPlatforms.map(platform => ({ ...passingReport(profile, platform), branch: 'codex/not-release' }));
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /target release branch/);
  });
  check('release gate rejects duplicated runner provenance', () => {
    const reports = profile.requiredPlatforms.map(platform => ({ ...passingReport(profile, platform), runnerId: 'copied-runner' }));
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /runnerId duplicated/);
  });
  check('release gate rejects PASS cases without readable evidence', () => {
    const reports = profile.requiredPlatforms.map(platform => passingReport(profile, platform));
    reports[0].testCases[0].evidenceRefs = [];
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /no readable evidence/);
  });
  check('TC-044 is required only in a Linux platform report', () => {
    assert(!requiredP0CasesForPlatform(profile, 'darwin').includes('TC-044'));
    assert(requiredP0CasesForPlatform(profile, 'linux').includes('TC-044'));
  });
  check('release gate rejects a report for another provider', () => {
    const report = passingReport(profile, 'darwin');
    report.providerId = 'other-provider';
    const summary = evaluateReleaseGate({ providerId: 'deepseek', reports: [report], requiredPlatforms: ['darwin'] });
    assert.strictEqual(summary.passed, false);
    assert.match(summary.platforms[0].failures.join('\n'), /provider mismatch/);
  });

  console.log('\n-- certification runner --');
  await check('dry-run writes report without claiming certification PASS', async () => {
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cert-report-'));
    const report = await runCertification({ argv: ['--provider', 'deepseek', '--dry-run'], reportRoot });
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.planReady, true);
    assert.strictEqual(report.providerId, 'deepseek');
    if (process.platform !== 'linux') assert.strictEqual(report.testCases.some(tc => tc.id === 'TC-044'), false);
    assert(fs.existsSync(report.reportJsonPath));
    fs.rmSync(reportRoot, { recursive: true, force: true });
  });
  await check('unknown provider writes failed preflight report', async () => {
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cert-report-'));
    const report = await runCertification({ argv: ['--provider', '__not_exist__'], reportRoot });
    assert.strictEqual(report.passed, false);
    assert.match(report.failures[0].message, /unknown provider/);
    fs.rmSync(reportRoot, { recursive: true, force: true });
  });
  await check('registered provider without a v1.5 profile reports uncertified preflight failure', async () => {
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cert-report-'));
    const report = await runCertification({
      argv: ['--provider', 'future-provider'],
      registeredProviderIds: ['future-provider'],
      reportRoot,
    });
    assert.strictEqual(report.passed, false);
    assert.match(report.failures[0].message, /provider is not certified in v1\.5\.0/);
    fs.rmSync(reportRoot, { recursive: true, force: true });
  });
  await check('stage zero fixture failure blocks true-key stages', async () => {
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cert-report-'));
    process.env.CERTIFY_FIXTURE_FAIL = 'TC-001';
    try {
      const report = await runCertification({ argv: ['--provider', 'deepseek', '--fixture'], reportRoot });
      assert.strictEqual(report.testCases.find(tc => tc.id === 'TC-001').status, STATUSES.FAIL);
      assert.strictEqual(report.testCases.find(tc => tc.id === 'TC-010').status, STATUSES.BLOCKED);
      assert.strictEqual(report.passed, false);
    } finally {
      delete process.env.CERTIFY_FIXTURE_FAIL;
      fs.rmSync(reportRoot, { recursive: true, force: true });
    }
  });
  check('CLI without --provider exits non-zero with provider hint', () => {
    const result = spawnSync(process.execPath, ['scripts/certify-provider.js'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /--provider/);
  });

  console.log('\n-- capture runner --');
  check('sequence parser maps flash/off to DeepSeek config', () => {
    const steps = parseSequence('codex:flash:off:- -> claude:pro:on:high');
    assert.strictEqual(steps[0].model, 'deepseek-v4-flash');
    assert.strictEqual(steps[0].thinking, 'disabled');
    assert.strictEqual(steps[1].effort, 'high');
  });
  check('true-key target parser keeps explicit client cases', () => {
    assert.deepStrictEqual(trueTargets('claude-command,codex-long'), ['claude-command', 'codex-long']);
  });
  check('true-key health evidence checks model, thinking and effective effort', () => {
    const ctx = { model: 'deepseek-v4-pro', thinking: 'enabled', effort: 'max' };
    assert.strictEqual(healthMatches(ctx, { model: 'deepseek-v4-pro', thinking: 'enabled', effort: 'max' }), true);
    assert.strictEqual(healthMatches(ctx, { model: 'deepseek-v4-pro', thinking: 'enabled', effort: 'high' }), false);
    assert.strictEqual(healthMatches({ ...ctx, thinking: 'disabled' }, { model: 'deepseek-v4-pro', thinking: 'disabled', effort: null }), true);
  });
  check('true-key log assertions require model, thinking and effort fields', () => {
    const ctx = { model: 'deepseek-v4-pro', thinking: 'enabled', effort: 'max' };
    assert.strictEqual(gatewayFieldsMatch(ctx, 'POST /v1/messages | model=x->deepseek-v4-pro | thinking=enabled | effort=max', 'claude'), true);
    assert.strictEqual(gatewayFieldsMatch(ctx, 'POST /v1/messages | model=x->deepseek-v4-flash | thinking=enabled | effort=max', 'claude'), false);
    assert.strictEqual(gatewayFieldsMatch(ctx, 'RESPONSES stream=stream model=deepseek-v4-pro thinking=enabled effort=max', 'codex'), true);
  });
  check('Claude runner uses a root-safe permission mode', () => {
    const args = claudeArgs({ tmpRoot: fixtureRoot }, 'deepseek-v4-pro', 'Reply exactly: TEXT_OK', true);
    const mode = args[args.indexOf('--permission-mode') + 1];
    assert(['acceptEdits', 'bypassPermissions'].includes(mode));
    if (process.getuid?.() === 0) assert.strictEqual(mode, 'acceptEdits');
    assert(args.includes('--tools=Bash'));
  });
  await check('capture matrix verifies all PRD model, thinking and effort variants', async () => {
    const result = await runCaptureMatrix({ providerId: 'deepseek', sequence: 'claude:pro:on:high -> claude:pro:on:max -> claude:flash:off:- -> codex:pro:on:max -> codex:flash:off:- -> codex:pro:on:high' });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.steps.length, 6);
    assert(result.positiveAssertions >= 18);
    assert(result.steps.every(step => step.switchedConfigRoot === true));
  });
  check('long task round gate is bounded to ten tool rounds', () => {
    assert.strictEqual(LONG_TASK_MIN_TOOL_ROUNDS, 3);
    assert.strictEqual(LONG_TASK_MAX_TOOL_ROUNDS, 10);
  });
  check('long task static checks require executable reads, not comment markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-static-check-'));
    fs.writeFileSync(path.join(dir, 'test.js'), "const assert = require('assert');\n// read todo.js todo.json\nassert(true);\n");
    assert.deepStrictEqual(staticCheckLongTask(dir), { usesAssert: true, readsTodoJs: false, readsTodoJson: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  check('long task static checks accept an executed read through a declared path variable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-static-check-'));
    fs.writeFileSync(path.join(dir, 'test.js'), [
      "const assert = require('assert');",
      "const fs = require('fs');",
      "const cp = require('child_process');",
      "const dataPath = require('path').join(__dirname, 'todo.json');",
      "cp.execFileSync(process.execPath, ['todo.js', 'list']);",
      "assert(fs.readFileSync(dataPath, 'utf8').length >= 0);",
    ].join('\n'));
    assert.deepStrictEqual(staticCheckLongTask(dir), { usesAssert: true, readsTodoJs: true, readsTodoJson: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  check('long task static checks accept todo.json read through exported TODO_FILE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-static-check-'));
    fs.writeFileSync(path.join(dir, 'todo.js'), [
      "const path = require('path');",
      "const TODO_FILE = path.join(__dirname, 'todo.json');",
      "module.exports = { TODO_FILE };",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'test.js'), [
      "const assert = require('assert');",
      "const fs = require('fs');",
      "const todo = require('./todo.js');",
      "assert(fs.readFileSync('todo.js', 'utf8').length > 0);",
      "assert(fs.readFileSync(todo.TODO_FILE, 'utf8').length >= 0);",
    ].join('\n'));
    assert.deepStrictEqual(staticCheckLongTask(dir), { usesAssert: true, readsTodoJs: true, readsTodoJson: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await check('long task blackbox retest accepts common open and done markers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-blackbox-check-'));
    fs.writeFileSync(path.join(dir, 'todo.js'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const file = 'todo.json';",
      "const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];",
      'const [cmd, arg] = process.argv.slice(2);',
      "if (cmd === 'add') items.push({ text: arg, done: false });",
      "if (cmd === 'done') items[Number(arg) - 1].done = true;",
      "fs.writeFileSync(file, JSON.stringify(items));",
      "if (cmd === 'list') items.forEach((item, i) => console.log(`[${i + 1}] ${item.done ? '[done]' : '○'} ${item.text}`));",
    ].join('\n'));
    const result = await blackboxRetest(dir);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /ALL TESTS PASS/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  check('workspace snapshots retain auditable source content and hashes before cleanup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-workspace-snapshot-'));
    fs.writeFileSync(path.join(dir, 'todo.js'), 'console.log("ok");\n');
    const snapshot = snapshotWorkspace(dir);
    assert.strictEqual(snapshot[0].file, 'todo.js');
    assert.match(snapshot[0].text, /console\.log/);
    assert.match(snapshot[0].sha256, /^[a-f0-9]{64}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await check('runner timeout terminates a hanging CLI with a deterministic status', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
    assert.strictEqual(result.status, 124);
    assert.strictEqual(result.timedOut, true);
    assert.match(result.stderr, /TIMEOUT/);
  });

  console.log('\n-- true-key and linux runners --');
  await check('true-key runner blocks honestly when DeepSeek key is missing', async () => {
    const result = await runTrueKeyClient({ providerId: 'deepseek', apiKey: '', targets: 'claude-text' });
    assert.strictEqual(result.status, STATUSES.BLOCKED);
    assert.match(result.message, /DEEPSEEK_API_KEY/);
    assert.doesNotMatch(result.message, /CLIENT_E2E_REAL_CLI/);
  });
  await check('Linux Hermes runner rejects remote attachment to a non-Linux report', async () => {
    const result = await runLinuxHermesSmoke({ platform: 'darwin', env: { DEEPSEEK_API_KEY: 'sk-test-not-real' } });
    assert.strictEqual(result.status, STATUSES.BLOCKED);
    assert.match(result.message, /Linux server itself/);
  });
  check('Linux Hermes local script uses transient config/systemd and HERMES_OK smoke', () => {
    const script = buildLinuxScript({
      CERTIFY_LINUX_REPO: '/srv/deepseek-claude-setup',
      DEEPSEEK_API_KEY: 'sk-test-key-not-real',
    });
    assert.match(script, /mktemp -d/);
    assert.match(script, /systemd-run/);
    assert.match(script, /trap cleanup EXIT/);
    assert.match(script, /\/__health/);
    assert.match(script, /status "\$UNIT" --no-pager --lines=40/);
    assert.match(script, /test -s "\$DEEPSEEK_CLAUDE_LOG_PATH"/);
    assert.match(script, /gatewayLogCompleted/);
    assert.match(script, /HERMES_OK/);
    assert.match(script, /config-store/);
    assert.match(script, /secret fragment in gateway log/);
    assert.doesNotMatch(script, /sk-test-key-not-real/);
  });
}

run().finally(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  console.log(`\nCertification tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
