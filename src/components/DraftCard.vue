<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  draft: {
    draft: {
      title: string; content: string
      event: string
      tags: string[]
      location: string; due_date: string
      inferred_location?: string; inferred_due_date?: string
      [key: string]: any
    }
    rawText: string; correctedText: string
    corrections: { from: string; to: string }[]
    llmUsed?: boolean
    llmError?: string
    missingKeyFields?: string[]
  }
  loading?: boolean
  saving?: boolean
}>()
const emit = defineEmits(['confirm', 'revise', 'cancel'])

const editing = ref(false)
const newText = ref(props.draft.correctedText)

// 三要素里缺了哪些（后端算好的优先，老数据回退到前端判断）
const missingKeys = computed<string[]>(() => {
  if (Array.isArray(props.draft.missingKeyFields)) return props.draft.missingKeyFields
  const d = props.draft.draft
  const out: string[] = []
  if (!d.event) out.push('任务')
  if (!d.due_date && !d.inferred_due_date) out.push('时间')
  if (!d.location && !d.inferred_location) out.push('地点')
  return out
})

const llmFallback = computed(() => props.draft.llmUsed === false)

function revise() { emit('revise', newText.value); editing.value = false }
</script>

<template>
  <div class="draft-overlay">
    <div class="draft-card">
      <h3><van-icon name="edit" size="16" /> 确认草稿</h3>
      <div v-if="draft.corrections.length" class="corrections">
        <van-icon name="setting-o" size="12" /> 自动修正:
        <span v-for="c in draft.corrections" :key="c.from" class="fix">{{ c.from }}→{{ c.to }}</span>
      </div>

      <!-- LLM 未参与结构化：明确告诉用户当前是原文草稿，不是模型解析结果 -->
      <div v-if="llmFallback" class="hint-fallback">
        <van-icon name="warning-o" size="13" /> 未走模型结构化（{{ draft.llmError || 'LLM 未生效' }}），以下为原文草稿，可修改后重试
      </div>

      <!-- 关键三字段高亮：事件 / 时间 / 地点 -->
      <div class="key-fields">
        <div class="key-field event" v-if="draft.draft.event">
          <span class="kf-label"><van-icon name="flag-o" size="13" /> 事件</span>
          <span class="kf-value">{{ draft.draft.event }}</span>
        </div>
        <div class="key-field time" v-if="draft.draft.due_date">
          <span class="kf-label"><van-icon name="clock-o" size="13" /> 时间</span>
          <span class="kf-value">{{ draft.draft.due_date }}</span>
        </div>
        <div class="key-field time inferred" v-else-if="draft.draft.inferred_due_date">
          <span class="kf-label"><van-icon name="bulb-o" size="13" /> 推测时间</span>
          <span class="kf-value">{{ draft.draft.inferred_due_date }}</span>
        </div>
        <div class="key-field loc" v-if="draft.draft.location">
          <span class="kf-label"><van-icon name="location-o" size="13" /> 地点</span>
          <span class="kf-value">{{ draft.draft.location }}</span>
        </div>
        <div class="key-field loc inferred" v-else-if="draft.draft.inferred_location">
          <span class="kf-label"><van-icon name="bulb-o" size="13" /> 推测地点</span>
          <span class="kf-value">{{ draft.draft.inferred_location }}</span>
        </div>
      </div>

      <div class="field"><label>标题</label><div>{{ draft.draft.title }}</div></div>
      <div class="field"><label>内容</label><div>{{ draft.draft.content }}</div></div>
      <div class="field" v-if="draft.draft.tags.length">
        <label>标签</label>
        <div class="tags"><span v-for="t in draft.draft.tags" :key="t" class="tag">{{ t }}</span></div>
      </div>

      <!-- 缺失字段提醒 -->
      <div v-if="!llmFallback && missingKeys.length" class="hint-missing">
        <van-icon name="bulb-o" size="12" /> 未识别到{{ missingKeys.join(' / ') }}，可修改后重新生成
      </div>

      <div v-if="editing" class="edit-area">
        <textarea v-model="newText" rows="3" placeholder="输入修改后的文本..." :disabled="loading" />
        <div class="edit-actions">
          <button @click="revise" :disabled="loading">
            <span v-if="loading" class="spinner-sm" />
            <van-icon v-else name="replay" size="14" />
            {{ loading ? '重新生成中...' : '重新生成' }}
          </button>
          <button class="cancel" @click="editing = false" :disabled="loading">
            <van-icon name="cross" size="14" /> 取消
          </button>
        </div>
      </div>

      <div v-else class="confirm-actions">
        <button class="primary" @click="emit('confirm')" :disabled="saving">
          <span v-if="saving" class="spinner-sm" />
          <van-icon v-else name="success" size="14" />
          {{ saving ? '保存中...' : '确认保存' }}
        </button>
        <button @click="editing = true" :disabled="saving">
          <van-icon name="edit" size="14" /> 修改
        </button>
        <button class="cancel" @click="emit('cancel')" :disabled="saving">
          <van-icon name="cross" size="14" /> 取消
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; z-index: 100;
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px)); }
.draft-card { background: #fff; border-radius: 14px; padding: 20px; width: 100%; max-width: 420px;
  max-height: min(100%, 720px); overflow-y: auto; overscroll-behavior: contain; }
