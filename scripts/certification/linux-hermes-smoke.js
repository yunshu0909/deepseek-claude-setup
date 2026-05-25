#!/usr/bin/env node
/**
 * Linux Hermes 真场景认证 runner
 *
 * 负责：
 * - 在 Linux 服务器本机执行 Hermes 接管 smoke
 * - 校验 systemd service active 与 Hermes HERMES_OK prompt
 * - 使用临时配置和临时 systemd unit，避免认证修改真实 Hermes 状态
 *
 * @module scripts/certification/linux-hermes-smoke
 */

const { randomPort, runCommand } = require('./runner-utils');
const { redactText } = require('./report-writer');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildLinuxScript(env) {
  const repo = shQuote(env.CERTIFY_LINUX_REPO || process.cwd());
  const sourceConfig = shQuote(env.CERTIFY_LINUX_HERMES_CONFIG || '/var/lib/hermes/config.yaml');
  return [
    'set -euo pipefail',
    'test "$(uname -s)" = "Linux"',
    `cd ${repo}`,
    'test -n "${DEEPSEEK_API_KEY:-}"',
    'CERT_TMP="$(mktemp -d /tmp/deepseek-provider-certification.XXXXXX)"',
    'UNIT="deepseek-provider-certification-${PPID}.service"',
    'SYSTEMCTL=(systemctl)',
    'SYSTEMD_RUN=(systemd-run)',
    'if [ "$(id -u)" -ne 0 ]; then SYSTEMCTL=(systemctl --user); SYSTEMD_RUN=(systemd-run --user); fi',
    'cleanup() { "${SYSTEMCTL[@]}" stop "$UNIT" >/dev/null 2>&1 || true; rm -rf "$CERT_TMP"; }',
    'trap cleanup EXIT',
    'export DEEPSEEK_CLAUDE_SKIP_UPDATE=1',
    'export DEEPSEEK_CLAUDE_CONFIG_DIR="$CERT_TMP/gateway"',
    'export HERMES_CONFIG_PATH="$CERT_TMP/config.yaml"',
    `cp ${sourceConfig} "$HERMES_CONFIG_PATH"`,
    'export DEEPSEEK_CLAUDE_PROXY_URL="http://127.0.0.1:${CERTIFY_LINUX_PROXY_PORT}"',
    'export DEEPSEEK_CLAUDE_PROXY_PORT="${CERTIFY_LINUX_PROXY_PORT}"',
    'export DEEPSEEK_CLAUDE_LOG_PATH="$CERT_TMP/gateway.log"',
    'mkdir -p "$DEEPSEEK_CLAUDE_CONFIG_DIR"',
    'node -e \'require("./src/config-store").write({apiKey:process.env.DEEPSEEK_API_KEY,model:"deepseek-v4-pro",thinking:"enabled",effort:"max"})\'',
    'cp proxy/proxy.js "$DEEPSEEK_CLAUDE_CONFIG_DIR/proxy.js"',
    'node -e \'require("./src/hermes-patcher").patch({model:"deepseek-v4-pro",thinking:"enabled",effort:"max"})\'',
    '"${SYSTEMD_RUN[@]}" --unit="$UNIT" --collect --property=Restart=no --setenv="DEEPSEEK_CLAUDE_CONFIG_DIR=$DEEPSEEK_CLAUDE_CONFIG_DIR" --setenv="DEEPSEEK_CLAUDE_PROXY_PORT=$DEEPSEEK_CLAUDE_PROXY_PORT" --setenv="DEEPSEEK_CLAUDE_LOG_PATH=$DEEPSEEK_CLAUDE_LOG_PATH" node "$DEEPSEEK_CLAUDE_CONFIG_DIR/proxy.js"',
    '"${SYSTEMCTL[@]}" is-active "$UNIT"',
    'node -e \'const http=require("http"); const url="http://127.0.0.1:"+process.env.CERTIFY_LINUX_PROXY_PORT+"/__health"; let tries=0; function retry(err){ if (++tries < 20) return setTimeout(probe, 250); console.error(err && err.message ? err.message : "health unavailable"); process.exit(1); } function probe(){ const req=http.get(url, res => { let data=""; res.on("data", chunk => data += chunk); res.on("end", () => { if (res.statusCode === 200) console.log(data); else retry(new Error("health status " + res.statusCode)); }); }); req.on("error", retry); } probe();\'',
    '"${SYSTEMCTL[@]}" status "$UNIT" --no-pager --lines=40 || true',
    'chmod -R a+rX "$CERT_TMP"',
    'if [ "$(id -u)" -eq 0 ]; then sudo -iu hermes env HERMES_CONFIG_PATH="$HERMES_CONFIG_PATH" HERMES_HOME=/var/lib/hermes timeout 120 hermes -z "Reply with exactly: HERMES_OK" --ignore-rules; else HERMES_CONFIG_PATH="$HERMES_CONFIG_PATH" timeout 120 hermes -z "Reply with exactly: HERMES_OK" --ignore-rules; fi',
    'test -s "$DEEPSEEK_CLAUDE_LOG_PATH"',
    'node -e \'const fs=require("fs"); const log=fs.readFileSync(process.env.DEEPSEEK_CLAUDE_LOG_PATH,"utf8"); const key=process.env.DEEPSEEK_API_KEY||""; const lengths=[key.length,24,16,12].filter(n=>n>=8&&n<=key.length); const hit=lengths.find(n=>log.includes(key.slice(0,n))); if(hit){ console.error("secret fragment in gateway log length="+hit); process.exit(1); } console.log(JSON.stringify({gatewayLogBytes:Buffer.byteLength(log),gatewayLogLines:log.split(/\\n/).filter(Boolean).length,gatewayLogCompleted:/CHAT_DONE|POST \\/v1\\/messages|POST \\/v1\\/chat\\/completions/.test(log)}));\'',
    'node -e \'const h=require("./src/hermes-patcher").getStatus(); console.log(JSON.stringify({target:"Hermes Agent", config:h}))\'',
  ].join('\n');
}

