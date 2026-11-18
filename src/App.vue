<script setup lang="ts">
import { ref, computed } from 'vue'
import MemoList from './components/MemoList.vue'
import MemoInput from './components/MemoInput.vue'
import DraftCard from './components/DraftCard.vue'
import GlossaryPanel from './components/GlossaryPanel.vue'
import ExportPanel from './components/ExportPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import MemoryPanel from './components/MemoryPanel.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import DiagnosePanel from './components/DiagnosePanel.vue'
import AgentChat from './components/AgentChat.vue'
import { createDraft, confirmDraft, reviseDraft, type DraftResult } from './services/api'
import { syncApiConfigToNode, isNativeEnv, waitForNode, getNodeConfig } from './services/node-bridge'
import { loadNodejsPluginSync } from './services/node-bridge'
import { getApiConfig, setApiConfig, initEngine, DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, DEFAULT_API_BASE, DEFAULT_ASR_BASE, LEGACY_TEXT_MODELS } from './services/engine'
import { invalidateAgent } from './services/agent'
import { initKeyboardDismiss } from './services/keyboard'

type MainTab = 'memos' | 'agent'
type PanelKey = 'glossary' | 'export' | 'settings' | 'memory' | 'knowledge' | 'diagnose'

const mainTab = ref<MainTab>('memos')

// van-tabbar 的 v-model 是 string | number，用 computed 桥接避免类型冲突；
// 切页副作用单独放 @change，不能写在 set 里（Vant 先更新 model 再触发 change）
const tabbarActive = computed<string | number>({
  get: () => mainTab.value,
  set: (v) => { mainTab.value = v as MainTab },
})
function onTabChange(name: string | number) {
  if (name === 'memos') refreshKey.value++
}

const showInput = ref(false)
const showSettings = ref(false)
const settingsPanel = ref<PanelKey | null>(null)
const draft = ref<DraftResult | null>(null)
const draftLoading = ref(false)
const draftSaving = ref(false)
const refreshKey = ref(0)
const errorMsg = ref('')

loadNodejsPluginSync()
// iOS 没有返回键收键盘，点空白处失焦（Android 无副作用，统一装上）
initKeyboardDismiss()
;(async () => {
  try { await initEngine() } catch (e) { console.warn('[app] init:', e) }
  const cfg = getApiConfig()
  const defaultConfig = {
    apiKey1: cfg.apiKey1 || '', apiKey2: cfg.apiKey2,
    apiBase: cfg.apiBase || DEFAULT_API_BASE,
    modelName: cfg.modelName || DEFAULT_TEXT_MODEL,
    ocrKey: cfg.ocrKey || '', ocrModel: cfg.ocrModel || DEFAULT_VISION_MODEL,
    asrKey: cfg.asrKey || '', asrBase: cfg.asrBase || DEFAULT_ASR_BASE,
  }
  let needSave = false
  if (LEGACY_TEXT_MODELS.includes(defaultConfig.modelName)) {
    defaultConfig.modelName = DEFAULT_TEXT_MODEL
    needSave = true
  }
  if (needSave) setApiConfig(defaultConfig)
  if (isNativeEnv()) {
    // 启动自检：Node 没起来 / 配置没同步过去，都会让"识别不走模型"，
    // 这两种情况必须在首页直接说出来，不能等用户去翻日志
    const nodeOk = await waitForNode(15000)
    if (!nodeOk) {
      errorMsg.value = '本地运行时（Node）启动超时：数据库与模型都可能不可用，请重启 App；仍不行请看「运行诊断」'
    } else {
      // 原生环境以 Node 磁盘配置为准：WebView 里的只是内存默认值，
      // 直接推过去会把用户上次存好的地址/模型覆盖掉（表现为"设置里是对的，发请求却 401"）
      const nodeCfg = await getNodeConfig()
      if (nodeCfg) {
        if (nodeCfg.baseURL) defaultConfig.apiBase = nodeCfg.baseURL
        if (nodeCfg.model) defaultConfig.modelName = nodeCfg.model
        if (nodeCfg.ocrModel) defaultConfig.ocrModel = nodeCfg.ocrModel
        if (nodeCfg.asrBase) defaultConfig.asrBase = nodeCfg.asrBase
      }
      try {
        await syncApiConfigToNode(defaultConfig)
      } catch (e: any) {
        errorMsg.value = '配置同步到本地运行时失败：' + (e?.message || String(e))
      }
    }
  }
  invalidateAgent()
})()

