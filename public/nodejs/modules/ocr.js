/**
 * OCR (Optical Character Recognition) 基座模块
 *
 * 后端：智谱 GLM 视觉模型 OCR（免费档）
 *   - 默认 glm-4.6v-flash（128K，当前免费视觉档）
 *   - 兜底 glm-4v-flash（旧版 16K，仍在免费档，作为回退）
 * 也支持 mock 后端（测试用）
 *
 * 在移动端，apiKey 由 WebView 通过 bridge 传入。
 */

const DEFAULT_VISION_MODEL = 'glm-4.6v-flash';
const LEGACY_VISION_MODEL = 'glm-4v-flash';

/**
 * 通用 base64 图片识别
 * @param {string} dataUrl data:image/xxx;base64,... 或纯 base64
 * @param {string} apiKey 智谱 API Key
 * @param {string} [model] 模型名，默认 glm-4.6v-flash
 * @param {string} [language] 语言提示 zh/en
 */
async function recognizeBase64(dataUrl, apiKey, model = DEFAULT_VISION_MODEL, language) {
  const apiUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

  const langHint = language
    ? `请只识别图片中的${language === 'zh' ? '中文' : language === 'en' ? '英文' : '文字'}，直接返回识别到的文字内容，不要加任何解释。`
    : '请识别图片中的所有文字，直接返回文字内容，不要加任何解释。如果图片中没有文字，返回空。';

  const callOnce = async (modelName) => {
    const body = {
      model: modelName,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: langHint },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0,
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`智谱 OCR API 错误 ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  };

  let text = await callOnce(model);

  // 兜底：新视觉模型对纯 OCR 可能返回空（思考型输出），退回旧版 glm-4v-flash 再试一次
  if (!text && model !== LEGACY_VISION_MODEL) {
    try {
      text = await callOnce(LEGACY_VISION_MODEL);
    } catch (e) {
      console.warn('[ocr] 兜底模型 glm-4v-flash 调用失败:', e && e.message);
    }
  }

  return { text, confidence: 0.9 };
}

/**
 * 智谱 GLM 视觉模型 OCR 后端
 */
function createZhipuOCRBackend(opts) {
  const model = opts.model || DEFAULT_VISION_MODEL;

  return {
    name: 'zhipu-' + model,
    async recognize(imagePath, options) {
      const fs = require('fs');
      const path = require('path');

      const buf = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
      };
      const mime = mimeMap[ext] || 'image/png';
      const base64 = buf.toString('base64');
      const dataUrl = `data:${mime};base64,${base64}`;

      return recognizeBase64(dataUrl, opts.apiKey, model, options && options.language);
    },
  };
}

/** 本地 mock 后端 */
function createMockOCRBackend(mockTexts = ['图片中的文字内容']) {
  let idx = 0;
  return {
    name: 'mock',
    async recognize() {
      const text = mockTexts[idx % mockTexts.length];
      idx++;
      return { text, confidence: 1.0 };
    },
  };
}

// ════════════════════════════════════
// 默认实例
// ════════════════════════════════════
let defaultBackend = createMockOCRBackend();

function setOCRBackend(backend) {
  defaultBackend = backend;
}

function getOCRBackend() {
  return defaultBackend;
}

async function recognize(imagePath) {
  return defaultBackend.recognize(imagePath);
}

module.exports = {
  recognizeBase64,
  createZhipuOCRBackend,
  createMockOCRBackend,
  setOCRBackend,
  getOCRBackend,
  recognize,
};