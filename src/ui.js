const { intro, outro, text, select, confirm, spinner, note, cancel, isCancel } = require('@clack/prompts');
const configStore = require('./config-store');
const verifier = require('./verifier');

/**
 * 跨平台终端 emoji 支持检测（PRD-003 §3.1）
 *
 * 正向检测 UTF-8 + TTY，不绑定 process.platform——让 Linux SSH / CI 等场景也能正确降级。
 *
 * @returns {boolean} 当前终端是否支持 emoji 渲染
 */
function supportsEmoji() {
  if (!process.stdout.isTTY) return false;
  // 已知支持 UTF-8 的终端环境标识
  if (process.env.WT_SESSION) return true;        // Windows Terminal
  if (process.env.TERM_PROGRAM) return true;       // VSCode / iTerm / Apple_Terminal 都设此变量
  if (process.env.MSYSTEM) return true;            // Git Bash (MinTTY)
  // locale 显式声明 UTF-8
  if (/UTF-?8/i.test(process.env.LANG || process.env.LC_ALL || '')) return true;
  // macOS Terminal.app 默认 UTF-8 但环境变量可能不带 LANG（按 PRD-003 §3.1 兜底）
  return process.platform === 'darwin';
}

// 主面板字符集：emoji 终端渲染好看；旧 cmd / PowerShell 5.1 走 ASCII 占位避免显示 ?
// 键集合稳定，PRD-005 多 provider 时可按需扩展
const I_EMOJI = { tool: '🔧', robot: '🤖', cmd: '⌘',   hermes: '◇', brain: '🧠', dot: '🟢', circle: '○', warn: '⚠',   cog: '⚙',   cross: '✕',   bye: '👋',     wrench: '🔧', info: 'ⓘ' };
const I_ASCII = { tool: '[ ]', robot: '[C]', cmd: '[X]', hermes: '[H]', brain: '[T]', dot: '*', circle: '○', warn: '[!]', cog: '[*]', cross: '[x]', bye: '[bye]', wrench: '[F]', info: '[i]' };
const I = supportsEmoji() ? I_EMOJI : I_ASCII;

// 第一步：输入 API Key（带验证）
async function stepApiKey(existing) {
  while (true) {
    const key = await text({
      message: '请输入 DeepSeek API Key',
      placeholder: 'sk-xxxxxxxxxxxxxxxx',
      initialValue: existing || '',
      validate(value) {
        if (!value.trim()) return '请输入 API Key';
        if (!value.startsWith('sk-')) return 'API Key 应以 sk- 开头';
        return;
      },
    });
    if (isCancel(key)) return null;

    const s = spinner();
    s.start('验证 API Key...');
    const ok = await verifier.checkApiKey(key);
    if (ok) { s.stop('✅ API Key 验证通过'); return key; }
    s.stop('❌ API Key 无效，请重新输入');
  }
}

