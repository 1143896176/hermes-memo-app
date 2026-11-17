<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Field, CellGroup, Button } from 'vant'
import {
  getApiConfig, setApiConfig, initEngine,
  DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_ASR_MODEL, DEFAULT_ASR_BASE, LEGACY_TEXT_MODELS,
} from '../services/engine'
import { syncApiConfigToNode, isNativeEnv, getDraftSchema, setDraftSchema } from '../services/node-bridge'
import { invalidateAgent } from '../services/agent'

const FREE_TEXT_MODELS = ['nvidia/nemotron-3.5-super-vl:free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free']
const FREE_VISION_MODELS = ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash']

const apiKey1 = ref('')
const apiKey2 = ref('')
const apiBase = ref('https://openrouter.ai/api/v1')
const modelName = ref(DEFAULT_TEXT_MODEL)
const ocrKey = ref('')
const ocrModel = ref(DEFAULT_VISION_MODEL)
const asrKey = ref('')
const asrBase = ref(DEFAULT_ASR_BASE)
const saved = ref(false)
const isNative = ref(false)

const schemaText = ref('')
const schemaMsg = ref('')
const schemaMsgOk = ref(false)
const schemaPath = ref('')
const schemaBrowserMode = ref(false)

// 用独立标记判断成功/失败，避免依赖消息文本里的 emoji 前缀
const schemaMsgType = computed(() => {
  if (!schemaMsg.value) return ''
  return schemaMsgOk.value ? 'ok' : 'err'
})

async function loadSchema() {
  try {
    const s = await getDraftSchema()
    schemaBrowserMode.value = !!s.browserMode
    schemaPath.value = s.path || ''
    schemaText.value = JSON.stringify(s.fields && s.fields.length ? s.fields : (s.defaultFields || []), null, 2)
  } catch (e: any) {
    schemaMsgOk.value = false
    schemaMsg.value = '读取字段配置失败：' + (e?.message || e)
  }
}

async function saveSchema() {
  schemaMsg.value = ''
  try {
    const t = schemaText.value.trim()
    const arr = t ? JSON.parse(t) : null
    const r: any = await setDraftSchema(arr)
    if (r && r.ok === false) {
      schemaMsgOk.value = false
      schemaMsg.value = '保存失败：' + (r.error || '未知错误')
      return
    }
    if (r && Array.isArray(r.fields)) schemaText.value = JSON.stringify(r.fields, null, 2)
    schemaMsgOk.value = true
    schemaMsg.value = '已保存，下次生成草稿生效'
    invalidateAgent()
  } catch (e: any) {
    schemaMsgOk.value = false
    schemaMsg.value = e instanceof SyntaxError ? 'JSON 格式有误：' + e.message : (e?.message || '保存失败')
  }
}

async function resetSchema() {
  schemaMsg.value = ''
  try {
    const r: any = await setDraftSchema(null)
    if (r && Array.isArray(r.fields)) schemaText.value = JSON.stringify(r.fields, null, 2)
    schemaMsgOk.value = true
    schemaMsg.value = '已恢复默认字段'
  } catch (e: any) {
    schemaMsgOk.value = false
    schemaMsg.value = e?.message || '恢复失败'
  }
}

onMounted(async () => {
  isNative.value = isNativeEnv()
  try { await initEngine() } catch (e) { console.warn('[settings] 本地库未就绪:', e) }
  const cfg = getApiConfig()
  let needSave = false
  const config = {
    apiKey1: cfg.apiKey1 || '', apiKey2: cfg.apiKey2 || '',
    apiBase: cfg.apiBase || 'https://openrouter.ai/api/v1',
    modelName: cfg.modelName || DEFAULT_TEXT_MODEL,
    ocrKey: cfg.ocrKey || '', ocrModel: cfg.ocrModel || DEFAULT_VISION_MODEL,
    asrKey: cfg.asrKey || '', asrBase: cfg.asrBase || DEFAULT_ASR_BASE,
  }
  if (LEGACY_TEXT_MODELS.includes(config.modelName)) { config.modelName = DEFAULT_TEXT_MODEL; needSave = true }
  if (needSave) setApiConfig(config)
  await syncApiConfigToNode(config)
  invalidateAgent()
  apiKey1.value = config.apiKey1; apiKey2.value = config.apiKey2
  apiBase.value = config.apiBase; modelName.value = config.modelName
  ocrKey.value = config.ocrKey; ocrModel.value = config.ocrModel
  asrKey.value = config.asrKey; asrBase.value = config.asrBase
  await loadSchema()
})

