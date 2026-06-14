const { intro, outro, text, select, confirm, spinner, note, cancel, isCancel } = require('@clack/prompts');
const configStore = require('./config-store');
const providerRegistry = require('../proxy/providers');
const verifier = require('./verifier');
const modelOptions = require('./model-options');

/**
 * 取当前 active provider 定义（兜底 deepseek）
 * @param {object|null} config - gateway 配置（归一化与否均可）
 * @returns {object} provider 定义
 */
function activeProvider(config) {
  return providerRegistry.getProvider(config?.activeProvider || 'deepseek') || providerRegistry.getProvider('deepseek');
}

/**
 * 取当前 active provider 的展示名
 * @param {object|null} config - gateway 配置
 * @returns {string} 展示名
 */
function providerName(config) {
  return activeProvider(config)?.displayName || config?.activeProvider || 'DeepSeek';
}

/**
 * 当前 provider 是否支持 thinking（默认按支持处理，仅显式 false 才视为不支持）
 * @param {object|null} config - gateway 配置
 * @returns {boolean}
 */
function providerSupportsThinking(config) {
  return activeProvider(config)?.capabilities?.thinking !== false;
}

/**
 * 当前 provider 是否支持 thinking effort 档位（zai/kimi thinkingEffort:false → 不支持）
 * @param {object|null} config - gateway 配置
 * @returns {boolean}
 */
function providerSupportsThinkingEffort(config) {
  return activeProvider(config)?.capabilities?.thinkingEffort !== false;
}

/**
 * 基于向导输入构造 Provider Gateway 配置
 *
 * 执行步骤：
 * 1. 归一化现有配置（兼容旧版扁平 DeepSeek-only 结构）
 * 2. 保留其它 provider 已存的字段，仅覆盖当前 provider 的 apiKey/model
 * 3. 再次归一化产出 {activeProvider, thinking, effort, providers, apiKey, model}
 *
 * @param {object|null} existing - 现有配置，兼容旧版扁平结构
 * @param {string} providerId - 当前选中的 provider id
 * @param {{apiKey: string, model: string, customModels?: string[], thinking: string, effort: string}} fields - 向导输入字段
 * @returns {object} 归一化后的 Provider Gateway 配置
 */
function buildProviderConfig(existing, providerId, fields) {
  const normalized = configStore.normalizeConfig(existing) || {
    activeProvider: providerId,
    thinking: 'enabled',
    effort: 'max',
    providers: {},
  };
  const previousProviders = normalized.providers || {};
  const previousProviderConfig = previousProviders[providerId] || {};
  return configStore.normalizeConfig({
    activeProvider: providerId,
    thinking: fields.thinking,
    effort: fields.effort,
    providers: {
      ...previousProviders,
      [providerId]: {
        ...previousProviderConfig,
        apiKey: fields.apiKey,
        model: fields.model,
        customModels: fields.customModels || previousProviderConfig.customModels,
      },
    },
  });
}

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

// 第一步：选择 provider。后续接入新 provider 只需在 registry 注册，向导自动展开。
async function stepProvider(existing) {
  const providers = providerRegistry.listProviders();
  const providerId = await select({
    message: '选择 Provider',
    options: providers.map(provider => ({
      value: provider.id,
      label: provider.displayName,
    })),
    initialValue: existing || 'deepseek',
  });
  return isCancel(providerId) ? null : providerId;
}

// 第二步：输入 API Key（带验证）。校验走所选 provider 自己的 Anthropic 端点，不写死 DeepSeek。
async function stepApiKey(provider, existing) {
  while (true) {
    const key = await text({
      message: `请输入 ${provider.displayName} API Key`,
      placeholder: provider.id === 'deepseek' ? 'sk-xxxxxxxxxxxxxxxx' : '请输入 API Key',
      initialValue: existing || '',
      validate(value) {
        if (!value.trim()) return '请输入 API Key';
        // sk- 前缀是 DeepSeek 专属约定，其它 provider 不强制
        if (provider.id === 'deepseek' && !value.startsWith('sk-')) return 'DeepSeek API Key 应以 sk- 开头';
        return;
      },
    });
    if (isCancel(key)) return null;

    const s = spinner();
    s.start('验证 API Key...');
    const ok = await verifier.checkApiKey(provider, key);
    if (ok) { s.stop('✅ API Key 验证通过'); return key; }
    s.stop('❌ API Key 无效或网络异常，请重新输入');
  }
}

async function promptCustomModel(provider, initialValue = '') {
  const customModel = await text({
    message: `输入 ${provider.displayName} 模型 ID`,
    placeholder: provider.defaultModel || provider.models?.[0]?.id || 'model-id',
    initialValue,
    validate(value) {
      if (!modelOptions.normalizeModelId(value)) return '请输入模型 ID';
      return;
    },
  });
  return isCancel(customModel) ? null : modelOptions.normalizeModelId(customModel);
}

