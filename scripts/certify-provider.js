#!/usr/bin/env node
/**
 * Provider 认证主入口
 *
 * 负责：
 * - 解析 provider 参数并执行 PRD-015 分阶段门禁
 * - 调用 smoke、capture、Hermes 和 release gate 相关检查
 * - 生成可信 JSON / Markdown 报告，缺真实证据时明确 BLOCKED
 *
 * @module scripts/certify-provider
 */

const fs = require('fs');
const path = require('path');
const { getProviderProfile, listProviderIds, requiredP0CasesForPlatform, STATUSES } = require('./certification/provider-profiles');
const { collectPlatformContext } = require('./certification/platform-context');
const { aggregateResults, createRunDir, makeCaseResult, redactText, scanForSecrets, writeReport } = require('./certification/report-writer');
const { evaluateReleaseGate } = require('./certification/release-gate');
const { runCommand } = require('./certification/runner-utils');
const { runLinuxHermesSmoke } = require('./certification/linux-hermes-smoke');
const { runSmoke } = require('./provider-smoke');
const { runCaptureMatrix, runTrueKeyClient } = require('./client-e2e');

function parseArgs(argv) {
  const args = { provider: null, dryRun: false, fixture: false, target: null, reportRoot: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') args.provider = argv[++i];
    else if (arg.startsWith('--provider=')) args.provider = arg.split('=')[1];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--fixture') args.fixture = true;
    else if (arg === '--target') args.target = argv[++i];
    else if (arg.startsWith('--target=')) args.target = arg.split('=')[1];
    else if (arg === '--report-root') args.reportRoot = argv[++i];
    else if (arg.startsWith('--report-root=')) args.reportRoot = arg.split('=')[1];
  }
  return args;
}

function resultFor(profile, id, patch) {
  const meta = profile.testCases.find(tc => tc.id === id);
  if (!meta) throw new Error(`unknown test case ${id}`);
  return makeCaseResult(meta, patch);
}

function blockRemaining(profile, existing, fromStage, message, platform = process.platform) {
  const seen = new Set(existing.map(tc => tc.id));
  const otherPlatformOnlyCases = new Set(Object.entries(profile.platformOnlyCases || {})
    .filter(([requiredPlatform]) => requiredPlatform !== platform)
    .flatMap(([, ids]) => ids));
  for (const testCase of profile.testCases) {
    if (seen.has(testCase.id)) continue;
    if (otherPlatformOnlyCases.has(testCase.id)) continue;
    if (testCase.stage >= fromStage) {
      existing.push(makeCaseResult(testCase, {
        status: STATUSES.BLOCKED,
        failureClass: testCase.defaultFailureClass,
        message,
        positiveAssertions: 1,
      }));
    } else {
      existing.push(makeCaseResult(testCase, {
        status: STATUSES.SKIPPED,
        failureClass: testCase.defaultFailureClass,
        message: 'not selected in this run',
        positiveAssertions: 1,
      }));
    }
  }
}