async function onTextSubmit(text: string) {
  draftLoading.value = true
  errorMsg.value = ''
  try {
    const result = await createDraft(text)
    if (!result.draft.title && !result.draft.content) errorMsg.value = '生成失败：请在 API 设置中填写 Key'
    else { draft.value = result; showInput.value = false }
  } catch (e: any) {
    errorMsg.value = e?.message || '网络错误'
  } finally {
    draftLoading.value = false
  }
}

async function onConfirm() {
  if (!draft.value) return
  draftSaving.value = true
  errorMsg.value = ''
  try {
    await confirmDraft(draft.value)
    draft.value = null
    showInput.value = false
    refreshKey.value++
  } catch (e: any) {
    // 不要再把真实原因吞成"保存失败"——真机上只能靠这句话定位
    errorMsg.value = '保存失败：' + (e?.message || String(e))
  } finally {
    draftSaving.value = false
  }
}

async function onRevise(newText: string) {
  if (!draft.value) return
  draftLoading.value = true
  errorMsg.value = ''
  try {
    const result = await reviseDraft(draft.value.rawText, newText)
    if (!result.draft.title && !result.draft.content) errorMsg.value = '重新生成失败'
    else draft.value = result
  } catch (e: any) {
    errorMsg.value = '重新生成失败：' + (e?.message || String(e))
  } finally {
    draftLoading.value = false
  }
}

function onCancel() { draft.value = null }

function openSettings(panel: PanelKey) {
  showSettings.value = false
  settingsPanel.value = panel
}
function closeSettings() { settingsPanel.value = null }

const settingsActions = [
  { name: 'API 设置', value: 'settings', icon: 'setting-o' },
  { name: '术语词典', value: 'glossary', icon: 'font-o' },
  { name: '记忆 / 技能', value: 'memory', icon: 'bulb-o' },
  { name: '知识库', value: 'knowledge', icon: 'description-o' },
  { name: '导出分享', value: 'export', icon: 'upgrade' },
  { name: '运行诊断', value: 'diagnose', icon: 'warning-o' },
]

function onSelectSettings(item: { name: string; value: string }) {
  openSettings(item.value as PanelKey)
}

const showSettingsPanel = computed({
  get: () => !!settingsPanel.value,
  set: (val: boolean) => { if (!val) closeSettings() },
})

