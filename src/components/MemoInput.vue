<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ocrRecognize, transcribeAudio, fetchGlossary } from '../services/api'
import {
  systemSpeechSupported,
  probeSystemSpeech,
  isSystemSpeechAvailable,
  isServiceUnavailableError,
  resetSystemSpeechProbe,
  listenSystemSpeech,
  stopSystemSpeech,
  cancelSystemSpeech,
} from '../services/system-speech'

const emit = defineEmits<{ submit: [text: string] }>()
const text = ref('')
const ocrLoading = ref(false)
const voiceError = ref('')
const voiceTip = ref('')
const ocrError = ref('')

// ── 语音输入：优先系统识别，不可用时回退「录音 + 云端 ASR」 ──
// system: 走 Android SpeechRecognizer（实时出字、不花额度）
// cloud : 走 MediaRecorder 录音 + 智谱 GLM-ASR（需要 Key 和额度）
type VoiceMode = 'system' | 'cloud'
const voiceMode = ref<VoiceMode>('cloud')
const sysListening = ref(false)
const recording = ref(false)
const transcribing = ref(false)
const partialText = ref('')
const sysLabel = ref('')

const MAX_RECORD_MS = 28_000   // 智谱 ASR 单次上限 30s，留 2s 余量

// 系统识别服务连不上（多为 Google 服务在国内不可用）后，7 天内优先用云端，
// 到期自动重试系统识别，避免用户换网络/装语音包后仍被钉在云端
const CLOUD_PREF_KEY = 'voice_prefer_cloud_until'
const CLOUD_PREF_DAYS = 7

let mediaRecorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: BlobPart[] = []
let stopTimer: any = null
let tipTimer: any = null

// 术语词典 → ASR 热词。录音结束到上传之间只有几百毫秒，
// 所以提前拉一次并缓存；拉不到就用内置业务词，不影响录音。
let hotwordsPromise: Promise<string[]> | null = null

function loadAsrHotwords(): Promise<string[]> {
  return (async () => {
    try {
      const r: any = await fetchGlossary()
      const terms = Array.isArray(r?.terms) ? r.terms : []
      return terms
        .map((t: any) => String(t?.correct_term || '').trim())
        .filter(Boolean)
    } catch {
      return []
    }
  })()
}

function ensureHotwords(): Promise<string[]> {
  if (!hotwordsPromise) hotwordsPromise = loadAsrHotwords()
  return hotwordsPromise
}

function showTip(msg: string) {
  voiceTip.value = msg
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = setTimeout(() => { voiceTip.value = '' }, 4000)
}

function preferCloudForAWhile() {
  try {
    localStorage.setItem(CLOUD_PREF_KEY, String(Date.now() + CLOUD_PREF_DAYS * 864e5))
  } catch {}
}

function cloudPreferred(): boolean {
  try {
    return Number(localStorage.getItem(CLOUD_PREF_KEY) || 0) > Date.now()
  } catch {
    return false
  }
}

function clearCloudPref() {
  try { localStorage.removeItem(CLOUD_PREF_KEY) } catch {}
}

function submit() {
  if (!text.value.trim()) return
  emit('submit', text.value.trim())
  text.value = ''
}

/** 追加到输入框（不覆盖用户已经打的字） */
function appendText(t: string) {
  const v = t.trim()
  if (!v) return
  text.value = text.value.trim() ? text.value.trim() + ' ' + v : v
}

onMounted(async () => {
  if (!systemSpeechSupported()) {
    voiceMode.value = 'cloud'
    return
  }
  const p = await probeSystemSpeech()
  sysLabel.value = p.selectedLabel || ''
  // 默认走系统识别，只有设备完全没有识别服务时才用云端
  voiceMode.value = p.available ? 'system' : 'cloud'
})

async function toggleVoiceMode() {
  voiceError.value = ''
  voiceTip.value = ''
  if (voiceMode.value === 'system') {
    voiceMode.value = 'cloud'
    preferCloudForAWhile()
    showTip('已切换为云端识别')
    return
  }
  // 重新探测：用户可能刚装了语音服务 / 换了识别引擎
  resetSystemSpeechProbe()
  const ok = await isSystemSpeechAvailable()
  if (!ok) {
    showTip('本机没有可用的系统识别服务（仅有 Google 服务，国内不可用），只能走云端')
    return
  }
  voiceMode.value = 'system'
  clearCloudPref()
  showTip('已切换为系统语音识别')
}

async function startVoice() {
  // 再点一次 = 收尾
  if (sysListening.value) { await stopSystemSpeech(); return }
  if (recording.value) { stopVoice(); return }
  if (transcribing.value) return

  voiceError.value = ''

  // 1. 系统识别（实时、免费、不依赖 API Key）
  if (voiceMode.value === 'system' && await isSystemSpeechAvailable()) {
    await startSystem()
    return
  }

  // 2. 云端识别
  voiceMode.value = 'cloud'
  await startRecorder()
}