async function runBaselineTests() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runCommand(command, ['test'], { timeoutMs: 300000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function writeEvidence(execution, name, content) {
  fs.mkdirSync(execution.evidenceDir, { recursive: true });
  const file = path.join(execution.evidenceDir, name);
  fs.writeFileSync(file, redactText(String(content), [execution.apiKey]));
  return file;
}

async function runClientEvidence(execution, options) {
  const result = await runTrueKeyClient({ ...options, evidenceDir: execution.evidenceDir });
  execution.clientResults.push(result);
  return result;
}

function appendDryRunCases(profile, testCases) {
  testCases.push(resultFor(profile, 'TC-005', { status: STATUSES.PASS, message: 'profile resolved in dry-run', positiveAssertions: profile.stages.length }));
  testCases.push(resultFor(profile, 'TC-006', { status: STATUSES.PASS, message: 'platform context collected', positiveAssertions: 12 }));
  blockRemaining(profile, testCases, 0, 'dry-run plan only');
}

function latestJsonReport(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).map(name => path.join(root, name)).filter(file => fs.statSync(file).isDirectory()).sort();
  const reportPath = dirs.length ? path.join(dirs[dirs.length - 1], 'report.json') : null;
  return reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
}

async function runStageZeroFixtures(execution) {
  const fixtureRoot = path.join(execution.evidenceDir, 'preflight-fixtures');
  const missingProvider = await runCommand(process.execPath, ['scripts/certify-provider.js'], { timeoutMs: 30000 });
  const unknownRoot = path.join(fixtureRoot, 'unknown');
  const unknown = await runCommand(process.execPath, ['scripts/certify-provider.js', '--provider', '__not_exist__', '--report-root', unknownRoot], { timeoutMs: 30000 });
  const stoppedRoot = path.join(fixtureRoot, 'stopped');
  const stopped = await runCommand(process.execPath, ['scripts/certify-provider.js', '--provider', 'deepseek', '--fixture', '--report-root', stoppedRoot], {
    env: { CERTIFY_FIXTURE_FAIL: 'TC-001' },
    timeoutMs: 30000,
  });
  const unknownReport = latestJsonReport(unknownRoot);
  const stoppedReport = latestJsonReport(stoppedRoot);
  const output = writeEvidence(execution, 'preflight-fixtures.log', [
    missingProvider.stderr,
    unknown.stdout,
    stopped.stdout,
  ].join('\n'));
  return {
    evidenceRefs: [output],
    tc003: missingProvider.status !== 0 && /--provider/.test(missingProvider.stderr),
    tc004: unknown.status !== 0 && unknownReport?.passed === false && unknownReport?.failures?.[0]?.failureClass === 'preflight',
    tc007: stopped.status !== 0
      && stoppedReport?.testCases?.find(tc => tc.id === 'TC-001')?.status === STATUSES.FAIL
      && stoppedReport?.testCases?.find(tc => tc.id === 'TC-010')?.status === STATUSES.BLOCKED,
  };
}

async function appendStageZeroCases(profile, testCases, execution, context) {
  const baseline = await runBaselineTests();
  execution.baseline = baseline;
  const baselineEvidence = writeEvidence(execution, 'baseline-tests.log', `${baseline.stdout}\n${baseline.stderr}`);
  const scriptsOk = checkPackageScripts();
  const scriptEvidence = writeEvidence(execution, 'package-scripts.json', JSON.stringify({ scriptsOk }, null, 2));
  const requiredContext = ['repoPath', 'branch', 'commit', 'isDirty', 'platform', 'runnerId', 'runCommand'];
  const contextOk = requiredContext.every(field => context[field] !== undefined && context[field] !== null)
    && context.branch === profile.releaseBranch;
  const contextEvidence = writeEvidence(execution, 'platform-context.json', JSON.stringify(context, null, 2));
  const fixtures = await runStageZeroFixtures(execution);
  testCases.push(resultFor(profile, 'TC-001', {
    status: baseline.ok ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: baseline.ok ? null : 'gateway',
    message: baseline.ok ? 'baseline tests passed' : `baseline tests failed with status ${baseline.status}`,
    positiveAssertions: baseline.ok ? 1 : 0,
    evidenceRefs: [baselineEvidence],
  }));
  testCases.push(resultFor(profile, 'TC-002', {
    status: scriptsOk ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: 'preflight',
    message: scriptsOk ? 'npm scripts are registered' : 'missing certification npm scripts',
    positiveAssertions: scriptsOk ? 5 : 0,
    evidenceRefs: [scriptEvidence],
  }));
  for (const [id, passed, message, assertions, refs] of [
    ['TC-003', fixtures.tc003, 'CLI rejects missing provider before run', 1, fixtures.evidenceRefs],
    ['TC-004', fixtures.tc004, 'Unknown provider writes a failed preflight report', 1, fixtures.evidenceRefs],
    ['TC-005', Boolean(profile.id && profile.stages.length === 5), `${profile.displayName} profile resolved`, profile.stages.length, [contextEvidence]],
    ['TC-006', contextOk, 'Platform context matches the target release branch', requiredContext.length + 1, [contextEvidence]],
    ['TC-007', fixtures.tc007, 'Stage zero fixture failure blocks true-key execution', 2, fixtures.evidenceRefs],
  ]) {
    testCases.push(resultFor(profile, id, {
      status: passed ? STATUSES.PASS : STATUSES.FAIL,
      failureClass: passed ? null : profile.testCases.find(tc => tc.id === id)?.defaultFailureClass,
      message,
      positiveAssertions: passed ? assertions : 0,
      evidenceRefs: refs,
    }));
  }
  const skippedCheck = aggregateResults(profile, [resultFor(profile, 'TC-008', { status: STATUSES.SKIPPED, positiveAssertions: 1 })]);
  const skippedEvidence = writeEvidence(execution, 'skipped-self-check.json', JSON.stringify(skippedCheck, null, 2));
  testCases.push(resultFor(profile, 'TC-008', {
    status: skippedCheck.passed ? STATUSES.FAIL : STATUSES.PASS,
    failureClass: 'cleanup',
    message: 'SKIPPED is rejected by aggregator',
    positiveAssertions: 1,
    evidenceRefs: [skippedEvidence],
  }));
}

function appendMissingKeyBlocks(profile, testCases, platform = process.platform) {
  const otherPlatformOnlyCases = new Set(Object.entries(profile.platformOnlyCases || {})
    .filter(([requiredPlatform]) => requiredPlatform !== platform)
    .flatMap(([, ids]) => ids));
  for (const tc of profile.testCases.filter(tc => tc.stage >= 1 && !testCases.some(x => x.id === tc.id))) {
    if (otherPlatformOnlyCases.has(tc.id)) continue;
    testCases.push(makeCaseResult(tc, {
      status: STATUSES.BLOCKED,
      failureClass: tc.defaultFailureClass,
      message: `${profile.apiKeyEnv} missing before true-key stage`,
      positiveAssertions: 1,
    }));
  }
}

function stageP0Passed(testCases, stage) {
  return !testCases.some(tc => tc.stage === stage && tc.priority === 'P0' && tc.status !== STATUSES.PASS);
}

function findClientCase(clientResult, name) {
  return (clientResult.cases || []).find(item => item.name === name);
}

function appendClientCase(profile, testCases, id, clientResult, caseName, message) {
  const clientCase = findClientCase(clientResult, caseName);
  const blocked = clientResult.status === STATUSES.BLOCKED;
  const status = clientCase?.status || (blocked ? STATUSES.BLOCKED : STATUSES.FAIL);
  testCases.push(resultFor(profile, id, {
    status,
    failureClass: status === STATUSES.PASS ? null : (clientCase?.failureClass || clientResult.failureClass || 'client'),
    message: clientCase
      ? `${message}; ${caseName} ${clientCase.status}`
      : `${message}; ${clientResult.message || `${caseName} did not run`}`,
    positiveAssertions: clientCase?.positiveAssertions || clientResult.positiveAssertions || 1,
    evidenceRefs: [clientResult.report?.jsonPath, clientResult.report?.mdPath].filter(Boolean),
    details: clientCase ? {
      model: clientCase.model,
      durationMs: clientCase.durationMs,
      workspaceFiles: clientCase.workspaceFiles,
    } : undefined,
  }));
}

function appendRunnerResult(profile, testCases, id, runnerResult, message) {
  testCases.push(resultFor(profile, id, {
    status: runnerResult.status || (runnerResult.passed ? STATUSES.PASS : STATUSES.FAIL),
    failureClass: runnerResult.passed ? null : (runnerResult.failureClass || 'client'),
    message: runnerResult.message || message,
    positiveAssertions: runnerResult.positiveAssertions || 1,
    evidenceRefs: runnerResult.report ? [runnerResult.report.jsonPath, runnerResult.report.mdPath].filter(Boolean) : [],
  }));
}

async function missingKeyScenario(profile, apiKey, execution) {
  if (!apiKey) {
    const evidence = writeEvidence(execution, 'missing-key-scenario.json', JSON.stringify({
      keyPresent: false,
      expectedStatus: STATUSES.BLOCKED,
    }, null, 2));
    return { passed: true, evidenceRefs: [evidence], message: `${profile.apiKeyEnv} is absent; true-key cases are BLOCKED` };
  }
  const reportRoot = path.join(execution.evidenceDir, 'no-key-scenario');
  const command = await runCommand(process.execPath, ['scripts/certify-provider.js', '--provider', profile.id, '--report-root', reportRoot], {
    env: { [profile.apiKeyEnv]: '', CERTIFY_NO_KEY_SCENARIO: '1' },
    timeoutMs: 360000,
  });
  const report = latestJsonReport(reportRoot);
  const passed = command.status !== 0
    && report?.testCases?.find(tc => tc.id === 'TC-009')?.status === STATUSES.PASS
    && report?.testCases?.find(tc => tc.id === 'TC-010')?.status === STATUSES.BLOCKED;
  return {
    passed,
    evidenceRefs: report?.reportJsonPath ? [report.reportJsonPath] : report ? [path.join(reportRoot, report.runId, 'report.json')] : [],
    message: passed ? 'no-key subprocess proved true-key cases are BLOCKED' : 'no-key subprocess did not prove BLOCKED behavior',
  };
}

async function appendStageOneCases(profile, testCases, apiKey, execution) {
  const missingKey = await missingKeyScenario(profile, apiKey, execution);
  testCases.push(resultFor(profile, 'TC-009', {
    status: missingKey.passed ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: missingKey.passed ? null : 'provider',
    message: missingKey.message,
    positiveAssertions: missingKey.passed ? 2 : 0,
    evidenceRefs: missingKey.evidenceRefs,
  }));
  if (!apiKey) return false;

  const smoke = await runSmoke({ providerId: profile.id, apiKey });
  const smokeEvidence = writeEvidence(execution, 'provider-smoke.json', JSON.stringify(smoke, null, 2));
  for (const [id, assertions] of [['TC-010', 3], ['TC-011', 2], ['TC-012', 2], ['TC-013', 1]]) {
    testCases.push(resultFor(profile, id, {
      status: smoke.passed ? STATUSES.PASS : STATUSES.FAIL,
      failureClass: smoke.passed ? null : smoke.failureClass,
      message: smoke.message || 'provider smoke result',
      positiveAssertions: smoke.passed ? assertions : 0,
      evidenceRefs: [smokeEvidence],
    }));
  }
  const client = await runClientEvidence(execution, {
    providerId: profile.id,
    apiKey,
    targets: 'claude-text,claude-tool,codex-tool',
    model: profile.defaultModel,
    thinking: 'enabled',
    effort: 'max',
  });
  appendClientCase(profile, testCases, 'TC-014', client, 'claude-text', 'Claude Code short text true-key runner');
  appendClientCase(profile, testCases, 'TC-015', client, 'claude-tool', 'Claude Code Bash tool true-key runner');
  appendClientCase(profile, testCases, 'TC-019', client, 'codex-tool', 'Codex tool true-key runner');
  return stageP0Passed(testCases, 1);
}

function captureCase(profile, testCases, id, passed, message, assertions, evidenceRef) {
  testCases.push(resultFor(profile, id, {
    status: passed ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: passed ? null : 'gateway',
    message,
    positiveAssertions: assertions,
    evidenceRefs: evidenceRef ? [evidenceRef] : [],
  }));
}

function appendCaptureCases(profile, testCases, capture, evidenceRef) {
  const byStep = Object.fromEntries(capture.steps.map(step => [step.step, step]));
  const steps = Object.fromEntries(capture.steps.map(step => [step.step, step.requests[0]?.body || {}]));
  const ch = steps['claude:pro:on:high'];
  const cm = steps['claude:pro:on:max'];
  const cf = steps['claude:flash:off:-'];
  const dx = steps['codex:pro:on:max'];
  const df = steps['codex:flash:off:-'];
  const dh = steps['codex:pro:on:high'];
  captureCase(profile, testCases, 'TC-024', ch?.model === profile.defaultModel && dx?.model === profile.defaultModel, 'Pro capture model fields match', 2, evidenceRef);
  captureCase(
    profile,
    testCases,
    'TC-025',
    byStep['claude:flash:off:-']?.switchedConfigRoot === true
      && byStep['codex:flash:off:-']?.switchedConfigRoot === true
      && cf?.model === profile.flashModel
      && df?.model === profile.flashModel,
    'First Flash requests after in-run gateway restart contain no Pro model',
    4,
    evidenceRef,
  );
  captureCase(profile, testCases, 'TC-026', ch?.thinking?.type === 'enabled' && cm?.thinking?.type === 'enabled', 'Anthropic thinking enabled fields match', 2, evidenceRef);
  captureCase(profile, testCases, 'TC-027', ch?.output_config?.effort === 'high' && cm?.output_config?.effort === 'max', 'Anthropic high/max efforts match', 2, evidenceRef);
  captureCase(profile, testCases, 'TC-028', cf?.thinking?.type === 'disabled' && cf?.output_config === undefined, 'Anthropic thinking off removes output_config', 2, evidenceRef);
  captureCase(profile, testCases, 'TC-029', dx?.reasoning_effort === 'max' && dh?.reasoning_effort === 'high', 'Responses thinking on reasoning efforts match', 2, evidenceRef);
  captureCase(profile, testCases, 'TC-030', df?.thinking?.type === 'disabled' && df?.reasoning_effort === undefined, 'Responses thinking off removes effort', 2, evidenceRef);
  captureCase(profile, testCases, 'TC-031', dx?.model === dh?.model && dx?.thinking?.type === dh?.thinking?.type && dx?.reasoning_effort !== dh?.reasoning_effort, 'Only Responses effort changes from max to high', 3, evidenceRef);
}

function baselineHas(execution, pattern) {
  return execution.baseline?.ok && pattern.test(execution.baseline.stdout || '');
}

async function appendStageTwoCases(profile, testCases, apiKey, execution) {
  const capture = await runCaptureMatrix({ providerId: profile.id, sequence: 'claude:pro:on:high -> claude:pro:on:max -> claude:flash:off:- -> codex:pro:on:max -> codex:flash:off:- -> codex:pro:on:high' });
  const captureEvidence = writeEvidence(execution, 'capture-matrix.json', JSON.stringify(capture, null, 2));
  appendCaptureCases(profile, testCases, capture, captureEvidence);
  const claudeCommand = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'claude-command', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  const claudeFlash = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'claude-text', model: profile.flashModel, thinking: 'disabled', effort: 'max' });
  const claudeProMax = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'claude-text', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  const claudeProHigh = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'claude-text', model: profile.defaultModel, thinking: 'enabled', effort: 'high' });
  const codexCommand = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'codex-command', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  const codexFlash = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'codex-tool', model: profile.flashModel, thinking: 'disabled', effort: 'max' });
  const codexProMax = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'codex-tool', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  const codexProHigh = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'codex-tool', model: profile.defaultModel, thinking: 'enabled', effort: 'high' });
  appendClientCase(profile, testCases, 'TC-016', claudeCommand, 'claude-command', 'Claude Code command task true-key runner');
  appendClientCase(profile, testCases, 'TC-017', claudeFlash, 'claude-text', 'Claude Code flash + thinking off true-key runner');
  appendClientCase(profile, testCases, 'TC-018', claudeProMax, 'claude-text', 'Claude Code pro + max thinking true-key runner');
  appendClientCase(profile, testCases, 'TC-020', codexCommand, 'codex-command', 'Codex command task true-key runner');
  appendClientCase(profile, testCases, 'TC-021', codexFlash, 'codex-tool', 'Codex flash + thinking off true-key runner');
  appendClientCase(profile, testCases, 'TC-022', codexProMax, 'codex-tool', 'Codex pro + max thinking true-key runner');
  appendClientCase(profile, testCases, 'TC-051', claudeProHigh, 'claude-text', 'Claude Code pro + high thinking true-key runner');
  appendClientCase(profile, testCases, 'TC-052', codexProHigh, 'codex-tool', 'Codex pro + high thinking true-key runner');
  const codexLogsOk = [codexCommand, codexFlash, codexProMax, codexProHigh]
    .every(result => result.status === STATUSES.PASS && !(result.cases || []).some(item => /RESPONSES_FAILED/.test(item.logSummary || '')));
  testCases.push(resultFor(profile, 'TC-023', {
    status: codexLogsOk ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: codexLogsOk ? null : 'gateway',
    message: codexLogsOk ? 'Codex Responses logs do not contain RESPONSES_FAILED' : 'Codex Responses failure marker found or Codex case failed',
    positiveAssertions: 4,
    evidenceRefs: [codexCommand, codexFlash, codexProMax, codexProHigh].flatMap(result => [result.report?.jsonPath, result.report?.mdPath]).filter(Boolean),
  }));
  const baselineChecks = [
    ['TC-032', /tool args emit one delta per upstream chunk/, 'Codex tool delta baseline assertion'],
    ['TC-033', /function_call_output translated to role=tool/, 'function_call_output translation assertion'],
    ['TC-034', /parallel function_calls collapsed into one assistant message/, 'parallel tool-call merge assertion'],
    ['TC-035', /reasoning still attached to assistant tool_calls message/, 'reasoning_content preservation assertion'],
    ['TC-036', /falls back from max to high on tool-heavy 5xx/, 'Chat max-to-high fallback assertion'],
  ];
  for (const [id, pattern, message] of baselineChecks) {
    const passed = baselineHas(execution, pattern);
    testCases.push(resultFor(profile, id, { status: passed ? STATUSES.PASS : STATUSES.FAIL, failureClass: passed ? null : 'gateway', message, positiveAssertions: passed ? 1 : 0, evidenceRefs: [path.join(execution.evidenceDir, 'baseline-tests.log')] }));
  }
  return stageP0Passed(testCases, 2);
}

