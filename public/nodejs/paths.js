/**
 * 共享路径解析 —— 所有模块通过这里获取可写数据目录
 *
 * 在 nodejs-mobile 环境里，app.datadir() 返回 App 私有目录
 * （/data/data/com.hermes.memo/files/），这是唯一可靠的可写路径。
 * Node 项目目录（capawesome_nodejs/nodejs-project/）可能在 App 更新时被覆盖。
 */

const path = require('path')

let _dataDir = null

function getDataDir() {
  if (_dataDir) return _dataDir
  // 尝试从 bridge 模块获取 App 数据目录
  try {
    const bridge = require('bridge')
    if (bridge.app && bridge.app.datadir) {
      _dataDir = path.join(bridge.app.datadir(), 'data')
    }
  } catch (e) {
    // 非 nodejs-mobile 环境（桌面调试）
  }
  if (!_dataDir) {
    _dataDir = path.resolve('data')
  }
  return _dataDir
}

function getSkillsDir() {
  return path.join(getDataDir(), 'skills')
}

function getExportsDir() {
  return path.join(getDataDir(), 'exports')
}

module.exports = { getDataDir, getSkillsDir, getExportsDir }