async function stepManageCustomModels(provider, currentModel, customModels) {
  const savedCustomModels = modelOptions.customModelsForProvider(provider, currentModel, customModels);
  if (!savedCustomModels.length) {
    note('当前 provider 还没有自定义模型。', '自定义模型');
    return { model: currentModel, customModels };
  }

  const action = await select({
    message: '管理自定义模型',
    options: modelOptions.buildManageModelOptions(provider, currentModel, customModels),
  });
  if (isCancel(action)) return null;

  const parsed = modelOptions.parseManageModelAction(provider, currentModel, customModels, action);
  if (parsed.type === 'return') return { model: currentModel, customModels };

  if (parsed.type === 'rename' && parsed.model) {
    const nextModel = await promptCustomModel(provider, parsed.model);
    if (nextModel === null) return null;
    return modelOptions.renameCustomModel(provider, customModels, parsed.model, nextModel, currentModel);
  }

  if (parsed.type === 'delete' && parsed.model) {
    const ok = await confirm({
      message: `删除自定义模型 ${parsed.model}？`,
      initialValue: false,
    });
    if (isCancel(ok)) return null;
    if (!ok) return { model: currentModel, customModels };

    let replacement = currentModel;
    if (modelOptions.normalizeModelId(currentModel) === parsed.model) {
      const replacementOptions = modelOptions.buildReplacementModelOptions(provider, customModels, parsed.model);
      if (!replacementOptions.length) {
        note('没有可用替代模型，无法删除当前模型。', '自定义模型');
        return { model: currentModel, customModels };
      }
      replacement = await select({
        message: `删除当前模型 ${parsed.model} 后，选择替代模型`,
        options: replacementOptions,
        initialValue: modelOptions.initialModelSelection(provider, ''),
      });
      if (isCancel(replacement)) return null;
    }
    return modelOptions.deleteCustomModel(provider, customModels, parsed.model, currentModel, replacement);
  }

  return { model: currentModel, customModels };
}

// 第三步：选择模型。内置模型只读；用户自定义模型支持新增、修改、删除和复选。
async function stepModel(provider, existing, customModels = []) {
  let currentModel = modelOptions.normalizeModelId(existing);
  let currentCustomModels = modelOptions.customModelsForProvider(provider, currentModel, customModels);

  while (true) {
    const m = await select({
      message: '选择模型',
      options: modelOptions.buildModelOptions(provider, currentModel, currentCustomModels),
      initialValue: modelOptions.initialModelSelection(provider, currentModel),
    });
    if (isCancel(m)) return null;

    if (m === modelOptions.CUSTOM_MODEL_ADD_OPTION) {
      const model = await promptCustomModel(provider);
      if (model === null) return null;
      return {
        model,
        customModels: modelOptions.addCustomModel(provider, currentCustomModels, model),
      };
    }

    if (m === modelOptions.CUSTOM_MODEL_MANAGE_OPTION) {
      const managed = await stepManageCustomModels(provider, currentModel, currentCustomModels);
      if (managed === null) return null;
      currentModel = managed.model;
      currentCustomModels = modelOptions.customModelsForProvider(provider, currentModel, managed.customModels);
      continue;
    }

    return {
      model: m,
      customModels: currentCustomModels,
    };
  }
}

// 第四步：选择思考等级
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

// 第五步：确认配置
async function stepConfirm(cfg) {
  const thinkingText = providerSupportsThinking(cfg)
    ? (cfg.thinking === 'disabled' ? '关闭' : (providerSupportsThinkingEffort(cfg) ? `开启 (${cfg.effort})` : '开启'))
    : '不支持';
  const keyText = cfg.apiKey ? `${cfg.apiKey.slice(0, 7)}****` : '未配置';
  return confirm({
    message: `确认配置？\n  Provider: ${providerName(cfg)}  |  模型: ${cfg.model}\n  思考模式: ${thinkingText}  |  API Key: ${keyText}`,
    initialValue: true,
  });
}

/**
 * 完整配置向导
 *
 * 执行步骤：
 * 1. 选 provider → 校验该 provider 的 API Key → 选该 provider 的模型
 * 2. provider 支持 thinking 才问思考模式；支持 thinkingEffort 且开启思考才问深度
 * 3. 用 buildProviderConfig 产出多 provider 归一化配置并写盘
 *
 * @param {object|null} existing - 现有配置（兼容旧版扁平结构）
 * @returns {Promise<object|null>} 写盘后的归一化配置；用户取消返回 null
 */