/**
 * 执行 Linux Hermes 真 Key smoke。
 * @param {{env?: object, platform?: string}} [options] - 环境与测试平台覆盖。
 * @returns {Promise<object>} 标准 runner 结果。
 */
async function runLinuxHermesSmoke(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const platform = options.platform || process.platform;
  if (platform !== 'linux') {
    return {
      status: 'BLOCKED',
      passed: false,
      failureClass: 'preflight',
      message: 'TC-044 must be executed on the Linux server itself; remote results cannot be attached to another platform report',
      positiveAssertions: 1,
    };
  }
  if (!env.DEEPSEEK_API_KEY) {
    return {
      status: 'BLOCKED',
      passed: false,
      failureClass: 'provider',
      message: 'DEEPSEEK_API_KEY is required for Linux Hermes smoke',
      positiveAssertions: 1,
    };
  }
  env.CERTIFY_LINUX_REPO = env.CERTIFY_LINUX_REPO || process.cwd();
  env.CERTIFY_LINUX_PROXY_PORT = env.CERTIFY_LINUX_PROXY_PORT || String(randomPort());
  const script = buildLinuxScript(env);
  const result = await runCommand('bash', ['-lc', script], {
    env,
    timeoutMs: Number(env.CERTIFY_LINUX_TIMEOUT_MS || 300000),
  });

  const stdout = redactText(result.stdout, [env.DEEPSEEK_API_KEY]);
  const stderr = redactText(result.stderr, [env.DEEPSEEK_API_KEY]);
  const serviceActive = /\bactive\b/.test(stdout);
  const proxyHealthOk = /"service":"deepseek-claude-proxy","ok":true/.test(stdout);
  const hermesOk = /HERMES_OK/.test(stdout);
  const statusSummaryOk = /Loaded:|Active:|Main PID:/.test(stdout);
  const gatewayLogOk = /"gatewayLogBytes":\s*[1-9]\d*/.test(stdout) && /"gatewayLogCompleted":\s*true/.test(stdout);
  const diagnosticOk = /"target":\s*"Hermes Agent"/.test(stdout) || /Hermes Agent/.test(stdout);
  const modelOk = /"model":"deepseek-v4-pro"/.test(stdout)
    && /"thinking":"enabled"/.test(stdout)
    && /"effort":"max"/.test(stdout);
  const passed = result.status === 0 && serviceActive && proxyHealthOk && hermesOk && statusSummaryOk && gatewayLogOk && diagnosticOk && modelOk;
  return {
    status: passed ? 'PASS' : 'FAIL',
    passed,
    failureClass: passed ? null : (result.status === 255 ? 'preflight' : hermesOk ? 'gateway' : 'client'),
    message: passed ? 'Linux Hermes smoke returned HERMES_OK through an isolated transient systemd gateway' : 'Linux Hermes smoke failed',
    postCondition: 'Temporary Hermes config and transient systemd service are removed on exit; real Hermes config is unchanged.',
    positiveAssertions: Number(result.status === 0) + Number(serviceActive) + Number(proxyHealthOk) + Number(hermesOk) + Number(statusSummaryOk) + Number(gatewayLogOk) + Number(diagnosticOk) + Number(modelOk),
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    durationMs: result.durationMs,
  };
}

if (require.main === module) {
  runLinuxHermesSmoke().then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  buildLinuxScript,
  runLinuxHermesSmoke,
};
