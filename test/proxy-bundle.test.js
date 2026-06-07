/**
 * proxy-bundle 原子部署测试（PRD-016 US-03）
 * 覆盖：happy / 缺文件 / require失败 / 半新半旧manifest / 不破坏旧bundle
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { deployProxyBundle, isBundleCurrent, MANIFEST_NAME } = require('../src/proxy-bundle');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  OK ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); failed++; }
}
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 写一个最小可 require-smoke 的合成 bundle
function writeSource(dir, { omitGateway = false, breakGateway = false } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'providers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proxy.js'),
    `require('./gateway');\n` +
    `const providers = require('./providers');\n` +
    `if (process.env.DEEPSEEK_CLAUDE_SMOKE === '1') {\n` +
    `  if (!providers.getProvider('deepseek')) { console.error('no deepseek'); process.exit(3); }\n` +
    `  console.log('SMOKE_OK'); process.exit(0);\n` +
    `}\n` +
    `require('http').createServer(() => {}).listen(0);\n`);
  if (!omitGateway) {
    fs.writeFileSync(path.join(dir, 'gateway.js'),
      breakGateway ? `module.exports = { ;;; broken syntax` : `module.exports = {};\n`);
  }
  fs.writeFileSync(path.join(dir, 'providers', 'index.js'),
    `module.exports = { getProvider: id => id === 'deepseek' ? { id: 'deepseek' } : null };\n`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-bundle-test-'));

check('happy: 部署好 bundle → 文件 + manifest + isBundleCurrent + 幂等', () => {
  const src = path.join(tmp, 's0'), tgt = path.join(tmp, 't0');
  writeSource(src);
  const r = deployProxyBundle(tgt, src);
  assert.strictEqual(r.changed, true);
  assert.ok(fs.existsSync(path.join(tgt, 'proxy.js')));
  assert.ok(fs.existsSync(path.join(tgt, 'gateway.js')));
  assert.ok(fs.existsSync(path.join(tgt, 'providers', 'index.js')));
  assert.ok(fs.existsSync(path.join(tgt, MANIFEST_NAME)));
  assert.strictEqual(isBundleCurrent(tgt, src), true);
  assert.strictEqual(deployProxyBundle(tgt, src).changed, false); // 幂等短路
});

check('缺文件: source 缺 gateway.js → throw 依赖缺失，target 不变', () => {
  const src = path.join(tmp, 's1'), tgt = path.join(tmp, 't1');
  writeSource(src, { omitGateway: true });
  fs.mkdirSync(tgt, { recursive: true });
  fs.writeFileSync(path.join(tgt, 'sentinel.txt'), 'old');
  assert.throws(() => deployProxyBundle(tgt, src), /依赖缺失|gateway/);
  assert.strictEqual(fs.readFileSync(path.join(tgt, 'sentinel.txt'), 'utf-8'), 'old');
});

check('require失败: gateway 语法错 → require-smoke 失败 throw，target 不变', () => {
  const src = path.join(tmp, 's2'), tgt = path.join(tmp, 't2');
  writeSource(src, { breakGateway: true });
  fs.mkdirSync(tgt, { recursive: true });
  fs.writeFileSync(path.join(tgt, 'sentinel.txt'), 'old');
  assert.throws(() => deployProxyBundle(tgt, src), /require-smoke/);
  assert.strictEqual(fs.readFileSync(path.join(tgt, 'sentinel.txt'), 'utf-8'), 'old');
});

check('半新半旧: target manifest 文件集不符 → isBundleCurrent false → 重部署对齐', () => {
  const src = path.join(tmp, 's3'), tgt = path.join(tmp, 't3');
  writeSource(src);
  deployProxyBundle(tgt, src);
  const mp = path.join(tgt, MANIFEST_NAME);
  const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
  m.files = m.files.filter(f => f.name !== 'gateway.js'); // 篡改成少一个
  fs.writeFileSync(mp, JSON.stringify(m));
  assert.strictEqual(isBundleCurrent(tgt, src), false);
  assert.strictEqual(deployProxyBundle(tgt, src).changed, true);
  assert.strictEqual(isBundleCurrent(tgt, src), true);
});

check('不破坏旧bundle: 先好部署，再失败部署 → 旧 bundle byte 不变', () => {
  const src = path.join(tmp, 's4'), tgt = path.join(tmp, 't4');
  writeSource(src);
  deployProxyBundle(tgt, src);
  const before = {};
  for (const f of ['proxy.js', 'gateway.js', path.join('providers', 'index.js'), MANIFEST_NAME]) {
    before[f] = sha(path.join(tgt, f));
  }
  fs.writeFileSync(path.join(src, 'gateway.js'), 'module.exports = { ;;; broken'); // 弄坏 source
  assert.throws(() => deployProxyBundle(tgt, src), /require-smoke/);
  for (const f of Object.keys(before)) {
    assert.strictEqual(sha(path.join(tgt, f)), before[f], `${f} 被改了`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nproxy-bundle tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