async function configWizard(existing) {
  const normalized = configStore.normalizeConfig(existing);
  intro(`${I.tool} Provider Gateway × Claude Code / Codex — 配置`);

  const providerId = await stepProvider(normalized?.activeProvider || 'deepseek');
  if (providerId === null) { outro('已取消'); return null; }

  const provider = providerRegistry.getProvider(providerId);
  const providerConfig = normalized?.providers?.[providerId] || {};

  const apiKey = await stepApiKey(provider, providerConfig.apiKey || normalized?.apiKey);
  if (apiKey === null) { outro('已取消'); return null; }

  const modelChoice = await stepModel(provider, providerConfig.model || normalized?.model, providerConfig.customModels);
  if (modelChoice === null) { outro('已取消'); return null; }

  // capability-aware：provider 不支持 thinking 直接跳过思考相关步骤
  let thinking = 'disabled';
  let effort = normalized?.effort || 'max';
  if (provider.capabilities?.thinking !== false) {
    thinking = await stepThinking(normalized?.thinking || 'enabled');
    if (thinking === null) { outro('已取消'); return null; }

    // 仅在开启思考且 provider 支持 effort 档位时才问深度（zai/kimi thinkingEffort:false → 跳过）
    if (thinking === 'enabled' && providerSupportsThinkingEffort({ activeProvider: providerId })) {
      effort = await stepEffort(normalized?.effort);
      if (effort === null) { outro('已取消'); return null; }
    }
  }

  const cfg = buildProviderConfig(normalized, providerId, { apiKey, model: modelChoice.model, customModels: modelChoice.customModels, thinking, effort });

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
    s.stop(`✅ Codex 已接入，直接执行 codex 即可使用 ${providerName(configStore.normalizeConfig(config) || config)}\n   💡 临时使用 OpenAI：codex -p openai`);
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
    s.stop(`✅ Hermes Agent 已接管到本地代理（${providerName(configStore.normalizeConfig(config) || config)}）`);
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
    // 归一化：把可能的旧扁平 config 兼容成多 provider 结构，让 config.model/effort/activeProvider 可靠
    config = configStore.normalizeConfig(config) || config;
    config.thinking = config.thinking || 'enabled';
    const thinkingSupported = providerSupportsThinking(config);
    const running = await proxyManager.isRunning();
    const claudePatched = settingsPatcher.isPatched();
    const codexPatched = codexPatcher?.isPatched?.() || false;
    const hermesAvailable = hermesPatcher?.isAvailable?.() || false;
    const hermesPatched = hermesPatcher?.isPatched?.() || false;
    const anyEnabled = claudePatched || codexPatched || hermesPatched;
    const thinkingText = thinkingSupported
      ? (config.thinking === 'disabled' ? '关闭' : (providerSupportsThinkingEffort(config) ? `开启 (${config.effort})` : '开启'))
      : '不支持';

    // 异常：有接入开启但代理没在跑（手动 kill 了代理或 LaunchAgent 没拉起来）
    const anomaly = anyEnabled && !running;

    intro(`${I.tool} Provider Gateway × Claude Code / Codex`);
    const claudeLine = `Claude Code: ${claudePatched ? `${I.dot} 已接入` : `${I.circle} 未接入`}`;
    const codexLine = `Codex:       ${codexPatched ? `${I.dot} 已接入 (直接 codex 即可使用)` : `${I.circle} 未接入`}`;
    const hermesLine = `Hermes:      ${hermesPatched ? `${I.dot} 已接管` : (hermesAvailable ? `${I.circle} 可接管` : `${I.circle} 未发现 config.yaml`)}`;
    const proxyLine = anomaly
      ? `代理:        ${I.warn} 接入已开但代理未运行`
      : (running ? `代理:        ${I.dot} 127.0.0.1:17861` : `代理:        ${I.circle} 未运行`);
    note(
      `${claudeLine}\n${codexLine}\n${hermesLine}\n${proxyLine}\nProvider: ${providerName(config)}  |  模型: ${config.model}  |  思考模式: ${thinkingText}`
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
    if (thinkingSupported) {
      options.push({
        value: 'toggle-thinking',
        label: config.thinking === 'disabled' ? `${I.brain} 开启思考模式` : `${I.brain} 关闭思考模式`,
      });
    }
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
  buildProviderConfig,
  buildModelOptions: modelOptions.buildModelOptions,
  CUSTOM_MODEL_OPTION: modelOptions.CUSTOM_MODEL_OPTION,
  CUSTOM_MODEL_ADD_OPTION: modelOptions.CUSTOM_MODEL_ADD_OPTION,
  CUSTOM_MODEL_MANAGE_OPTION: modelOptions.CUSTOM_MODEL_MANAGE_OPTION,
  addCustomModel: modelOptions.addCustomModel,
  buildReplacementModelOptions: modelOptions.buildReplacementModelOptions,
  deleteCustomModel: modelOptions.deleteCustomModel,
  renameCustomModel: modelOptions.renameCustomModel,
  resolveReplacementModel: modelOptions.resolveReplacementModel,
  providerName,
  providerSupportsThinking,
  providerSupportsThinkingEffort,
};