async function appendStageThreeCases(profile, testCases, apiKey, execution) {
  const codexLong = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'codex-long', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  const claudeLong = await runClientEvidence(execution, { providerId: profile.id, apiKey, targets: 'claude-long', model: profile.defaultModel, thinking: 'enabled', effort: 'max' });
  appendClientCase(profile, testCases, 'TC-037', codexLong, 'codex-long', 'Codex long task true-key runner');
  appendClientCase(profile, testCases, 'TC-038', claudeLong, 'claude-long', 'Claude Code long task true-key runner');
  return { passed: stageP0Passed(testCases, 3), codexLong, claudeLong };
}

function longBlackboxPassed(...clientResults) {
  return clientResults.every(result => {
    const item = (result.cases || [])[0];
    return item?.status === STATUSES.PASS
      && item.blackboxRetest?.status === 0
      && /ALL TESTS PASS/.test(item.blackboxRetest?.stdout || '')
      && Object.values(item.staticChecks || {}).every(Boolean);
  });
}

function appendArtifactResult(profile, testCases, id, passed, message, evidenceRefs, assertions = 1) {
  testCases.push(resultFor(profile, id, {
    status: passed ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: passed ? null : profile.testCases.find(tc => tc.id === id)?.defaultFailureClass,
    message,
    positiveAssertions: passed ? assertions : 0,
    evidenceRefs,
  }));
}

