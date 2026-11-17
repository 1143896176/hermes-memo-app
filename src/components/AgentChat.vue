<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { Field, Button } from 'vant'
import { chatWithAgent } from '../services/node-bridge'
import { listenSystemSpeech, isSystemSpeechAvailable } from '../services/system-speech'

interface Msg { role: 'user' | 'assistant'; content: string; pending?: boolean }

const messages = ref<Msg[]>([])
const input = ref('')
const loading = ref(false)
const listening = ref(false)
const errMsg = ref('')
const chatEl = ref<HTMLElement | null>(null)
const voiceAvailable = ref(false)

const THREAD_ID = 'memo-app-thread-' + Date.now()

async function send() {
  const text = input.value.trim()
  if (!text || loading.value) return
  input.value = ''; errMsg.value = ''
  messages.value.push({ role: 'user', content: text })
  messages.value.push({ role: 'assistant', content: '', pending: true })
  loading.value = true
  try {
    const reply = await chatWithAgent(text, THREAD_ID)
    const last = messages.value[messages.value.length - 1]
    if (last && last.pending) { last.content = reply; last.pending = false }
  } catch (e: any) {
    errMsg.value = e?.message || String(e)
    const last = messages.value[messages.value.length - 1]
    if (last && last.pending) messages.value.pop()
  } finally { loading.value = false }
}

async function startVoice() {
  if (listening.value || loading.value) return
  listening.value = true; errMsg.value = ''
  try {
    const result = await listenSystemSpeech({ language: 'zh-CN' })
    const text = result.text.trim()
    if (text) { input.value = text; send() }
  } catch (e: any) { errMsg.value = '语音识别失败：' + (e?.message || String(e)) }
  finally { listening.value = false }
}

function quickPrompt(text: string) { input.value = text; send() }

onMounted(async () => {
  voiceAvailable.value = await isSystemSpeechAvailable()
  messages.value.push({ role: 'assistant', content: '你好！我是智能备忘录 Agent。可以直接告诉我你要记的事，我会自动调用工具保存。试试：\n"明天下午3点去公司开会"\n"列出我这周的任务"\n"把昨天那条标记完成"' })
})
</script>

<template>
  <div class="chat-panel">
    <div class="chat-msgs" ref="chatEl">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="bubble">
          <span v-if="m.pending" class="typing">●●●</span>
          <template v-else>{{ m.content }}</template>
        </div>
      </div>
    </div>

    <p v-if="errMsg" class="err">⚠️ {{ errMsg }}</p>

    <div class="quick">
      <van-button size="small" plain @click="quickPrompt('列出我最近的5条备忘')">📋 列出最近</van-button>
      <van-button size="small" plain @click="quickPrompt('搜索：开会')">🔍 搜索"开会"</van-button>
      <van-button size="small" plain @click="quickPrompt('导出全部数据')">📦 导出</van-button>
    </div>

    <div class="input-bar">
      <van-button v-if="voiceAvailable" icon="volume-o" :class="{ active: listening }" @click="startVoice" :disabled="loading || listening" />
      <van-field v-model="input" type="textarea" autosize rows="1" maxlength="-1" placeholder="跟 Agent 说话..." :disabled="loading" class="chat-input" />
      <van-button type="primary" :loading="loading" :disabled="!input.trim()" @click="send">{{ loading ? '思考中...' : '发送' }}</van-button>
    </div>
  </div>
</template>

<style scoped>
.chat-panel { display: flex; flex-direction: column; height: 100%; }
.chat-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; }
.msg.user { justify-content: flex-end; }
.msg.assistant { justify-content: flex-start; }
.bubble { max-width: 85%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
.msg.user .bubble { background: #4a90d9; color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: #f0f0f0; color: #333; border-bottom-left-radius: 4px; }
.typing { letter-spacing: 2px; animation: blink 1s infinite; color: #888; }
@keyframes blink { 50% { opacity: .3; } }
.err { margin: 4px 12px; padding: 8px; background: #fdecea; color: #c62828; border-radius: 6px; font-size: 12px; }
.quick { display: flex; gap: 6px; padding: 0 12px 8px; flex-wrap: wrap; }
.input-bar { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eee; align-items: flex-end; }
.chat-input { flex: 1; padding: 0; }
.chat-input :deep(.van-field__control) { min-height: 36px; }
</style>