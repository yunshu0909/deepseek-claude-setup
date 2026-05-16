/**
 * 零依赖 .env 加载器
 *
 * 负责：
 * - 读取仓库根 `.env`（已被 .gitignore 忽略，不会进 git）
 * - 把 KEY=VALUE 注入 process.env，**不覆盖**已存在的环境变量
 *   （命令行临时 export 优先级高于 .env 文件）
 *
 * 只用 Node 内置 fs/path，不引第三方 dotenv（遵守项目零依赖约定）。
 *
 * @module scripts/lib/load-env
 */
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue; // 已设置则不覆盖
    let val = line.slice(eq + 1).trim();
    // 去掉可选的成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 跳过未填写的占位值 <...>，避免把占位符当真 key 注入导致诡异失败
    if (!val || (val.startsWith('<') && val.endsWith('>'))) continue;
    process.env[key] = val;
  }
}

loadEnv();

module.exports = { loadEnv, ENV_PATH };