function appendExecutionFailure(profile, testCases, execution, err) {
  const remaining = requiredP0CasesForPlatform(profile, execution.context.platform)
    .map(id => profile.testCases.find(tc => tc.id === id))
    .find(tc => !testCases.some(result => result.id === tc.id));
  const evidence = writeEvidence(execution, 'execution-error.log', err.stack || err.message);
  if (remaining) {
    testCases.push(makeCaseResult(remaining, {
      status: STATUSES.FAIL,
      failureClass: remaining.defaultFailureClass || 'cleanup',
      message: `certification runner threw: ${err.message}`,
      positiveAssertions: 0,
      evidenceRefs: [evidence],
    }));
  }
  blockRemaining(profile, testCases, 0, `blocked after runner exception: ${err.message}`, execution.context.platform);
  return evidence;
}

function appendHermesArtifactCases(profile, testCases, execution) {
  const evidence = [path.join(execution.evidenceDir, 'baseline-tests.log')];
  for (const [id, pattern, message] of [
    ['TC-039', /writes Hermes to local OpenAI Chat Completions proxy/, 'Hermes config local gateway assertion'],
    ['TC-040', /does not write the real DeepSeek key into Hermes config.yaml/, 'Hermes local token assertion'],
    ['TC-041', /overrides model and injects DeepSeek thinking fields/, 'Hermes Chat gateway field assertion'],
    ['TC-042', /systemd unit uses system target for root\/server scope/, 'Linux systemd unit assertion'],
    ['TC-043', /unsupported Linux environment returns explicit status/, 'Linux unsupported status assertion'],
  ]) {
    const passed = baselineHas(execution, pattern);
    appendArtifactResult(profile, testCases, id, passed, message, evidence);
  }
}