async function save() {
  const config = {
    apiKey1: apiKey1.value, apiKey2: apiKey2.value, apiBase: apiBase.value,
    modelName: modelName.value, ocrKey: ocrKey.value, ocrModel: ocrModel.value,
    asrKey: asrKey.value, asrBase: asrBase.value,
  }
  setApiConfig(config)
  await syncApiConfigToNode(config)
  invalidateAgent()
  saved.value = true
  setTimeout(() => saved.value = false, 2000)
}
</script>

<template>
  <div class="settings-panel">
    <p class="desc">
      LLM 用于草稿生成，OCR 用于图片识别。Key 存本地，不上传。
      <span v-if="isNative" class="native-badge"><van-icon name="passed" size="11" /> Node 运行时已激活</span>
      <span v-else class="browser-badge"><van-icon name="warning" size="11" /> 浏览器预览模式</span>
    </p>

    <van-cell-group inset>
      <van-field v-model="apiKey1" type="password" label="LLM Key" placeholder="OpenRouter Key: openrouter.ai/keys" />
      <van-field v-model="apiKey2" type="password" label="备用 Key" placeholder="留空则只用主 Key" />
      <van-field v-model="apiBase" label="LLM 地址" placeholder="https://api.openai.com/v1" />
      <van-field v-model="modelName" label="文本模型" placeholder="nvidia/nemotron-3.5-super-vl:free" />
      <van-field v-model="ocrKey" type="password" label="OCR Key" placeholder="用于图片 OCR" />
      <van-field v-model="ocrModel" label="视觉模型" placeholder="glm-4.6v-flash" />
    </van-cell-group>

    <van-cell-group inset>
      <van-field v-model="asrKey" type="password" label="ASR Key" placeholder="在 console.groq.com 创建，无需实名" />
      <van-field v-model="asrBase" label="ASR 地址" placeholder="https://api.groq.com/openai/v1" />
    </van-cell-group>

    <div class="save-wrap">
      <van-button block type="primary" :icon="saved ? 'success' : 'passed'" @click="save">{{ saved ? '已保存' : '保存' }}</van-button>
    </div>

    <h4 class="section-title">草稿字段（结构化输出）</h4>
    <p class="desc">模型按这里的字段返回 JSON。<span v-if="schemaBrowserMode" class="browser-badge">需 APK 内配置</span></p>
    <textarea v-model="schemaText" class="schema-editor" rows="10" spellcheck="false" :disabled="schemaBrowserMode" placeholder='[{"key":"title","type":"string","desc":"标题","required":true}]' />
    <p class="schema-hint">type 支持 string/array；required: true 表示必填。<span v-if="schemaPath">配置文件：{{ schemaPath }}</span></p>
    <div class="schema-actions">
      <van-button size="small" type="primary" icon="passed" @click="saveSchema" :disabled="schemaBrowserMode">保存字段</van-button>
      <van-button size="small" icon="replay" @click="resetSchema" :disabled="schemaBrowserMode">恢复默认</van-button>
    </div>
    <p v-if="schemaMsg" class="schema-msg" :class="schemaMsgType">
      <van-icon :name="schemaMsgType === 'ok' ? 'passed' : 'warning-o'" size="12" />
      {{ schemaMsg }}
    </p>
  </div>
</template>

<style scoped>
.settings-panel { padding: 16px; }
.desc { font-size: 12px; color: #888; margin-bottom: 14px; line-height: 1.5; }
.native-badge, .browser-badge { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.native-badge { background: #e8f5e9; color: #2e7d32; }
.browser-badge { background: #fff3cd; color: #b26a00; }
.save-wrap { margin: 12px 0; }
.section-title { font-size: 13px; font-weight: 700; color: #444; margin: 16px 0 6px; }
.schema-editor { display: block; width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 12px; font-family: monospace; line-height: 1.5; background: #fafafa; color: #333; resize: none; min-height: 140px; max-height: 40vh; }
.schema-editor:disabled { opacity: .6; }
.schema-hint { font-size: 11px; color: #999; margin-top: 6px; line-height: 1.6; }
.schema-actions { display: flex; gap: 8px; margin-top: 10px; }
.schema-msg { font-size: 12px; margin-top: 10px; padding: 8px 10px; border-radius: 6px; line-height: 1.5; }
.schema-msg .van-icon { vertical-align: -2px; margin-right: 2px; }
.schema-msg.ok { color: #2e7d32; background: #e8f5e9; }
.schema-msg.err { color: #c62828; background: #fdecea; }
</style>