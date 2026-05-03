const { intro, outro, text, select, confirm, spinner, note, cancel, isCancel } = require('@clack/prompts');
const configStore = require('./config-store');
const verifier = require('./verifier');

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
  return confirm({
    message: `确认配置？\n  模型: ${cfg.model}  |  思考深度: ${cfg.effort}  |  API Key: ${cfg.apiKey.slice(0,7)}****`,
    initialValue: true,
  });
}

// 完整配置向导
async function configWizard(existing) {
  intro('🔧 DeepSeek × Claude Code — 首次配置');

  const apiKey = await stepApiKey(existing?.apiKey);
  if (apiKey === null) { outro('已取消'); return null; }

  const model = await stepModel(existing?.model);
  if (model === null) { outro('已取消'); return null; }

  const effort = await stepEffort(existing?.effort);
  if (effort === null) { outro('已取消'); return null; }

  const cfg = { apiKey, model, effort };

  if (!await stepConfirm(cfg)) {
    outro('已取消');
    return null;
  }

  configStore.write(cfg);
  outro('✅ 配置已保存');
  return cfg;
}

// 主面板
async function mainPanel(config, proxyManager, launchdManager, settingsPatcher) {
  while (true) {
    const running = await proxyManager.isRunning();
    const patched = settingsPatcher.isPatched();

    // 状态判断
    let statusIcon, statusText, anomaly = false;
    if (running && patched) {
      statusIcon = '🟢'; statusText = '运行中';
    } else if (!running && !patched) {
      statusIcon = '○'; statusText = '未运行';
    } else {
      statusIcon = '⚠'; statusText = '异常 — 状态不一致';
      anomaly = true;
    }

    intro(`🔧 DeepSeek × Claude Code`);
    note(
      `状态: ${statusIcon} ${statusText}\n模型: ${config.model}  |  思考深度: ${config.effort}\n${running ? '代理: localhost:17861' : ''}`
    );

    const options = [];

    if (anomaly) {
      options.push({ value: 'fix', label: '🔧 修复：重新同步状态' });
    } else if (running) {
      options.push({ value: 'stop', label: '■ 关闭代理' });
    } else {
      options.push({ value: 'start', label: '🚀 开启代理' });
    }
    options.push({ value: 'reconfig', label: '⚙ 修改配置' });
    options.push({ value: 'quit', label: '✕ 退出' });

    const choice = await select({ message: '请选择操作', options });
    if (isCancel(choice) || choice === 'quit') break;

    if (choice === 'start') {
      await doStart(config, proxyManager, launchdManager, settingsPatcher);
    } else if (choice === 'stop') {
      await doStop(proxyManager, launchdManager, settingsPatcher);
    } else if (choice === 'reconfig') {
      const newCfg = await configWizard(config);
      if (newCfg) {
        if (running) {
          await doStop(proxyManager, launchdManager, settingsPatcher);
          await doStart(newCfg, proxyManager, launchdManager, settingsPatcher);
        }
        config = newCfg;
      }
    } else if (choice === 'fix') {
      if (running) {
        // 进程在但配置没改
        settingsPatcher.patch(config);
        note('✅ 已修复：配置已指向代理');
      } else {
        await doStart(config, proxyManager, launchdManager, settingsPatcher);
      }
    }
  }

  outro('👋 再见');
  return config;
}

async function doStart(config, proxyManager, launchdManager, settingsPatcher) {
  const s = spinner();
  try {
    s.start('正在部署...');

    // Copy proxy script to ~/.deepseek-claude/
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, '..', 'proxy', 'proxy.js');
    const dst = path.join(configStore.DIR, 'proxy.js');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);

    // Start proxy
    await proxyManager.start(config);
    s.message('✅ 代理进程已启动');

    // LaunchAgent
    launchdManager.install();
    s.message('✅ 开机自启已注册');

    // Patch settings
    settingsPatcher.patch(config);
    s.message('✅ Claude Code 配置已修改');

    // Verify
    s.message('⏳ 验证连接...');
    const result = await verifier.verify(config);
    if (result.ok) {
      s.stop('✅ 全部完成！下次启动 Claude Code 即可生效');
    } else {
      s.stop(`⚠ 代理已部署但验证失败: ${result.error}。请检查网络和 API Key`);
    }
  } catch (err) {
    s.stop(`❌ 部署失败: ${err.message}`);
    // 完整回滚
    try { await proxyManager.stop(); } catch {}
    try { settingsPatcher.restore(); } catch {}
    try { launchdManager.uninstall(); } catch {}
  }
}

async function doStop(proxyManager, launchdManager, settingsPatcher) {
  const s = spinner();
  try {
    s.start('正在关闭...');

    settingsPatcher.restore();
    s.message('✅ Claude Code 配置已还原');

    launchdManager.uninstall();
    s.message('✅ 开机自启已取消');

    await proxyManager.stop();
    s.message('✅ 代理进程已停止');

    s.stop('✅ 已关闭');
  } catch (err) {
    s.stop(`❌ 关闭失败: ${err.message}`);
  }
}

module.exports = { configWizard, mainPanel };