// ═══════════ 系统语音识别 ═══════════

async function startSystem() {
  sysListening.value = true
  partialText.value = ''
  voiceError.value = ''
  try {
    const r = await listenSystemSpeech({
      onPartial: (t) => { partialText.value = t },
    })
    if (r.text) appendText(r.text)
    else voiceError.value = '没有听清，请再说一次'
  } catch (e: any) {
    const msg = e?.message || '系统语音识别失败'
    voiceError.value = msg

    if (isServiceUnavailableError(e)) {
      // 系统语音服务连不上（国产机上默认服务常是 Google 的，国内网络不通）
      // → 降级云端，并立刻续跑录音，省掉"请再点一次"
      voiceMode.value = 'cloud'
      preferCloudForAWhile()
      sysListening.value = false
      partialText.value = ''
      showTip('系统语音服务不可用，已自动改用云端识别，请直接说话')
      voiceError.value = ''
      await new Promise((r) => setTimeout(r, 150))  // 等系统释放麦克风
      await startRecorder()
      return
    }

    // 设备上没有识别服务 / 插件异常 → 之后自动改用云端
    if (/没有可用的系统语音识别服务|不支持系统语音识别|启动系统语音识别失败/.test(msg)) {
      voiceMode.value = 'cloud'
      voiceError.value = msg + '，已切换为云端识别，请再点一次语音按钮'
    }
  } finally {
    sysListening.value = false
    partialText.value = ''
  }
}

// ═══════════ 云端识别：MediaRecorder → WAV → 智谱 ASR ═══════════

/** 选一个当前 WebView 支持的录音容器 */
function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
    } catch {}
  }
  return ''
}

function releaseStream() {
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
  stream?.getTracks().forEach(t => t.stop())
  stream = null
}

async function startRecorder() {
  // 每次录音都重新取术语词典：刚加的词汇立即生效（不 await，和录音并行）
  hotwordsPromise = loadAsrHotwords()

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    voiceError.value = '当前环境不支持录音（缺少 getUserMedia）'
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    voiceError.value = '当前 WebView 不支持 MediaRecorder'
    return
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e: any) {
    const name = e?.name || ''
    voiceError.value = name === 'NotAllowedError'
      ? '麦克风权限被拒绝，请在系统设置里允许「录音」权限后重试'
      : name === 'NotFoundError'
        ? '没有检测到麦克风设备'
        : '无法打开麦克风：' + (e?.message || String(e))
    return
  }

  const mime = pickMime()
  try {
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  } catch (e: any) {
    releaseStream()
    voiceError.value = '初始化录音失败：' + (e?.message || String(e))
    return
  }

  chunks = []
  mediaRecorder.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size) chunks.push(ev.data) }
  mediaRecorder.onerror = () => {
    releaseStream()
    recording.value = false
    voiceError.value = '录音过程中出错，请重试'
  }
  mediaRecorder.onstop = async () => {
    recording.value = false
    const type = mediaRecorder?.mimeType || mime || 'audio/webm'
    releaseStream()
    const blob = new Blob(chunks, { type })
    chunks = []
    if (!blob.size) { voiceError.value = '没有录到声音，请靠近麦克风重试'; return }

    transcribing.value = true
    try {
      // 带上用户术语词典作为热词，专有名词（仓库、巡检、人名）字准率明显更好
      const hotwords = await ensureHotwords()
      const r = await transcribeAudio(blob, { hotwords })   // 内部会把 webm 转成 16k WAV
      if (r.text) appendText(r.text)
      else voiceError.value = '未识别到语音内容，请说清楚一点再试'
    } catch (e: any) {
      voiceError.value = e?.message || '语音识别失败'
    } finally {
      transcribing.value = false
    }
  }

  mediaRecorder.start()
  recording.value = true
  voiceError.value = ''
  stopTimer = setTimeout(() => { if (recording.value) stopVoice() }, MAX_RECORD_MS)
}

function stopVoice() {
  recording.value = false
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop() } catch {}
  }
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null }
}

// 面板被关掉时如果还在录音/识别，必须释放麦克风
onBeforeUnmount(() => {
  if (tipTimer) clearTimeout(tipTimer)
  if (sysListening.value) cancelSystemSpeech()
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null
    mediaRecorder.ondataavailable = null
    try { mediaRecorder.stop() } catch {}
  }
  releaseStream()
})

// ═══════════ 拍照 OCR ═══════════