function appendIsolationCases(profile, testCases, execution) {
  const results = execution.clientResults;
  const evidenceRefs = results.flatMap(result => [result.report?.jsonPath, result.report?.mdPath]).filter(Boolean);
  const snapshotsOk = results.length > 0 && results.every(result => Array.isArray(result.configChanges) && result.configChanges.length === 0);
  appendArtifactResult(profile, testCases, 'TC-045', snapshotsOk, snapshotsOk ? 'All true-key runs preserved monitored user configuration hashes' : 'Missing or changed true-key configuration snapshots', evidenceRefs, results.length);

  const secretHits = [
    ...results.flatMap(result => result.secretScan || []),
    ...scanForSecrets(execution.evidenceDir, [execution.apiKey]).map(hit => hit.file),
  ];
  appendArtifactResult(profile, testCases, 'TC-046', results.length > 0 && secretHits.length === 0, secretHits.length ? `Secret scan found ${secretHits.length} evidence hits` : 'All client evidence and gateway log summaries passed key scan', evidenceRefs, results.length);

  const cleanupOk = results.length > 0 && results.every(result => result.cleanup?.tmpRootRemoved === true);
  appendArtifactResult(profile, testCases, 'TC-047', cleanupOk, cleanupOk ? 'All client temporary roots were removed' : 'Client temporary root cleanup evidence missing or failed', evidenceRefs, results.length);
}