// 第二步：选择模型
async function stepModel(existing) {
  const m = await select({
    message: '选择模型',
    options: [
      { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（推荐 — 最强推理）', hint: 'Pro' },
      { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash（快速响应）', hint: 'Flash' },
    ],
    initialValue: existing || 'deepseek-v4-pro',
  });
  return isCancel(m) ? null : m;
}

// 第三步：选择思考等级
async function stepThinking(existing) {
  const t = await select({
    message: '选择思考模式',
    options: [
      { value: 'enabled', label: '开启思考模式（推荐 — 复杂任务）', hint: 'Thinking on' },
      { value: 'disabled', label: '关闭思考模式（更快响应）', hint: 'Thinking off' },
    ],
    initialValue: existing || 'enabled',
  });
  return isCancel(t) ? null : t;
}

async function stepEffort(existing) {
  const e = await select({
    message: '选择思考深度',
    options: [
      { value: 'max', label: 'max（推荐 — 最强推理）', hint: '推荐' },
      { value: 'high', label: 'high（均衡）', hint: '默认' },
    ],
    initialValue: existing || 'max',
  });
  return isCancel(e) ? null : e;
}

// 第四步：确认配置
async function stepConfirm(cfg) {
  const thinkingText = cfg.thinking === 'disabled' ? '关闭' : `开启 (${cfg.effort})`;
  return confirm({
    message: `确认配置？\n  模型: ${cfg.model}  |  思考模式: ${thinkingText}  |  API Key: ${cfg.apiKey.slice(0,7)}****`,
    initialValue: true,
  });
}

// 完整配置向导
async function configWizard(existing) {
  intro(`${I.tool} DeepSeek × Claude Code — 首次配置`);

  const apiKey = await stepApiKey(existing?.apiKey);
  if (apiKey === null) { outro('已取消'); return null; }

  const model = await stepModel(existing?.model);
  if (model === null) { outro('已取消'); return null; }

  const thinking = await stepThinking(existing?.thinking || 'enabled');
  if (thinking === null) { outro('已取消'); return null; }

  let effort = existing?.effort || 'max';
  if (thinking === 'enabled') {
    effort = await stepEffort(existing?.effort);
    if (effort === null) { outro('已取消'); return null; }
  }

  const cfg = { apiKey, model, thinking, effort };

  if (!await stepConfirm(cfg)) {
    outro('已取消');
    return null;
  }

  configStore.write(cfg);
  outro('✅ 配置已保存');
  return cfg;
}

/**
 * 把代理脚本复制到 ~/.deepseek-claude/proxy.js
 * @returns {boolean} true 表示文件被更新（首次部署或内容变化），false 表示已是最新无需更新
 */
function deployProxyScript() {
  const path = require('path');
  const proxyBundle = require('./proxy-bundle');
  // v1.6.0：proxy 是多文件 bundle，用原子部署（staging→require-smoke→逐文件 rename→manifest 最后写）。
  const src = path.join(__dirname, '..', 'proxy');
  return proxyBundle.deployProxyBundle(configStore.DIR, src).changed;
}

/**
 * 确保代理在跑且使用最新版 proxy.js
 *
 * 关键行为：
 * - 包升级后（npm 包/node 模块更新）proxy.js 内容变化 → 即使代理在跑也会自动 restart 用新代码
 * - 用户不需要手动「关闭接入再重新开启」来升级
 * - 文件无变化时已运行的代理不动
 */
async function ensureProxyRunning(config, proxyManager, autostart) {
  const updated = deployProxyScript();
  const running = await proxyManager.isRunning();
  if (running && !updated) return false;

  if (running && updated) {
    // 代理在跑但 proxy.js 已升级，需要重启使新代码生效
    await proxyManager.stop();
  }
  await proxyManager.start(config);
  const installResult = autostart.install();
  if (installResult && installResult.supported === false) {
    note(`⚠ Linux 当前环境未检测到 systemd，自启未注册；本次代理已运行。\n${installResult.message || ''}`);
  }
  return updated; // true 表示发生了升级
}

/**
 * 重启代理使新 config（model/thinking/effort）生效。代理只在启动时读 config.json 一次。
 * 同时会顺带带上最新 proxy.js
 */
async function restartProxy(config, proxyManager, autostart) {
  await proxyManager.stop();
  deployProxyScript();
  await proxyManager.start(config);
  const installResult = autostart.install();
  if (installResult && installResult.supported === false) {
    note(`⚠ Linux 当前环境未检测到 systemd，自启未注册；本次代理已运行。\n${installResult.message || ''}`);
  }
}

/**
 * 如果 Claude Code 与 Codex 两个接入都已关闭，停代理 + 卸 LaunchAgent
 * 否则保持代理运行（另一个接入还在用）
 */
async function maybeStopProxy(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher) {
  const claudeStill = settingsPatcher.isPatched();
  const codexStill = codexPatcher?.isPatched?.() || false;
  const hermesStill = hermesPatcher?.isPatched?.() || false;
  if (claudeStill || codexStill || hermesStill) return false;
  autostart.uninstall();
  await proxyManager.stop();
  return true;
}

async function enableClaude(config, proxyManager, autostart, settingsPatcher) {
  const s = spinner();
  try {
    s.start('正在接入 Claude Code...');
    await ensureProxyRunning(config, proxyManager, autostart);
    s.message('✅ 代理已就绪');
    settingsPatcher.patch(config);
    s.message('✅ Claude Code 配置已修改');
    s.message('⏳ 验证连接...');
    const result = await verifier.verify(config);
    if (result.ok) {
      s.stop('✅ Claude Code 已接入，下次启动 Claude Code 即可生效');
    } else {
      s.stop(`⚠ 已接入但验证失败: ${result.error}。请检查网络和 API Key`);
    }
    return true;
  } catch (err) {
    s.stop(`❌ Claude Code 接入失败: ${err.message}`);
    try { settingsPatcher.restore(); } catch {}
    return false;
  }
}

async function disableClaude(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher) {
  const s = spinner();
  try {
    s.start('正在关闭 Claude Code 接入...');
    settingsPatcher.restore();
    s.message('✅ Claude Code 配置已还原');
    const stopped = await maybeStopProxy(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    s.stop(stopped ? '✅ Claude Code 接入已关闭，代理已停止' : '✅ Claude Code 接入已关闭，代理仍为其他接入服务');
  } catch (err) {
    s.stop(`❌ 关闭失败: ${err.message}`);
  }
}

async function enableCodex(config, proxyManager, autostart, codexPatcher) {
  const s = spinner();
  try {
    s.start('正在接入 Codex...');
    await ensureProxyRunning(config, proxyManager, autostart);
    s.message('✅ 代理已就绪');
    codexPatcher.patch(config);
    s.stop('✅ Codex 已接入，直接执行 codex 即可使用 DeepSeek\n   💡 临时使用 OpenAI：codex -p openai');
    return true;
  } catch (err) {
    s.stop(`❌ Codex 接入失败: ${err.message}`);
    try { codexPatcher.restore(); } catch {}
    return false;
  }
}

async function disableCodex(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher) {
  const s = spinner();
  try {
    s.start('正在关闭 Codex 接入...');
    codexPatcher.restore();
    s.message('✅ Codex 配置已还原');
    const stopped = await maybeStopProxy(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    s.stop(stopped ? '✅ Codex 接入已关闭，代理已停止' : '✅ Codex 接入已关闭，代理仍为其他接入服务');
  } catch (err) {
    s.stop(`❌ 关闭失败: ${err.message}`);
  }
}

async function enableHermes(config, proxyManager, autostart, hermesPatcher) {
  const s = spinner();
  try {
    s.start('正在接管 Hermes Agent...');
    if (!hermesPatcher?.isAvailable?.()) {
      throw new Error(`找不到 Hermes config.yaml：${hermesPatcher?.CONFIG_PATH || 'unknown'}`);
    }
    await ensureProxyRunning(config, proxyManager, autostart);
    s.message('✅ 代理已就绪');
    hermesPatcher.patch(config);
    s.stop('✅ Hermes Agent 已接管到本地 DeepSeek 代理');
    return true;
  } catch (err) {
    s.stop(`❌ Hermes Agent 接管失败: ${err.message}`);
    return false;
  }
}

async function disableHermes(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher) {
  const s = spinner();
  try {
    s.start('正在还原 Hermes Agent...');
    const restored = hermesPatcher.restore();
    s.message(restored ? '✅ Hermes 配置已还原' : '⚠ 未找到 Hermes 备份，当前配置未修改');
    const stopped = await maybeStopProxy(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    s.stop(stopped ? '✅ Hermes Agent 接入已关闭，代理已停止' : '✅ Hermes Agent 接入已关闭，代理仍为其他接入服务');
    return true;
  } catch (err) {
    s.stop(`❌ Hermes Agent 还原失败: ${err.message}`);
    return false;
  }
}

async function diagnoseHermes(proxyManager, autostart, hermesPatcher) {
  const health = await proxyManager.getHealth();
  const serviceStatus = autostart.status ? autostart.status() : { installed: autostart.isInstalled?.() || false };
  note(JSON.stringify(hermesPatcher.diagnose(health, serviceStatus), null, 2), 'Hermes 诊断');
}

/**
 * 主面板启动自检：代理在跑但 proxy.js 已升级时自动重启使用新代码。
 * 用户感知：执行 npx/node cli.js 进入主面板就用上最新版本，无需手动「关再开」
 */
async function syncProxyOnStartup(config, proxyManager, autostart) {
  if (!await proxyManager.isRunning()) return false;
  const path = require('path');
  const proxyBundle = require('./proxy-bundle');
  const src = path.join(__dirname, '..', 'proxy');
  // v1.6.0：bundle 任一文件变化即视为需升级（isBundleCurrent 比对 manifest + 全文件 sha256）。
  const needsUpdate = !proxyBundle.isBundleCurrent(configStore.DIR, src);
  if (!needsUpdate) return false;
  const s = spinner();
  s.start('检测到 proxy 已升级，正在重启代理使用最新代码...');
  try {
    await restartProxy(config, proxyManager, autostart);
    s.stop('✅ 代理已升级到最新版');
  } catch (err) {
    s.stop(`⚠ 自动升级失败: ${err.message}（不影响现有功能）`);
  }
  return true;
}

/**
 * 主面板启动自检：codex 接入开着但 config.toml 是旧 patcher 写的（顶层未 strip
 * model/effort/provider）→ 自动用最新 patcher 重写一次，让用户无感升级。
 *
 * 旧 patcher（< v1.4.0-rc）只写 [profiles.default] 接管，但顶层用户原 model
 * 字段仍在，被 codex 优先用导致接管失效。新 patcher 会 strip 顶层并存到注释。
 */
async function syncCodexPatchOnStartup(config, codexPatcher) {
  if (!codexPatcher?.isPatched?.()) return false;
  const fs = require('fs');
  let content = '';
  try {
    const cfgPath = codexPatcher.CODEX_CONFIG_PATH;
    if (!cfgPath || !fs.existsSync(cfgPath)) return false;
    content = fs.readFileSync(cfgPath, 'utf-8');
  } catch { return false; }
  // 检测两类需要重 patch 的情况：
  // (1) 文件里有重复的 [model_providers.deepseek_local] / [profiles.default]
  //     （v0.2 残留 / 手工编辑导致 TOML 1.0 同表重复，codex 解析吞表 → 报
  //     "Model provider 'deepseek_local' not found"）
  // (2) managed block 之前缺顶层 model_provider = "deepseek_local"
  //     （codex 0.128 登录态下顶层 model_provider 是路由决定性字段）
  const beforeManaged = content.split('# >>> deepseek-claude-setup codex')[0];
  const providerHeaderCount = (content.match(/^\[model_providers\.deepseek_local\]/gm) || []).length;
  const profileHeaderCount = (content.match(/^\[profiles\.default\]/gm) || []).length;
  const hasDuplicate = providerHeaderCount > 1 || profileHeaderCount > 1;
  const hasOurOverride = /^model_provider\s*=\s*"deepseek_local"/m.test(beforeManaged);
  if (hasOurOverride && !hasDuplicate) return false;
  const s = spinner();
  s.start('检测到 Codex 配置需要升级，正在自动修复...');
  try {
    codexPatcher.patch(config);
    s.stop('✅ Codex 配置已升级（顶层 model 已 strip，[profiles.default] 现在生效）');
  } catch (err) {
    s.stop(`⚠ 自动修复失败：${err.message}`);
  }
  return true;
}

// 主面板
async function mainPanel(config, proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher) {
  await syncProxyOnStartup(config, proxyManager, autostart);
  await syncCodexPatchOnStartup(config, codexPatcher);
  while (true) {
    config.thinking = config.thinking || 'enabled';
    const running = await proxyManager.isRunning();
    const claudePatched = settingsPatcher.isPatched();
    const codexPatched = codexPatcher?.isPatched?.() || false;
    const hermesAvailable = hermesPatcher?.isAvailable?.() || false;
    const hermesPatched = hermesPatcher?.isPatched?.() || false;
    const anyEnabled = claudePatched || codexPatched || hermesPatched;
    const thinkingText = config.thinking === 'disabled' ? '关闭' : `开启 (${config.effort})`;

    // 异常：有接入开启但代理没在跑（手动 kill 了代理或 LaunchAgent 没拉起来）
    const anomaly = anyEnabled && !running;

    intro(`${I.tool} DeepSeek × Claude Code / Codex`);
    const claudeLine = `Claude Code: ${claudePatched ? `${I.dot} 已接入` : `${I.circle} 未接入`}`;
    const codexLine = `Codex:       ${codexPatched ? `${I.dot} 已接入 (直接 codex 即可使用)` : `${I.circle} 未接入`}`;
    const hermesLine = `Hermes:      ${hermesPatched ? `${I.dot} 已接管` : (hermesAvailable ? `${I.circle} 可接管` : `${I.circle} 未发现 config.yaml`)}`;
    const proxyLine = anomaly
      ? `代理:        ${I.warn} 接入已开但代理未运行`
      : (running ? `代理:        ${I.dot} 127.0.0.1:17861` : `代理:        ${I.circle} 未运行`);
    note(
      `${claudeLine}\n${codexLine}\n${hermesLine}\n${proxyLine}\n模型: ${config.model}  |  思考模式: ${thinkingText}`
    );

    const options = [];
    if (anomaly) {
      options.push({ value: 'fix', label: `${I.wrench} 修复：重启代理` });
    }
    options.push({
      value: claudePatched ? 'disable-claude' : 'enable-claude',
      label: claudePatched ? `${I.robot} 关闭 Claude Code 接入` : `${I.robot} 开启 Claude Code 接入`,
    });
    if (codexPatcher) {
      options.push({
        value: codexPatched ? 'disable-codex' : 'enable-codex',
        label: codexPatched ? `${I.cmd} 关闭 Codex 接入` : `${I.cmd} 开启 Codex 接入`,
      });
    }
    if (hermesPatcher) {
      options.push({
        value: hermesPatched ? 'disable-hermes' : 'enable-hermes',
        label: hermesPatched ? `${I.hermes} 关闭 Hermes Agent 接管` : `${I.hermes} 开启 Hermes Agent 接管`,
      });
      options.push({ value: 'diagnose-hermes', label: `${I.info} Hermes Agent 诊断` });
    }
    options.push({
      value: 'toggle-thinking',
      label: config.thinking === 'disabled' ? `${I.brain} 开启思考模式` : `${I.brain} 关闭思考模式`,
    });
    options.push({ value: 'reconfig', label: `${I.cog} 修改配置` });
    options.push({ value: 'quit', label: `${I.cross} 退出` });

    const choice = await select({ message: '请选择操作', options });
    if (isCancel(choice) || choice === 'quit') break;

    if (choice === 'enable-claude') {
      await enableClaude(config, proxyManager, autostart, settingsPatcher);
    } else if (choice === 'disable-claude') {
      await disableClaude(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    } else if (choice === 'enable-codex') {
      await enableCodex(config, proxyManager, autostart, codexPatcher);
    } else if (choice === 'disable-codex') {
      await disableCodex(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    } else if (choice === 'enable-hermes') {
      await enableHermes(config, proxyManager, autostart, hermesPatcher);
    } else if (choice === 'disable-hermes') {
      await disableHermes(proxyManager, autostart, settingsPatcher, codexPatcher, hermesPatcher);
    } else if (choice === 'diagnose-hermes') {
      await diagnoseHermes(proxyManager, autostart, hermesPatcher);
    } else if (choice === 'toggle-thinking') {
      config = { ...config, thinking: config.thinking === 'disabled' ? 'enabled' : 'disabled' };
      configStore.write(config);
      // 任一接入开启时重启代理使新配置生效；同时把当前 patched 项重新 patch（写入新 thinking 状态到 settings）
      if (anyEnabled) {
        await restartProxy(config, proxyManager, autostart);
      }
      if (claudePatched) settingsPatcher.patch(config);
      if (codexPatched) codexPatcher.patch(config);
      if (hermesPatched) hermesPatcher.patch(config);
      note(`✅ 思考模式已${config.thinking === 'disabled' ? '关闭' : '开启'}`);
    } else if (choice === 'reconfig') {
      const newCfg = await configWizard(config);
      if (newCfg) {
        if (anyEnabled) {
          await restartProxy(newCfg, proxyManager, autostart);
        }
        if (claudePatched) settingsPatcher.patch(newCfg);
        if (codexPatched) codexPatcher.patch(newCfg);
        if (hermesPatched) hermesPatcher.patch(newCfg);
        config = newCfg;
      }
    } else if (choice === 'fix') {
      // 接入开着但代理掉了：重启代理即可
      await ensureProxyRunning(config, proxyManager, autostart);
      note('✅ 代理已重启');
    }
  }

  outro(`${I.bye} 再见`);
  return config;
}

module.exports = {
  configWizard,
  mainPanel,
  supportsEmoji,
  enableHermes,
  disableHermes,
  diagnoseHermes,
};
