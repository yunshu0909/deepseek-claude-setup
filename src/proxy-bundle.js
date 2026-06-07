/**
 * Proxy bundle 原子部署
 *
 * 负责：
 * - 把多文件 proxy bundle（proxy.js + gateway.js + providers/ + clients/ + ...）部署到目标目录
 * - 原子协议（PRD-016 US-03）：staging → require-smoke → 逐文件 rename → manifest 最后写（= 提交点）
 * - 失败时不破坏正在运行的旧 bundle、旧代理与用户 config
 *
 * @module src/proxy-bundle
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MANIFEST_NAME = 'proxy-manifest.json';
const ENTRY = 'proxy.js';
const BUNDLE_VERSION = '1.6.0';

/**
 * 递归枚举 sourceDir 下所有 .js 文件的相对路径（排序，稳定）
 * @param {string} sourceDir
 * @returns {string[]} 相对路径列表
 */
function listBundleFiles(sourceDir) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(sourceDir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.startsWith('.')) continue; // 跳过 .bundle-staging-* 等
      const childRel = rel ? path.join(rel, name) : name;
      if (fs.statSync(path.join(sourceDir, childRel)).isDirectory()) walk(childRel);
      else if (name.endsWith('.js')) out.push(childRel);
    }
  })('');
  return out.sort();
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 算 bundle manifest：{version, entry, files:[{name, sha256, size}]}
 */
function buildManifest(rootDir, relFiles) {
  return {
    version: BUNDLE_VERSION,
    entry: ENTRY,
    files: relFiles.map(name => {
      const abs = path.join(rootDir, name);
      return { name, sha256: sha256File(abs), size: fs.statSync(abs).size };
    }),
  };
}

/**
 * 依赖闭包校验：每个被相对 require 的 sibling 都在 bundle 文件集里（US-07 manifest 覆盖全依赖）
 * @returns {{ok:true}|{ok:false,missing:string,from:string}}
 */
function manifestCoversRequires(rootDir, relFiles) {
  const fileSet = new Set(relFiles.map(f => f.split(path.sep).join('/')));
  for (const rel of relFiles) {
    const src = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
    const dir = path.dirname(rel);
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.normalize(path.join(dir, m[1]));
      const cands = [target, target + '.js', path.join(target, 'index.js')]
        .map(c => c.split(path.sep).join('/'));
      if (!cands.some(c => fileSet.has(c))) return { ok: false, missing: m[1], from: rel };
    }
  }
  return { ok: true };
}

/**
 * 目标 bundle 是否已是最新：manifest 存在 + 文件集合一致 + 每个 sha256（target 与 source）都与 manifest 一致
 */
function isBundleCurrent(targetDir, sourceDir) {
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { return false; }
  const sourceFiles = listBundleFiles(sourceDir);
  const manifestNames = (manifest.files || []).map(f => f.name).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(sourceFiles)) return false; // 半新半旧/文件集变化
  for (const f of manifest.files) {
    const tgt = path.join(targetDir, f.name);
    const src = path.join(sourceDir, f.name);
    if (!fs.existsSync(tgt) || sha256File(tgt) !== f.sha256) return false; // 目标缺/被改
    if (!fs.existsSync(src) || sha256File(src) !== f.sha256) return false; // 源已更新 → 需重部署
  }
  return true;
}

/**
 * require-smoke：子进程用 DEEPSEEK_CLAUDE_SMOKE=1 跑 staging/proxy.js，验证 require 链路 + deepseek adapter 可解析
 */
function requireSmoke(stagingDir) {
  const r = spawnSync(process.execPath, [path.join(stagingDir, ENTRY)], {
    env: { ...process.env, DEEPSEEK_CLAUDE_SMOKE: '1' },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { ok: r.status === 0 && /SMOKE_OK/.test(r.stdout || ''), stderr: r.stderr || '', status: r.status };
}

/**
 * 原子部署 bundle
 * @param {string} targetDir - 部署目标（= configStore.DIR）
 * @param {string} sourceDir - bundle 源（= <pkg>/proxy）
 * @returns {{changed:boolean}}
 *
 * 步骤：① 依赖闭包校验 → ② 幂等短路 → ③ staging 写全 → ④ 算 manifest →
 *       ⑤ require-smoke(失败则 target 完全不碰) → ⑥ 逐文件 rename 切换 → ⑦ manifest 最后写(提交点)
 */
function deployProxyBundle(targetDir, sourceDir) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const sourceFiles = listBundleFiles(sourceDir);

  const cov = manifestCoversRequires(sourceDir, sourceFiles);
  if (!cov.ok) throw new Error(`proxy-bundle: 依赖缺失 '${cov.missing}'（来自 ${cov.from}），bundle 不完整`);

  if (isBundleCurrent(targetDir, sourceDir)) return { changed: false };

  const staging = fs.mkdtempSync(path.join(targetDir, '.bundle-staging-'));
  try {
    for (const rel of sourceFiles) {
      const dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, rel), dst);
    }
    const manifest = buildManifest(staging, sourceFiles);

    const smoke = requireSmoke(staging);
    if (!smoke.ok) {
      throw new Error(`proxy-bundle: require-smoke 失败 (status=${smoke.status}) ${smoke.stderr.slice(0, 300)}`);
    }

    // 原子切换：逐文件 rename（同分区原子）；manifest 最后写 = 提交点
    for (const rel of sourceFiles) {
      const tgt = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(tgt), { recursive: true });
      fs.renameSync(path.join(staging, rel), tgt);
    }
    fs.writeFileSync(path.join(targetDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    return { changed: true };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* staging 清理失败不致命 */ }
  }
}

module.exports = {
  deployProxyBundle,
  isBundleCurrent,
  listBundleFiles,
  buildManifest,
  manifestCoversRequires,
  MANIFEST_NAME,
  ENTRY,
};