async function appendStageFourCases(profile, testCases, args, longResults, execution) {
  appendHermesArtifactCases(profile, testCases, execution);
  appendIsolationCases(profile, testCases, execution);
  if (execution.context.platform === 'linux' && args.target === 'hermes-linux') {
    const linux = await runLinuxHermesSmoke({
      platform: execution.context.platform,
      env: { CERTIFY_LINUX_REPO: process.cwd() },
    });
    const linuxEvidence = writeEvidence(execution, 'linux-hermes-smoke.json', JSON.stringify(linux, null, 2));
    linux.report = { jsonPath: linuxEvidence };
    appendRunnerResult(profile, testCases, 'TC-044', linux, 'Linux Hermes true-key smoke');
  } else if (execution.context.platform === 'linux') {
    testCases.push(resultFor(profile, 'TC-044', {
      status: STATUSES.BLOCKED,
      failureClass: 'preflight',
      message: 'run this command on the Linux server with --target hermes-linux and DEEPSEEK_API_KEY to execute the Hermes smoke',
      positiveAssertions: 1,
    }));
  }
  const blackboxOk = longBlackboxPassed(longResults.codexLong, longResults.claudeLong);
  testCases.push(resultFor(profile, 'TC-056', {
    status: blackboxOk ? STATUSES.PASS : STATUSES.FAIL,
    failureClass: blackboxOk ? null : 'client',
    message: blackboxOk ? 'long-chain blackbox retests executed for Codex and Claude' : 'long-chain blackbox retest missing or failed',
    positiveAssertions: blackboxOk ? 2 : 1,
    evidenceRefs: [longResults.codexLong, longResults.claudeLong].flatMap(result => [result.report?.jsonPath, result.report?.mdPath]).filter(Boolean),
  }));
  return stageP0Passed(testCases, 4);
}

