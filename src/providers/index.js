/**
 * Provider 注册表入口
 *
 * 负责：
 * - 复用 proxy runtime 中的 provider 定义
 * - 避免 CLI 归一化逻辑与代理运行时维护两份 provider 元数据
 *
 * @module src/providers
 */

module.exports = require('../../proxy/providers');
