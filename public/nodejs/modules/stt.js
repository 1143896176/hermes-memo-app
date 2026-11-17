/**
 * STT (Speech-to-Text) 基座模块
 *
 * 设计原则：
 * - 统一接口，多种后端可插拔
 * - 不绑定具体产品或 UI
 * - 返回结构化结果（文本 + 置信度）
 *
 * 后端实现：
 * - whisper-local: 本地 whisper.cpp（离线、免费）
 * - whisper-api: OpenAI Whisper API（精度高）
 * - browser: Web SpeechRecognition API（WebView 直用）
 */

/** 本地 mock 后端（测试用，返回占位文本） */
function createMockSTTBackend(mockTexts = ['这是一条语音识别测试文本']) {
  let idx = 0;
  return {
    name: 'mock',
    async transcribe() {
      const text = mockTexts[idx % mockTexts.length];
      idx++;
      return { text, confidence: 1.0 };
    },
  };
}

/** OpenAI Whisper API 后端 */
function createWhisperAPIBackend(opts) {
  return {
    name: 'whisper-api',
    async transcribe() {
      throw new Error(
        'Whisper API 后端未实现。在移动端建议使用 WebView SpeechRecognition API 或本地 whisper.cpp。'
      );
    },
  };
}

// ════════════════════════════════════
// 默认实例
// ════════════════════════════════════
let defaultBackend = createMockSTTBackend();

function setSTTBackend(backend) {
  defaultBackend = backend;
}

function getSTTBackend() {
  return defaultBackend;
}

async function transcribe(audioPath) {
  return defaultBackend.transcribe(audioPath);
}

module.exports = {
  createMockSTTBackend,
  createWhisperAPIBackend,
  setSTTBackend,
  getSTTBackend,
  transcribe,
};