function appendReleaseSelfCheckCases(profile, context, testCases, execution) {
  const fixtureEvidence = writeEvidence(execution, 'release-gate-fixture-evidence.json', JSON.stringify({ purpose: 'release gate anti-fake-green fixture' }, null, 2));
  const releaseSelf = releaseGateSelfCheck(profile, context, fixtureEvidence);
  const zeroAssertion = aggregateResults(profile, [
    resultFor(profile, 'TC-048', { status: STATUSES.PASS, positiveAssertions: 0, evidenceRefs: [fixtureEvidence] }),
  ], { requiredP0Cases: ['TC-048'] });
  const checks = {
    'TC-048': zeroAssertion.testCases[0].status === STATUSES.FAIL && !zeroAssertion.passed,
    'TC-049': !releaseSelf.missingPlatform.passed,
    'TC-050': !releaseSelf.dirtyReport.passed,
    'TC-053': !releaseSelf.missingRequiredCase.passed,
    'TC-054': !releaseSelf.captureOnly.passed && !releaseSelf.blockedCase.passed,
    'TC-055': !releaseSelf.missingProvenance.passed && !releaseSelf.wrongBranch.passed && !releaseSelf.duplicateRunner.passed,
  };
  const selfEvidence = writeEvidence(execution, 'release-gate-self-check.json', JSON.stringify({ checks, releaseSelf, zeroAssertion }, null, 2));
  for (const [id, ok] of [
    ['TC-048', checks['TC-048']],
    ['TC-049', checks['TC-049']],
    ['TC-050', checks['TC-050']],
    ['TC-053', checks['TC-053']],
    ['TC-054', checks['TC-054']],
    ['TC-055', checks['TC-055']],
  ]) {
    if (!testCases.some(tc => tc.id === id)) {
      testCases.push(resultFor(profile, id, {
        status: ok ? STATUSES.PASS : STATUSES.FAIL,
        failureClass: ok ? null : 'cleanup',
        message: ok ? 'release gate self-check rejected its fake-green fixture' : 'release gate self-check failed',
        positiveAssertions: 1,
        evidenceRefs: [selfEvidence],
      }));
    }
  }
}

function checkPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  return Boolean(
    scripts['certify:provider']?.includes('node scripts/certify-provider.js')
    && scripts['certify:release']?.includes('node scripts/certification/release-gate.js')
    && scripts['smoke:provider']?.includes('node scripts/provider-smoke.js')
    && scripts['e2e:clients']?.includes('node scripts/client-e2e.js')
    && scripts['smoke:hermes-linux']?.includes('node scripts/certification/linux-hermes-smoke.js')
  );
}

function releaseGateSelfCheck(profile, context, evidenceRef) {
  function fixtureContext(platform) {
    const specific = platform === 'win32'
      ? { osType: 'Windows_NT', osRelease: '10.0.22631', nodeExecPath: 'C:\\nodejs\\node.exe' }
      : platform === 'linux'
        ? { osType: 'Linux', osRelease: '6.8.0-linux', nodeExecPath: '/usr/bin/node' }
        : { osType: 'Darwin', osRelease: '25.2.0', nodeExecPath: '/usr/local/bin/node' };
    return { ...context, ...specific, platform, runnerId: `fixture-${platform}` };
  }
  function validReport(platform) {
    return {
      ...fixtureContext(platform),
      providerId: profile.id,
      branch: profile.releaseBranch,
      passed: true,
      isDirty: false,
      testCases: requiredP0CasesForPlatform(profile, platform).map(id => resultFor(profile, id, {
        status: STATUSES.PASS,
        positiveAssertions: 1,
        evidenceRefs: [evidenceRef],
      })),
    };
  }
  const base = {
    ...context,
    providerId: profile.id,
    branch: profile.releaseBranch,
    passed: true,
    isDirty: false,
  };
  const reports = profile.requiredPlatforms.map(validReport);
  const missingPlatform = evaluateReleaseGate({ providerId: profile.id, reports: reports.slice(0, 1) });
  const dirtyReport = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => ({ ...report, isDirty: report.platform === 'win32' })),
  });
  const missingRequiredCase = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => report.platform === 'darwin'
      ? { ...report, testCases: report.testCases.filter(tc => tc.id !== 'TC-014') }
      : report),
  });
  const captureOnly = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => ({
      ...report,
      testCases: report.testCases.map(tc => tc.evidenceType === 'true-key' ? { ...tc, evidenceType: 'capture' } : tc),
    })),
  });
  const blockedCase = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => report.platform === 'darwin'
      ? { ...report, testCases: report.testCases.map(tc => tc.id === 'TC-014' ? { ...tc, status: STATUSES.BLOCKED } : tc) }
      : report),
  });
  const missingProvenance = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => {
      const cloned = { ...report };
      if (report.platform === 'linux') delete cloned.runnerId;
      return cloned;
    }),
  });
  const wrongBranch = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => ({ ...report, branch: 'codex/not-release' })),
  });
  const duplicateRunner = evaluateReleaseGate({
    providerId: profile.id,
    reports: reports.map(report => {
      const cloned = { ...report };
      cloned.runnerId = 'fixture-shared-runner';
      return cloned;
    }),
  });
  return {
    missingPlatform,
    dirtyReport,
    missingRequiredCase,
    captureOnly,
    blockedCase,
    missingProvenance,
    wrongBranch,
    duplicateRunner,
  };
}

