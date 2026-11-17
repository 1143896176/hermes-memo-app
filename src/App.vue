<script setup lang="ts">
import { ref } from 'vue'
import MemoList from './components/MemoList.vue'
import MemoInput from './components/MemoInput.vue'
import DraftCard from './components/DraftCard.vue'
import GlossaryPanel from './components/GlossaryPanel.vue'
import ExportPanel from './components/ExportPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import MemoryPanel from './components/MemoryPanel.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import AgentChat from './components/AgentChat.vue'
import { createDraft, confirmDraft, reviseDraft, type DraftResult } from './services/api'
import { syncApiConfigToNode, isNativeEnv, waitForNode } from './services/node-bridge'
import { loadNodejsPluginSync } from './services/node-bridge'
import { getApiConfig, setApiConfig, initEngine, DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, LEGACY_TEXT_MODELS } from './services/engine'
import { invalidateAgent } from './services/agent'

type MainTab = 'memos' | 'agent'
const mainTab = ref<MainTab>('memos')
function switchTab(t: MainTab) {
  if (t === 'memos' && mainTab.value === 'agent') refreshKey.value++
  mainTab.value = t
}
const showInput = ref(false)
const showSettings = ref(false)
const settingsPanel = ref<'glossary' | 'export' | 'settings' | 'memory' | 'knowledge' | null>(null)
const draft = ref<DraftResult | null>(null)
const draftLoading = ref(false)
const draftSaving = ref(false)
const refreshKey = ref(0)
const errorMsg = ref('')

loadNodejsPluginSync()
;(async () => {
  try { await initEngine() } catch (e) { console.warn('[app] init:', e) }
  const cfg = getApiConfig()
  const defaultConfig = {
    apiKey1: cfg.apiKey1 || '', apiKey2: cfg.apiKey2,
    apiBase: cfg.apiBase || 'https://open.bigmodel.cn/api/paas/v4',
    modelName: cfg.modelName || DEFAULT_TEXT_MODEL,
    ocrKey: cfg.ocrKey || '', ocrModel: cfg.ocrModel || DEFAULT_VISION_MODEL,
  }
  let needSave = false
  if (LEGACY_TEXT_MODELS.includes(defaultConfig.modelName)) { defaultConfig.modelName = DEFAULT_TEXT_MODEL; needSave = true }
  if (needSave) setApiConfig(defaultConfig)
  if (isNativeEnv()) { await waitForNode(15000); await syncApiConfigToNode(defaultConfig) }
  invalidateAgent()
})()

async function onTextSubmit(text: string) {
  draftLoading.value = true; errorMsg.value = ''
  try {
    const result = await createDraft(text)
    if (!result.draft.title && !result.draft.content) errorMsg.value = '生成失败：请在 API 设置中填写 Key'
    else draft.value = result
  } catch (e: any) { errorMsg.value = e?.message || '网络错误' }
  finally { draftLoading.value = false }
}
async function onConfirm() {
  if (!draft.value) return
  draftSaving.value = true; errorMsg.value = ''
  try { await confirmDraft(draft.value); draft.value = null; showInput.value = false; refreshKey.value++ }
  catch { errorMsg.value = '保存失败' }
  finally { draftSaving.value = false }
}
async function onRevise(newText: string) {
  if (!draft.value) return
  draftLoading.value = true; errorMsg.value = ''
  try {
    const result = await reviseDraft(draft.value.rawText, newText)
    if (!result.draft.title && !result.draft.content) errorMsg.value = '重新生成失败'
    else draft.value = result
  } catch { errorMsg.value = '重新生成失败' }
  finally { draftLoading.value = false }
}
function onCancel() { draft.value = null }
function openSettings(panel: 'glossary' | 'export' | 'settings' | 'memory' | 'knowledge') { showSettings.value = false; settingsPanel.value = panel }
function closeSettings() { settingsPanel.value = null }
function onSettingsBlur() { setTimeout(() => { showSettings.value = false }, 200) }
</script>