h3 { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.corrections { font-size: 12px; background: #fff3cd; padding: 8px; border-radius: 8px; margin-bottom: 12px; }
.fix { background: #ffc107; padding: 1px 4px; border-radius: 4px; margin: 0 2px; font-size: 11px; }
.field { margin-bottom: 10px; }
.field label { font-size: 11px; color: #888; display: block; margin-bottom: 2px; }
.field div { font-size: 14px; }
.field.inferred { background: #fff8e1; border-left: 3px solid #ffc107; padding: 4px 8px; border-radius: 4px; }
.tags { display: flex; gap: 4px; flex-wrap: wrap; }
.tag { background: #e8f0fe; color: #4a90d9; padding: 2px 8px; border-radius: 10px; font-size: 12px; }

/* 关键字段容器 */
.key-fields { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.key-field {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-radius: 10px;
  background: #f0f7ff; border-left: 4px solid #4a90d9;
  font-size: 14px;
}
.key-field.time { background: #fff8e1; border-left-color: #ff9800; }
.key-field.loc  { background: #e8f5e9; border-left-color: #4caf50; }
.key-field.inferred { background: #fafafa; border-left-color: #bbb; border-style: dashed; }
.kf-label { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: #666; white-space: nowrap; }
.kf-value { font-weight: 600; }

.hint-missing { font-size: 12px; color: #999; padding: 8px; background: #fafafa; border-radius: 6px; text-align: center; }
.hint-fallback { font-size: 12px; color: #b26a00; background: #fff3cd; border-left: 4px solid #ffc107;
  padding: 8px 10px; border-radius: 8px; margin-bottom: 12px; line-height: 1.5; }
.edit-area { margin-top: 12px; }
.edit-area textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
.edit-actions, .confirm-actions { display: flex; gap: 8px; margin-top: 12px; }
.confirm-actions button, .edit-actions button {
  flex: 1; padding: 10px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
}
/* 行内小图标与文字基线对齐 */
.corrections .van-icon, .hint-fallback .van-icon, .hint-missing .van-icon { vertical-align: -2px; }
.primary { background: #4a90d9; color: #fff; }
.cancel { background: #eee; }
button:disabled { opacity: .7; cursor: not-allowed; }

/* ── 小 spinner ── */
@keyframes spin-sm { to { transform: rotate(360deg); } }
.spinner-sm {
  display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin-right: 4px;
  border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%;
  animation: spin-sm .5s linear infinite;
}
</style>