async function runCertification(options = {}) {
  const startedAt = new Date().toISOString();
  const args = { ...parseArgs(options.argv || []), ...options };
  if (!args.provider) {
    throw new Error('必须指定 --provider <provider-id>');
  }

  const profile = getProviderProfile(args.provider);
  const registeredProviderIds = new Set([
    ...listProviderIds(),
    ...(options.registeredProviderIds || []),
    ...(process.env.CERTIFY_REGISTERED_PROVIDER_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  ]);
  const context = collectPlatformContext({ startedAt, argv: ['scripts/certify-provider.js', ...(options.argv || process.argv.slice(2))] });
  const { runId, runDir } = createRunDir(args.provider, process.platform, args.reportRoot);

  if (!profile) {
    const failureMessage = registeredProviderIds.has(args.provider)
      ? 'provider is not certified in v1.5.0'
      : `unknown provider: ${args.provider}`;
    const report = {
      ...context,
      runId,
      runDir,
      providerId: args.provider,
      knownProviders: listProviderIds(),
      passed: false,
      counts: { PASS: 0, FAIL: 1, BLOCKED: 0, SKIPPED: 0 },
      failures: [{ id: 'provider-profile', status: STATUSES.FAIL, failureClass: 'preflight', message: failureMessage }],
      testCases: [],
      finishedAt: new Date().toISOString(),
    };
    return writeReport(report, [process.env.DEEPSEEK_API_KEY]);
  }

  const testCases = [];
  let stoppedAtStage = null;
  const execution = {
    apiKey: process.env[profile.apiKeyEnv],
    clientResults: [],
    context,
    evidenceDir: path.join(runDir, 'evidence'),
  };
  try {
    if (args.dryRun) {
      appendDryRunCases(profile, testCases);
    } else if (process.env.CERTIFY_FIXTURE_FAIL === 'TC-001') {
      testCases.push(resultFor(profile, 'TC-001', { status: STATUSES.FAIL, failureClass: 'gateway', message: 'fixture forced failure', positiveAssertions: 1 }));
      stoppedAtStage = 0;
      blockRemaining(profile, testCases, 1, 'blocked because stage 0 failed', context.platform);
    } else {
      await appendStageZeroCases(profile, testCases, execution, context);
      if (testCases.some(tc => tc.stage === 0 && tc.priority === 'P0' && tc.status !== STATUSES.PASS)) {
        stoppedAtStage = 0;
        blockRemaining(profile, testCases, 1, 'blocked because stage 0 failed', context.platform);
      } else if (!process.env[profile.apiKeyEnv]) {
        await appendStageOneCases(profile, testCases, null, execution);
        stoppedAtStage = 1;
        appendMissingKeyBlocks(profile, testCases, context.platform);
      } else {
        const stageOnePassed = await appendStageOneCases(profile, testCases, process.env[profile.apiKeyEnv], execution);
        if (!stageOnePassed) {
          stoppedAtStage = 1;
          blockRemaining(profile, testCases, 2, 'blocked because stage 1 failed', context.platform);
        } else {
          const stageTwoPassed = await appendStageTwoCases(profile, testCases, process.env[profile.apiKeyEnv], execution);
          if (!stageTwoPassed) {
            stoppedAtStage = 2;
            blockRemaining(profile, testCases, 3, 'blocked because stage 2 failed', context.platform);
          } else {
            const longResults = await appendStageThreeCases(profile, testCases, process.env[profile.apiKeyEnv], execution);
            if (!longResults.passed) {
              stoppedAtStage = 3;
              blockRemaining(profile, testCases, 4, 'blocked because stage 3 failed', context.platform);
            } else {
              await appendStageFourCases(profile, testCases, args, longResults, execution);
              stoppedAtStage = stageP0Passed(testCases, 4) ? null : 4;
            }
          }
        }
      }
    }
  } catch (err) {
    stoppedAtStage = stoppedAtStage ?? 0;
    appendExecutionFailure(profile, testCases, execution, err);
  }

  appendReleaseSelfCheckCases(profile, context, testCases, execution);

  const aggregate = aggregateResults(profile, testCases, {
    requiredP0Cases: requiredP0CasesForPlatform(profile, context.platform),
  });
  const report = {
    ...context,
    runId,
    runDir,
    providerId: profile.id,
    providerDisplayName: profile.displayName,
    hasTrueKey: Boolean(process.env[profile.apiKeyEnv]),
    dryRun: Boolean(args.dryRun),
    planReady: Boolean(args.dryRun),
    fixture: Boolean(args.fixture),
    stoppedAtStage,
    stages: profile.stages,
    finishedAt: new Date().toISOString(),
    ...aggregate,
  };
  return writeReport(report, [process.env[profile.apiKeyEnv]]);
}

if (require.main === module) {
  runCertification({ argv: process.argv.slice(2) }).then(report => {
    console.log(`report: ${report.reportJsonPath}`);
    if (report.dryRun) console.log(`planReady: ${Boolean(report.planReady)}`);
    console.log(`passed: ${report.passed}`);
    process.exit(report.passed || report.dryRun ? 0 : 1);
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runCertification,
};
