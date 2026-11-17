<script setup lang="ts">
import { ref, computed } from 'vue'
import { NavBar, Icon, ActionSheet, Popup, Tabbar, TabbarItem, FloatingBubble } from 'vant'
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

const settingsActions = [
  { name: '🔑 API 设置', value: 'settings' },
  { name: '📖 术语词典', value: 'glossary' },
  { name: '🧠 记忆 / 技能', value: 'memory' },
  { name: '📚 知识库', value: 'knowledge' },
  { name: '📦 导出分享', value: 'export' },
]

function onSelectSettings(item: { name: string; value: string }) {
  openSettings(item.value as 'settings' | 'glossary' | 'memory' | 'knowledge' | 'export')
}

const showSettingsPanel = computed({
  get: () => !!settingsPanel.value,
  set: (val: boolean) => { if (!val) closeSettings() },
})

const panelTitle = computed(() => {
  const map: Record<string, string> = {
    settings: '🔑 API 设置',
    glossary: '📖 术语词典',
    memory: '🧠 记忆 / 技能',
    knowledge: '📚 知识库',
    export: '📦 导出分享',
  }
  return settingsPanel.value ? map[settingsPanel.value] || '' : ''
})
</script>

<template>
  <div class="app">
    <van-nav-bar title="智能备忘录" safe-area-inset-top>
      <template #right>
        <van-icon name="setting-o" size="22" @click="showSettings = true" />
      </template>
    </van-nav-bar>

    <van-action-sheet
      v-model:show="showSettings"
      :actions="settingsActions"
      cancel-text="取消"
      close-on-click-action
      @select="onSelectSettings"
    />

    <van-popup
      v-model:show="showSettingsPanel"
      position="bottom"
      :style="{ height: '85%' }"
      round
      closeable
      close-icon-position="top-left"
    >
      <van-nav-bar :title="panelTitle" @click-left="closeSettings">
        <template #left>
          <van-icon name="arrow-left" @click="closeSettings" />
        </template>
      </van-nav-bar>
      <SettingsPanel v-if="settingsPanel === 'settings'" />
      <GlossaryPanel v-if="settingsPanel === 'glossary'" />
      <MemoryPanel v-if="settingsPanel === 'memory'" />
      <KnowledgePanel v-if="settingsPanel === 'knowledge'" />
      <ExportPanel v-if="settingsPanel === 'export'" @imported="refreshKey++" />
    </van-popup>

    <main>
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

    <van-tabbar v-model="mainTab" @change="switchTab" safe-area-inset-bottom>
      <van-tabbar-item name="memos" icon="notes-o">备忘录</van-tabbar-item>
      <van-tabbar-item name="agent" icon="chat-o">助手</van-tabbar-item>
    </van-tabbar>

    <van-floating-bubble v-if="!showInput && mainTab === 'memos'" icon="plus" @click="showInput = true" />
  </div>
</template>

<style>
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
.app { width: 100%; min-height: 100vh; background: #fff; position: relative; }
.input-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 25; display: flex; align-items: flex-end; justify-content: center; }
.input-panel { width: 100%; max-width: 600px; background: #fff; border-radius: 16px 16px 0 0; padding-bottom: calc(20px + var(--safe-bottom)); animation: slideUp .2s ease-out; }
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.close-input { display: block; width: 88%; margin: 0 auto; padding: 10px; border: 1px solid #ddd; border-radius: 10px; background: #fff; font-size: 14px; cursor: pointer; text-align: center; color: #888; }
.loading-bar { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 16px; color: #4a90d9; font-size: 14px; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid #ddd; border-top-color: #4a90d9; border-radius: 50%; animation: spin .6s linear infinite; }
.error-bar { margin: 8px 12px; padding: 12px; background: #fff3cd; color: #856404; border-radius: 8px; font-size: 13px; cursor: pointer; text-align: center; }
</style>