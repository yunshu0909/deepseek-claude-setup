/**
 * 模型选项管理模块
 *
 * 负责：
 * - 构造配置向导的内置模型 / 自定义模型选项
 * - 维护 provider 级 customModels 的增删改纯函数
 * - 保护 adapter 内置模型不被用户自定义 CRUD 修改
 *
 * @module src/model-options
 */

const CUSTOM_MODEL_ADD_OPTION = '__deepseek_claude_add_custom_model__';
const CUSTOM_MODEL_MANAGE_OPTION = '__deepseek_claude_manage_custom_models__';
const CUSTOM_MODEL_RETURN_OPTION = '__deepseek_claude_return_model_select__';
const CUSTOM_MODEL_RENAME_PREFIX = '__deepseek_claude_rename_custom_model__:';
const CUSTOM_MODEL_DELETE_PREFIX = '__deepseek_claude_delete_custom_model__:';
const CUSTOM_MODEL_OPTION = CUSTOM_MODEL_ADD_OPTION;

function normalizeModelId(model) {
  return typeof model === 'string' ? model.trim() : '';
}

function normalizeCustomModels(models) {
  const seen = new Set();
  const result = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = normalizeModelId(model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function providerModelIds(provider) {
  const ids = new Set((Array.isArray(provider?.models) ? provider.models : [])
    .map(model => normalizeModelId(model?.id))
    .filter(Boolean));
  const defaultModel = normalizeModelId(provider?.defaultModel);
  if (defaultModel) ids.add(defaultModel);
  return ids;
}

function optionHint(...parts) {
  const seen = new Set();
  return parts
    .map(part => normalizeModelId(part))
    .filter(part => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join(' / ');
}

function builtInModelOptions(provider, currentModel = '') {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  const current = normalizeModelId(currentModel);
  const defaultModel = normalizeModelId(provider?.defaultModel);
  const seen = new Set();
  const options = [];

  for (const model of models) {
    const id = normalizeModelId(model?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      value: id,
      label: `内置：${model.label || id}`,
      hint: optionHint(id === current ? '当前' : '', id === defaultModel ? '默认' : '', model.hint),
    });
  }

  if (defaultModel && !seen.has(defaultModel)) {
    options.push({
      value: defaultModel,
      label: `内置：${defaultModel}`,
      hint: optionHint(defaultModel === current ? '当前' : '', '默认'),
    });
  }

  return options;
}

function customModelsForProvider(provider, existing, customModels = []) {
  const builtIns = providerModelIds(provider);
  return normalizeCustomModels([existing, ...customModels])
    .filter(model => !builtIns.has(model));
}

/**
 * 构造模型选择列表
 * @param {object} provider - 当前 provider 定义
 * @param {string} existing - 当前已保存模型
 * @param {string[]} customModels - 当前 provider 已保存的自定义模型
 * @returns {Array<{value: string, label: string, hint?: string}>}
 */
function buildModelOptions(provider, existing, customModels = []) {
  const existingModel = normalizeModelId(existing);
  const savedCustomModels = customModelsForProvider(provider, existingModel, customModels);
  const options = builtInModelOptions(provider, existingModel);

  for (const model of savedCustomModels) {
    options.push({
      value: model,
      label: model === existingModel
        ? `继续使用当前自定义模型：${model}`
        : `自定义：${model}`,
      hint: model === existingModel ? '当前 / 已保存' : '已保存',
    });
  }

  options.push({
    value: CUSTOM_MODEL_ADD_OPTION,
    label: '新增自定义模型',
    hint: '新模型/未内置模型',
  });

  if (savedCustomModels.length) {
    options.push({
      value: CUSTOM_MODEL_MANAGE_OPTION,
      label: '管理自定义模型',
      hint: '编辑/删除已保存模型',
    });
  }

  return options;
}

function buildManageModelOptions(provider, existing, customModels = []) {
  const savedCustomModels = customModelsForProvider(provider, existing, customModels);
  const options = [];
  savedCustomModels.forEach((model, index) => {
    options.push({
      value: `${CUSTOM_MODEL_RENAME_PREFIX}${index}`,
      label: `修改自定义模型：${model}`,
      hint: '仅修改用户自定义模型',
    });
  });
  savedCustomModels.forEach((model, index) => {
    options.push({
      value: `${CUSTOM_MODEL_DELETE_PREFIX}${index}`,
      label: `删除自定义模型：${model}`,
      hint: model === normalizeModelId(existing) ? '当前模型，删除前需选择替代模型' : '从已保存列表移除',
    });
  });
  options.push({ value: CUSTOM_MODEL_RETURN_OPTION, label: '返回模型选择' });
  return options;
}

function parseManageModelAction(provider, existing, customModels, value) {
  const savedCustomModels = customModelsForProvider(provider, existing, customModels);
  if (value === CUSTOM_MODEL_RETURN_OPTION) return { type: 'return' };
  if (typeof value !== 'string') return { type: 'unknown' };
  if (value.startsWith(CUSTOM_MODEL_RENAME_PREFIX)) {
    const index = Number(value.slice(CUSTOM_MODEL_RENAME_PREFIX.length));
    return { type: 'rename', model: savedCustomModels[index] };
  }
  if (value.startsWith(CUSTOM_MODEL_DELETE_PREFIX)) {
    const index = Number(value.slice(CUSTOM_MODEL_DELETE_PREFIX.length));
    return { type: 'delete', model: savedCustomModels[index] };
  }
  return { type: 'unknown' };
}

function addCustomModel(provider, customModels, model) {
  const modelId = normalizeModelId(model);
  if (!modelId || providerModelIds(provider).has(modelId)) return normalizeCustomModels(customModels);
  return normalizeCustomModels([modelId, ...customModels]);
}

function renameCustomModel(provider, customModels, oldModel, newModel, currentModel) {
  const oldId = normalizeModelId(oldModel);
  const newId = normalizeModelId(newModel);
  const current = normalizeModelId(currentModel);
  const builtIns = providerModelIds(provider);
  const source = normalizeCustomModels(customModels);

  if (!oldId || !newId || builtIns.has(oldId) || !source.includes(oldId)) {
    return { model: current, customModels: source };
  }

  const next = source.flatMap(model => {
    if (model !== oldId) return [model];
    return builtIns.has(newId) ? [] : [newId];
  });

  return {
    model: current === oldId ? newId : current,
    customModels: normalizeCustomModels(next),
  };
}

function buildReplacementModelOptions(provider, customModels, deletingModel) {
  const deletingId = normalizeModelId(deletingModel);
  const options = builtInModelOptions(provider).filter(option => option.value !== deletingId);
  const builtIns = providerModelIds(provider);
  for (const model of normalizeCustomModels(customModels)) {
    if (model === deletingId || builtIns.has(model)) continue;
    options.push({ value: model, label: `自定义：${model}`, hint: '已保存' });
  }
  return options;
}

function resolveReplacementModel(provider, customModels, deletingModel, replacementModel) {
  const replacement = normalizeModelId(replacementModel);
  if (!replacement || replacement === normalizeModelId(deletingModel)) return '';
  const validIds = new Set(buildReplacementModelOptions(provider, customModels, deletingModel).map(option => option.value));
  return validIds.has(replacement) ? replacement : '';
}

function deleteCustomModel(provider, customModels, modelToDelete, currentModel, replacementModel) {
  const deleteId = normalizeModelId(modelToDelete);
  const current = normalizeModelId(currentModel);
  const builtIns = providerModelIds(provider);
  const source = normalizeCustomModels(customModels);

  if (!deleteId || builtIns.has(deleteId) || !source.includes(deleteId)) {
    return { model: current, customModels: source };
  }

  let nextModel = current;
  if (current === deleteId) {
    nextModel = resolveReplacementModel(provider, source, deleteId, replacementModel);
    if (!nextModel) return { model: current, customModels: source };
  }

  return {
    model: nextModel,
    customModels: source.filter(model => model !== deleteId),
  };
}

function initialModelSelection(provider, existing) {
  return normalizeModelId(existing)
    || normalizeModelId(provider?.defaultModel)
    || normalizeModelId(provider?.models?.[0]?.id)
    || CUSTOM_MODEL_ADD_OPTION;
}

module.exports = {
  CUSTOM_MODEL_OPTION,
  CUSTOM_MODEL_ADD_OPTION,
  CUSTOM_MODEL_MANAGE_OPTION,
  CUSTOM_MODEL_RETURN_OPTION,
  addCustomModel,
  buildManageModelOptions,
  buildModelOptions,
  buildReplacementModelOptions,
  customModelsForProvider,
  deleteCustomModel,
  initialModelSelection,
  normalizeCustomModels,
  normalizeModelId,
  parseManageModelAction,
  providerModelIds,
  renameCustomModel,
  resolveReplacementModel,
};