// mode: 'camera' 强制相机 / 'gallery' 走相册选择
async function triggerImage(mode: 'camera' | 'gallery') {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  if (mode === 'camera') {
    // capture=environment 在 Android WebView 强制调起后置相机
    input.setAttribute('capture', 'environment')
  }
  // gallery 模式不加 capture：系统弹相册/文件选择菜单
  input.onchange = async (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    ocrLoading.value = true
    ocrError.value = ''
    try {
      const result = await ocrRecognize(file)
      if (result.text) {
        text.value = result.text
      } else {
        ocrError.value = '未识别到文字'
      }
    } catch (e: any) {
      ocrError.value = e?.message || String(e)
    } finally {
      ocrLoading.value = false
    }
  }
  input.click()
}
</script>

<template>
  <div class="input-area">
    <h3><van-icon name="edit" size="16" /> 录入新备忘</h3>
    <textarea v-model="text" placeholder="输入备忘内容，或点下方按钮语音 / 拍照..." rows="4" @keydown.ctrl.enter="submit" />
    <div class="actions">
      <button
        class="voice"
        :class="{ active: sysListening || recording, busy: transcribing }"
        :disabled="transcribing"
        @click="startVoice"
      >
        <van-icon v-if="sysListening || recording" name="stop-circle-o" size="15" />
        <van-icon v-else-if="transcribing" name="underway" size="15" />
        <van-icon v-else name="volume-o" size="15" />
        <span>{{ sysListening || recording ? '结束' : transcribing ? '识别中...' : '语音' }}</span>
      </button>
      <button class="camera" :disabled="ocrLoading" @click="triggerImage('camera')">
        <van-icon name="photograph" size="15" />
        <span>{{ ocrLoading ? '识别中...' : '拍照' }}</span>
      </button>
      <button class="camera" :disabled="ocrLoading" @click="triggerImage('gallery')">
        <van-icon name="photo-o" size="15" />
        <span>{{ ocrLoading ? '识别中...' : '选图' }}</span>
      </button>
      <button class="submit" @click="submit">
        <van-icon name="records-o" size="15" /> 生成草稿
      </button>
    </div>

    <div v-if="sysListening" class="live-hint">
      <span class="dot" /> 正在听…说完自动结束
      <div v-if="partialText" class="partial">“{{ partialText }}”</div>
    </div>
    <p v-else-if="recording" class="recording-hint"><van-icon name="volume-o" size="12" /> 正在录音，说完再点一次「结束」自动转文字（最长 28 秒）</p>

    <p v-if="voiceTip" class="tip"><van-icon name="bulb-o" size="12" /> {{ voiceTip }}</p>
    <p v-if="voiceError" class="warn"><van-icon name="warning-o" size="12" /> {{ voiceError }}</p>
    <p v-if="ocrError" class="warn"><van-icon name="warning-o" size="12" /> {{ ocrError }}</p>
    <p v-if="!sysListening && !recording && !voiceError && !ocrError" class="hint">
      Ctrl+Enter 发送 |
      <button class="mode-link" @click="toggleVoiceMode">
        <van-icon name="volume-o" size="12" />
        {{ voiceMode === 'system' ? ('系统语音识别' + (sysLabel ? `（${sysLabel}）` : '')) : '云端语音转文字' }}
      </button>
      | 拍照 OCR
    </p>
  </div>
</template>

<style scoped>
.input-area { padding: 16px; }
h3 { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 16px; }
textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 10px; font-size: 15px; resize: vertical; font-family: inherit; }
.actions { display: flex; gap: 6px; margin-top: 10px; }
.actions button {
  flex: 1; padding: 10px 6px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer;
  white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
}
.voice { background: #eee; }
.voice.active { background: #e55; color: #fff; }
.voice.busy { background: #f2f2f2; color: #999; }
.voice:disabled { cursor: not-allowed; }
.camera { background: #e8f0e8; }
.camera:disabled { opacity: 0.6; cursor: not-allowed; }
.submit { background: #4a90d9; color: #fff; }
.live-hint { margin-top: 8px; font-size: 12px; color: #c62828; background: #fdecea; padding: 8px; border-radius: 6px; text-align: center; }
.live-hint .dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #e55; margin-right: 6px; animation: pulse 1s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.partial { margin-top: 6px; color: #666; font-size: 13px; }
.recording-hint { margin-top: 8px; font-size: 12px; color: #c62828; background: #fdecea; padding: 8px; border-radius: 6px; text-align: center; }
.recording-hint .van-icon, .live-hint .van-icon { vertical-align: -2px; }
.hint { margin-top: 8px; font-size: 12px; color: #999; text-align: center; }
.mode-link { display: inline-flex; align-items: center; gap: 2px; vertical-align: -2px; padding: 0; border: none; background: none; color: #4a90d9; font-size: 12px; cursor: pointer; }
.tip .van-icon, .warn .van-icon { vertical-align: -2px; }
.tip { margin-top: 8px; font-size: 12px; color: #8a6d3b; background: #fff8e1; padding: 8px; border-radius: 6px; text-align: center; }
.warn { margin-top: 8px; font-size: 12px; color: #c62828; text-align: center; background: #fdecea; padding: 8px; border-radius: 6px; }
</style>
