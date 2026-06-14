/**
 * 配置向导全流程测试
 *
 * 负责：
 * - 用 fake @clack/prompts 驱动 configWizard 的真实交互分支
 * - 验证自定义模型新增、修改、删除和取消不落盘
 * - 确保测试不调用真实 provider API、不写真实用户配置
 *
 * @module test/config-wizard-flow.test
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANCEL = Symbol('cancel');

function clearProjectModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function createPromptMock(script, calls) {
  function next(type, prompt = {}) {
    const step = script.shift();
    assert.ok(step, `missing prompt step for ${type}: ${prompt.message || ''}`);
    assert.strictEqual(step.type, type, `expected ${step.type}, got ${type} for ${prompt.message || ''}`);
    if (step.message) assert.match(prompt.message || '', step.message);
    calls.push({ type, message: prompt.message, options: prompt.options });
    if (step.cancel) return CANCEL;
    if (type === 'select' && step.labelIncludes) {
      const option = (prompt.options || []).find(item => String(item.label).includes(step.labelIncludes));
      assert.ok(option, `missing select option containing ${step.labelIncludes}`);
      return option.value;
    }
    if (type === 'text' && prompt.validate) {
      assert.strictEqual(prompt.validate(step.value), undefined);
    }
    return step.value;
  }

  return {
    intro(message) { calls.push({ type: 'intro', message }); },
    outro(message) { calls.push({ type: 'outro', message }); },
    note(message, title) { calls.push({ type: 'note', message, title }); },
    cancel(message) { calls.push({ type: 'cancel', message }); return CANCEL; },
    isCancel(value) { return value === CANCEL; },
    spinner() {
      return {
        start(message) { calls.push({ type: 'spinner.start', message }); },
        stop(message) { calls.push({ type: 'spinner.stop', message }); },
      };
    },
    async select(prompt) { return next('select', prompt); },
    async text(prompt) { return next('text', prompt); },
    async confirm(prompt) { return next('confirm', prompt); },
  };
}

function purgeUiModules() {
  clearProjectModule('@clack/prompts');
  clearProjectModule('../src/ui');
  clearProjectModule('../src/config-store');
  clearProjectModule('../src/verifier');
}

async function runWizard({ existing, script, initialFile }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-wizard-flow-'));
  const originalConfigDir = process.env.DEEPSEEK_CLAUDE_CONFIG_DIR;
  const calls = [];
  const promptPath = require.resolve('@clack/prompts');
  const verifierPath = require.resolve('../src/verifier');
  const configPath = path.join(tmpRoot, 'config.json');

  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    if (initialFile !== undefined) {
      fs.writeFileSync(configPath, JSON.stringify(initialFile, null, 2));
    }
    process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = tmpRoot;
    purgeUiModules();
    require.cache[promptPath] = {
      id: promptPath,
      filename: promptPath,
      loaded: true,
      exports: createPromptMock(script, calls),
    };
    require.cache[verifierPath] = {
      id: verifierPath,
      filename: verifierPath,
      loaded: true,
      exports: {
        async checkApiKey(provider, key) {
          calls.push({ type: 'verifier.checkApiKey', providerId: provider.id, key });
          return true;
        },
      },
    };

    const ui = require('../src/ui');
    const result = await ui.configWizard(existing);
    assert.strictEqual(script.length, 0, `unused prompt steps: ${script.map(step => step.type).join(', ')}`);
    const saved = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : null;
    return { result, saved, calls };
  } finally {
    purgeUiModules();
    if (originalConfigDir === undefined) {
      delete process.env.DEEPSEEK_CLAUDE_CONFIG_DIR;
    } else {
      process.env.DEEPSEEK_CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  OK ${name}`);
      return 1;
    });
}

async function run() {
  let passed = 0;

  passed += await check('wizard adds a ZAI custom model and preserves other providers', async () => {
    const existing = {
      activeProvider: 'deepseek',
      thinking: 'enabled',
      effort: 'max',
      providers: {
        deepseek: { apiKey: 'sk-deepseek', model: 'ds-custom', customModels: ['ds-custom'] },
        kimi: { apiKey: 'moonshot-key', model: 'kimi-custom', customModels: ['kimi-custom'] },
      },
    };
    const { result, saved, calls } = await runWizard({
      existing,
      script: [
        { type: 'select', message: /选择 Provider/, value: 'zai' },
        { type: 'text', message: /API Key/, value: 'zhipu-key' },
        { type: 'select', message: /选择模型/, labelIncludes: '新增自定义模型' },
        { type: 'text', message: /模型 ID/, value: ' glm-5.2 ' },
        { type: 'select', message: /选择思考模式/, value: 'enabled' },
        { type: 'confirm', message: /确认配置/, value: true },
      ],
    });

    assert.strictEqual(calls.filter(call => call.type === 'verifier.checkApiKey').length, 1);
    assert.strictEqual(result.activeProvider, 'zai');
    assert.strictEqual(result.model, 'glm-5.2');
    assert.deepStrictEqual(result.providers.zai.customModels, ['glm-5.2']);
    assert.deepStrictEqual(result.providers.deepseek.customModels, ['ds-custom']);
    assert.deepStrictEqual(result.providers.kimi.customModels, ['kimi-custom']);
    assert.deepStrictEqual(saved, result);
  });

  passed += await check('wizard renames the current DeepSeek custom model', async () => {
    const existing = {
      activeProvider: 'deepseek',
      thinking: 'enabled',
      effort: 'max',
      providers: {
        deepseek: { apiKey: 'sk-deepseek', model: 'ds-old', customModels: ['ds-old'] },
      },
    };
    const { result, saved } = await runWizard({
      existing,
      script: [
        { type: 'select', message: /选择 Provider/, value: 'deepseek' },
        { type: 'text', message: /API Key/, value: 'sk-deepseek' },
        { type: 'select', message: /选择模型/, labelIncludes: '管理自定义模型' },
        { type: 'select', message: /管理自定义模型/, labelIncludes: '修改自定义模型：ds-old' },
        { type: 'text', message: /模型 ID/, value: ' ds-new ' },
        { type: 'select', message: /选择模型/, labelIncludes: '继续使用当前自定义模型：ds-new' },
        { type: 'select', message: /选择思考模式/, value: 'enabled' },
        { type: 'select', message: /选择思考深度/, value: 'max' },
        { type: 'confirm', message: /确认配置/, value: true },
      ],
    });

    assert.strictEqual(result.model, 'ds-new');
    assert.deepStrictEqual(result.providers.deepseek.customModels, ['ds-new']);
    assert.deepStrictEqual(saved, result);
  });

  passed += await check('wizard deletes the current Kimi custom model after selecting a built-in replacement', async () => {
    const existing = {
      activeProvider: 'kimi',
      thinking: 'enabled',
      effort: 'max',
      providers: {
        kimi: { apiKey: 'moonshot-key', model: 'kimi-custom', customModels: ['kimi-custom', 'kimi-other'] },
      },
    };
    const { result, saved } = await runWizard({
      existing,
      script: [
        { type: 'select', message: /选择 Provider/, value: 'kimi' },
        { type: 'text', message: /API Key/, value: 'moonshot-key' },
        { type: 'select', message: /选择模型/, labelIncludes: '管理自定义模型' },
        { type: 'select', message: /管理自定义模型/, labelIncludes: '删除自定义模型：kimi-custom' },
        { type: 'confirm', message: /删除自定义模型 kimi-custom/, value: true },
        { type: 'select', message: /选择替代模型/, value: 'kimi-k2.6' },
        { type: 'select', message: /选择模型/, value: 'kimi-k2.6' },
        { type: 'select', message: /选择思考模式/, value: 'enabled' },
        { type: 'confirm', message: /确认配置/, value: true },
      ],
    });

    assert.strictEqual(result.model, 'kimi-k2.6');
    assert.deepStrictEqual(result.providers.kimi.customModels, ['kimi-other']);
    assert.deepStrictEqual(saved, result);
  });

  passed += await check('wizard cancel in custom model management does not rewrite config', async () => {
    const existing = {
      activeProvider: 'deepseek',
      thinking: 'enabled',
      effort: 'max',
      providers: {
        deepseek: { apiKey: 'sk-deepseek', model: 'ds-old', customModels: ['ds-old'] },
      },
    };
    const initialFile = { untouched: true };
    const { result, saved } = await runWizard({
      existing,
      initialFile,
      script: [
        { type: 'select', message: /选择 Provider/, value: 'deepseek' },
        { type: 'text', message: /API Key/, value: 'sk-deepseek' },
        { type: 'select', message: /选择模型/, labelIncludes: '管理自定义模型' },
        { type: 'select', message: /管理自定义模型/, cancel: true },
      ],
    });

    assert.strictEqual(result, null);
    assert.deepStrictEqual(saved, initialFile);
  });

  console.log(`\nConfig wizard flow tests: ${passed} passed, 0 failed`);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