<template>
  <div class="app">
    <header>
      <h1>📝 智能备忘录</h1>
      <div class="header-actions">
        <button class="settings-btn" @click="showSettings = !showSettings" @blur="onSettingsBlur">⚙️</button>
        <div v-if="showSettings" class="settings-dropdown">
          <button @mousedown.prevent="openSettings('settings')">🔑 API 设置</button>
          <button @mousedown.prevent="openSettings('glossary')">📖 术语词典</button>
          <button @mousedown.prevent="openSettings('memory')">🧠 记忆 / 技能</button>
          <button @mousedown.prevent="openSettings('knowledge')">📚 知识库</button>
          <button @mousedown.prevent="openSettings('export')">📦 导出分享</button>
        </div>
      </div>
    </header>

    <main>
      <div v-if="settingsPanel" class="overlay" @click.self="closeSettings">
        <div class="overlay-panel">
          <div class="overlay-head">
            <span>{{ settingsPanel === 'settings' ? '🔑 API 设置' : settingsPanel === 'glossary' ? '📖 术语词典' : settingsPanel === 'memory' ? '🧠 记忆 / 技能' : settingsPanel === 'knowledge' ? '📚 知识库' : '📦 导出分享' }}</span>
            <button class="close-btn" @click="closeSettings">✕</button>
          </div>
          <SettingsPanel v-if="settingsPanel === 'settings'" />
          <GlossaryPanel v-if="settingsPanel === 'glossary'" />
          <MemoryPanel v-if="settingsPanel === 'memory'" />
          <KnowledgePanel v-if="settingsPanel === 'knowledge'" />
          <ExportPanel v-if="settingsPanel === 'export'" @imported="refreshKey++" />
        </div>
      </div>

      <div class="main-tabs">
        <button :class="{ sel: mainTab === 'memos' }" @click="switchTab('memos')">📋 备忘录</button>
        <button :class="{ sel: mainTab === 'agent' }" @click="switchTab('agent')">🤖 Agent 对话</button>
      </div>

      <template v-if="mainTab === 'memos'">
        <div v-if="draftLoading && !draft" class="loading-bar"><span class="spinner" /> AI 正在解析备忘...</div>
        <div v-if="errorMsg" class="error-bar" @click="errorMsg = ''">{{ errorMsg }}</div>
        <DraftCard v-if="draft" :draft="draft" :loading="draftLoading" :saving="draftSaving" @confirm="onConfirm" @revise="onRevise" @cancel="onCancel" />
        <div v-if="showInput" class="input-overlay" @click.self="showInput = false">
          <div class="input-panel"><MemoInput @submit="onTextSubmit" /><button class="close-input" @click="showInput = false">取消</button></div>
        </div>
        <MemoList :key="refreshKey" />
      </template>
      <template v-else><AgentChat /></template>
    </main>

    <button v-if="!showInput && mainTab === 'memos'" class="fab" @click="showInput = true">＋</button>
  </div>
</template>

<style>
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --header-h: calc(54px + var(--safe-top));
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
.app { width: 100%; min-height: 100vh; background: #fff; position: relative; }
header { background: #4a90d9; color: #fff; padding: 10px 16px; padding-top: calc(10px + var(--safe-top)); display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 20; }
header h1 { font-size: 17px; }
.main-tabs { display: flex; background: #f5f5f5; border-bottom: 1px solid #eee; position: sticky; top: var(--header-h); z-index: 10; }
.main-tabs button { flex: 1; padding: 10px; border: none; background: none; font-size: 14px; color: #666; cursor: pointer; border-bottom: 2px solid transparent; }
.main-tabs button.sel { color: #4a90d9; border-bottom-color: #4a90d9; background: #fff; }
.header-actions { position: relative; }
.settings-btn { width: 34px; height: 34px; border: none; border-radius: 50%; background: rgba(255,255,255,.15); color: #fff; font-size: 17px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.settings-dropdown { position: absolute; top: 40px; right: 0; background: #fff; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,.15); min-width: 140px; overflow: hidden; z-index: 30; }
.settings-dropdown button { display: block; width: 100%; padding: 11px 16px; border: none; background: #fff; font-size: 14px; cursor: pointer; text-align: left; color: #333; }
.settings-dropdown button:hover { background: #f0f4ff; }
.fab { position: fixed; bottom: calc(24px + var(--safe-bottom)); right: 24px; width: 52px; height: 52px; border-radius: 50%; background: #4a90d9; color: #fff; border: none; font-size: 26px; cursor: pointer; box-shadow: 0 4px 16px rgba(74,144,217,.4); z-index: 10; display: flex; align-items: center; justify-content: center; }
.input-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 25; display: flex; align-items: flex-end; justify-content: center; }
.input-panel { width: 100%; max-width: 600px; background: #fff; border-radius: 16px 16px 0 0; padding-bottom: calc(20px + var(--safe-bottom)); animation: slideUp .2s ease-out; }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.close-input { display: block; width: 88%; margin: 0 auto; padding: 10px; border: 1px solid #ddd; border-radius: 10px; background: #fff; font-size: 14px; cursor: pointer; text-align: center; color: #888; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 25; display: flex; align-items: center; justify-content: center; padding: calc(8px + var(--safe-top)) 0 calc(8px + var(--safe-bottom)); }
.overlay-panel { width: 92%; max-width: 480px; max-height: min(100%, 720px); overflow-y: auto; background: #fff; border-radius: 16px; }
.overlay-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #eee; font-size: 15px; font-weight: 600; position: sticky; top: 0; background: #fff; z-index: 1; }
.close-btn { width: 32px; height: 32px; border: none; border-radius: 50%; background: #eee; font-size: 14px; cursor: pointer; color: #666; }
.loading-bar { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 16px; color: #4a90d9; font-size: 14px; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid #ddd; border-top-color: #4a90d9; border-radius: 50%; animation: spin .6s linear infinite; }
.error-bar { margin: 8px 12px; padding: 12px; background: #fff3cd; color: #856404; border-radius: 8px; font-size: 13px; cursor: pointer; text-align: center; }
</style>