const panelMeta = computed(() => {
  const map: Record<PanelKey, { title: string; icon: string }> = {
    settings: { title: 'API 设置', icon: 'setting-o' },
    glossary: { title: '术语词典', icon: 'font-o' },
    memory: { title: '记忆 / 技能', icon: 'bulb-o' },
    knowledge: { title: '知识库', icon: 'description-o' },
    export: { title: '导出分享', icon: 'upgrade' },
    diagnose: { title: '运行诊断', icon: 'warning-o' },
  }
  return settingsPanel.value ? map[settingsPanel.value] : { title: '', icon: '' }
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
      class="settings-popup"
      :style="{ height: '85%' }"
      round
    >
      <div class="popup-head">
        <van-icon name="arrow-left" size="19" class="popup-back" @click="closeSettings" />
        <div class="popup-title">
          <van-icon :name="panelMeta.icon" size="16" />
          <span>{{ panelMeta.title }}</span>
        </div>
        <span class="popup-head-pad" />
      </div>
      <div class="popup-body">
        <SettingsPanel v-if="settingsPanel === 'settings'" />
        <GlossaryPanel v-else-if="settingsPanel === 'glossary'" />
        <MemoryPanel v-else-if="settingsPanel === 'memory'" />
        <KnowledgePanel v-else-if="settingsPanel === 'knowledge'" />
        <ExportPanel v-else-if="settingsPanel === 'export'" @imported="refreshKey++" />
        <DiagnosePanel v-else-if="settingsPanel === 'diagnose'" />
      </div>
    </van-popup>

    <main class="app-main">
      <div v-if="mainTab === 'memos'" class="tab-page">
        <div v-if="errorMsg" class="error-bar" @click="errorMsg = ''">
          <van-icon name="warning-o" /> {{ errorMsg }}
        </div>
        <MemoList :key="refreshKey" class="page-scroll" />
      </div>
      <AgentChat v-else class="tab-page" />
    </main>

    <!-- 草稿生成中：全屏 loading 遮罩 -->
    <van-overlay :show="draftLoading && !draft" z-index="9999">
      <div class="loading-mask">
        <van-loading size="36" color="#4a90d9" vertical>
          AI 正在解析备忘...
        </van-loading>
      </div>
    </van-overlay>

    <van-tabbar
      v-model="tabbarActive"
      :fixed="false"
      safe-area-inset-bottom
      @change="onTabChange"
    >
      <van-tabbar-item name="memos" icon="notes-o">备忘录</van-tabbar-item>
      <van-tabbar-item name="agent" icon="chat-o">助手</van-tabbar-item>
    </van-tabbar>

    <van-button
      v-if="!showInput && mainTab === 'memos'"
      class="fab"
      type="primary"
      round
      icon="plus"
      @click="showInput = true"
    />

    <div v-if="showInput" class="input-overlay" @click.self="showInput = false">
      <div class="input-panel">
        <MemoInput @submit="onTextSubmit" />
        <button class="close-input" @click="showInput = false">取消</button>
      </div>
    </div>

    <DraftCard
      v-if="draft"
      :draft="draft"
      :loading="draftLoading"
      :saving="draftSaving"
      @confirm="onConfirm"
      @revise="onRevise"
      @cancel="onCancel"
    />
  </div>
</template>

<style>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  background: #fff;
}

/* 中间区域：自己撑满剩余高度并承接滚动 */
.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.page-scroll {
  flex: 1;
  min-height: 0;
}

/* ── 设置弹层：标题栏固定 + 内容独立滚动 ── */
.settings-popup {
  display: flex;
  flex-direction: column;
}
.popup-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 14px;
  border-bottom: 1px solid #eee;
  background: #fff;
}
.popup-back {
  flex: none;
  cursor: pointer;
  color: #323233;
}
.popup-title {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}
.popup-head-pad {
  width: 19px;
  flex: none;
}
.popup-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
}

/* ── 录入面板 ── */
.input-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .4);
  z-index: 2000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.input-panel {
  width: 100%;
  max-width: 600px;
  max-height: 88vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 16px 16px 0 0;
  padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  animation: slideUp .2s ease-out;
}
@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
.close-input {
  display: block;
  width: 88%;
  margin: 0 auto;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: #fff;
  font-size: 14px;
  color: #888;
  text-align: center;
  cursor: pointer;
}

/* ── 悬浮录入按钮：absolute 定位在容器内，避免宽屏跑到视口外 ── */
.fab {
  position: absolute;
  right: 20px;
  bottom: calc(62px + env(safe-area-inset-bottom, 0px));
  width: 52px;
  height: 52px;
  padding: 0;
  font-size: 22px;
  z-index: 9;
  box-shadow: 0 4px 16px rgba(74, 144, 217, .4);
}

.loading-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  padding: 16px;
  color: #4a90d9;
  font-size: 14px;
}

.loading-mask {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #4a90d9;
}

.error-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 8px 12px;
  padding: 12px;
  background: #fff3cd;
  color: #856404;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  text-align: center;
}
</style>
