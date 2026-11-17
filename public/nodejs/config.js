/**
 * LLM 配置
 *
 * 在移动端，apiKey / baseURL / model 从 WebView 通过 bridge 传入
 * （用户在 App 设置面板填），不用环境变量。
 * Node runtime 内 process.env 没有用户配置的 Key。
 *
 * 配置必须落盘：Node runtime 每次启动都是全新进程，只放内存会导致
 * "关掉 App 再打开配置就丢了"（Key 变空 → Missing credentials）。
 * 落盘位置：DATA_DIR/llm-config.json，Key 做 base64 混淆（防一眼看清）。
 */

const path = require('path');
const fs = require('fs');
const { getDataDir } = require('./paths.js');

const CONFIG_FILE = path.join(getDataDir(), 'llm-config.json');

let _config = {
  // 智谱当前长期免费文本模型（输入输出 0 元，200K 上下文）
  // glm-4-flash / glm-4.5-flash 已下线，别再当默认值
  model: 'nvidia/nemotron-3.5-super-vl:free',
  baseURL: 'https://openrouter.ai/api/v1',
  // 不内置任何 Key：用户在设置面板填写，由 bridge config.set 注入
  apiKey: '',
  temperature: 0,
};

/** Key 做 base64 混淆（不是加密，仅防配置文件被一眼读到明文） */
function encodeKey(k) {
  return k ? Buffer.from(String(k), 'utf8').toString('base64') : '';
}
function decodeKey(v) {
  if (!v) return '';
  try {
    return Buffer.from(String(v), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** 从磁盘恢复配置（模块加载时调用一次） */
function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      if (j.apiKey) _config.apiKey = decodeKey(j.apiKey);
      if (j.baseURL) _config.baseURL = j.baseURL;
      if (j.model) _config.model = j.model;
      if (typeof j.temperature === 'number') _config.temperature = j.temperature;
      console.log('[config] 已从磁盘恢复配置:', CONFIG_FILE,
        '| key:', _config.apiKey ? '已配置' : '空',
        '| model:', _config.model);
    }
  } catch (e) {
    // 首次运行没有文件，正常
    if (e && e.code !== 'ENOENT') {
      console.warn('[config] 读取配置失败:', e.message);
    }
  }
}

/** 写盘（同步写，避免 App 被立刻杀死时丢配置） */
function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const data = {
      apiKey: encodeKey(_config.apiKey),
      baseURL: _config.baseURL,
      model: _config.model,
      temperature: _config.temperature,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[config] 保存配置失败:', e && e.message);
    return false;
  }
}

/** 规范化 Key：去空白、去误粘贴的 "Bearer " 前缀 */
function normalizeKey(k) {
  if (typeof k !== 'string') return '';
  return k.trim().replace(/^Bearer\s+/i, '');
}

/**
 * 设置 LLM 配置（由 bridge config.set 调用）
 *
 * 同时兼容两套字段名：
 *   前端 node-bridge 传 apiKey / baseURL / model
 *   旧版前端传 apiKey1 / apiKey2 / apiBase / modelName
 *
 * ⚠️ 这里必须做字段名兼容。历史上 setConfig 只认 apiKey/baseURL/model，
 * 而前端传的是 apiKey1/apiBase/modelName，结果 Key 被 if (opts.apiKey) 静默
 * 丢弃，apiKey 一直是空串 → ChatOpenAI 构造时抛
 * "Missing credentials. Please pass an `apiKey`..."，
 * 看起来像"模型不支持 JSON 输出"，实际根本没发出请求。
 *
 * @param {object} opts { apiKey|apiKey1|apiKey2, baseURL|apiBase, model|modelName, temperature? }
 */
function setConfig(opts) {
  if (!opts) return;

  const before = JSON.stringify({ ..._config, apiKey: !!_config.apiKey });

  // Key：空值默认不覆盖已有 Key。
  // App 启动时前端可能还没从本地库恢复配置就 sync 一次（值为空），
  // 若无条件覆盖，就会把磁盘里存好的 Key 冲成空 —— 这正是"重启后配置丢了"。
  // 确需清空时显式传 allowEmptyKey: true。
  const hasKeyField = 'apiKey' in opts || 'apiKey1' in opts || 'apiKey2' in opts;
  if (hasKeyField) {
    const next = normalizeKey(opts.apiKey || opts.apiKey1 || opts.apiKey2 || '');
    if (next) {
      _config.apiKey = next;
    } else if (opts.allowEmptyKey === true) {
      _config.apiKey = '';
    } else if (_config.apiKey) {
      console.log('[config] 收到空 Key，保留已保存的 Key（如需清空请传 allowEmptyKey:true）');
    }
  }

  // 地址 / 模型：空值不覆盖，避免把默认值清掉
  const baseURL = opts.baseURL || opts.apiBase;
  if (baseURL) _config.baseURL = baseURL;

  const model = opts.model || opts.modelName;
  if (model) _config.model = model;

  if (typeof opts.temperature === 'number') _config.temperature = opts.temperature;

  // 只在配置真的变了才写盘
  const after = JSON.stringify({ ..._config, apiKey: !!_config.apiKey });
  if (before !== after) {
    saveToDisk();
    console.log('[config] 配置已更新并落盘:', CONFIG_FILE);
  }
}

/**
 * 获取当前配置
 */
function getConfig() {
  return { ..._config };
}

/** 配置文件路径（排查用） */
function getConfigFile() {
  return CONFIG_FILE;
}

/**
 * 创建 ChatOpenAI 模型实例
 * 从 vendor.bundle.js 获取 ChatOpenAI（已打包）
 */
async function createModel() {
  // 提前拦住"没配 Key"的情况，给一条人能看懂的错，
  // 而不是让 ChatOpenAI 抛 Missing credentials（会被误读成模型能力问题）
  if (!_config.apiKey) {
    throw new Error('未配置 API Key，请到 ⚙️ 设置面板填写后重试');
  }
  const vendor = require('./vendor.bundle.js');
  return new vendor.ChatOpenAI({
    model: _config.model,
    temperature: _config.temperature,
    configuration: {
      baseURL: _config.baseURL,
      apiKey: _config.apiKey,
    },
  });
}

/**
 * 获取模型实例（异步，返回 Promise<ChatOpenAI>）
 *
 * ⚠️ 调用方必须 await：
 *   const model = await getModel();     // ✅
 *   const model = getModel();           // ❌ 拿到的是 Promise，调用 model.invoke 会报
 *                                       //    "model.invoke is not a function"
 *
 * 首次调用时创建实例并缓存；并发调用共享同一个初始化 Promise，避免重复创建。
 */
let _model = null;
let _modelPromise = null;
async function getModel() {
  if (_model) return _model;
  if (!_modelPromise) {
    _modelPromise = createModel().then(
      (m) => {
        _model = m;
        return m;
      },
      (e) => {
        // 初始化失败时清空，允许下次重试
        _modelPromise = null;
        throw e;
      }
    );
  }
  return _modelPromise;
}

/** 重置缓存的模型（配置变更后调用） */
function resetModel() {
  _model = null;
  _modelPromise = null;
}

// 模块加载即恢复磁盘配置：Node runtime 每次启动都是新进程，
// 不在这里恢复的话，重启后 API Key 一定是空的
loadFromDisk();

module.exports = {
  setConfig, getConfig, getConfigFile,
  createModel, getModel, resetModel,
  loadFromDisk, saveToDisk,
};