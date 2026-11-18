<script setup lang="ts">
/**
 * 运行诊断
 *
 * 真机（尤其 iOS）上拿不到控制台，出问题只能靠猜「是模型没配好？
 * 还是数据库没写进去？」。这一页把两个问题分开回答：
 *   1. 环境自检 —— 进程/架构、数据目录可写性、sqlite/FTS5、各库条数、Key 是否落盘
 *   2. 模型连通性 —— 真发一次请求，把 401 / 402 / 404 / 429 原样显示
 */
import { ref, computed, onMounted } from 'vue'
import { diagnose, llmPing } from '../services/api'

const loading = ref(false)
const report = ref<any>(null)
const reportError = ref('')

const pingLoading = ref(false)
const ping = ref<any>(null)

async function runDiagnose() {
  loading.value = true
  reportError.value = ''
  try {
    report.value = await diagnose()
  } catch (e: any) {
    reportError.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

async function runPing() {
  pingLoading.value = true
  try {
    ping.value = await llmPing()
  } catch (e: any) {
    ping.value = { ok: false, error: e?.message || String(e) }
  } finally {
    pingLoading.value = false
  }
}

function yesNo(v: any) {
  return v === true ? '可用' : v === false ? '不可用' : String(v ?? '-')
}

const modeText = computed(() => {
  const m = report.value?.mode
  if (m === 'node') return report.value?.fatal ? 'Node 运行时（调用失败）' : 'Node 运行时'
  if (m === 'browser') return '浏览器 / WebView 引擎（sql.js）'
  return '-'
})

/** 需要重点提示的问题（红字） */
const problems = computed<string[]>(() => {
  const r = report.value
  if (!r) return []
  const out: string[] = []
  if (r.fatal) out.push('Node 运行时调用失败：' + r.fatal)
  if (r.writable === false) out.push('数据目录不可写：' + (r.writeError || '未知原因'))
  if (r.sqlite === false) out.push('node:sqlite 不可用：' + (r.sqliteError || '未知原因'))
  if (r.fts5 === false && r.sqlite !== false) out.push('FTS5 不可用：' + (r.fts5Error || '未知原因'))
  if (r.countError) out.push('数据库读取失败：' + r.countError)
  if (r.llm && r.llm.hasKey === false) out.push('未配置 LLM Key（识别只会落到原文草稿）')
  if (r.llm && r.llm.configFileExists === false && r.llm.hasKey) out.push('Key 存在内存里但没写进配置文件（重启会丢）')
  return out
})

const pingOk = computed(() => ping.value?.ok === true)

onMounted(runDiagnose)
</script>

<template>
  <div class="settings-panel">
    <p class="desc">
      出问题时先看这里：环境自检回答「本地能不能存」，模型连通性回答「识别能不能走模型」。
    </p>

    <div class="row-actions">
      <van-button size="small" type="primary" icon="replay" :loading="loading" @click="runDiagnose">重新检测</van-button>
      <van-button size="small" icon="passed" :loading="pingLoading" @click="runPing">测试模型连接</van-button>
    </div>

    <div v-if="problems.length" class="problem-box">
      <div v-for="(p, i) in problems" :key="i" class="problem-line">
        <van-icon name="warning-o" size="13" /> {{ p }}
      </div>
    </div>
    <div v-else-if="report" class="ok-box">
      <van-icon name="passed" size="13" /> 环境自检未发现问题
    </div>

    <van-cell-group v-if="ping" inset class="ping-group">
      <van-cell title="模型连接" :value="pingOk ? '正常' : '失败'" :value-class="pingOk ? 'v-ok' : 'v-err'" />
      <van-cell v-if="pingOk" title="耗时" :value="`${ping.ms} ms`" />
      <van-cell v-if="pingOk" title="JSON 模式" :value="ping.jsonOk ? '可用' : '不可用'" :value-class="ping.jsonOk ? 'v-ok' : 'v-err'" />
      <van-cell v-if="pingOk && ping.sample" title="返回示例" :label="ping.sample" />
      <van-cell v-if="pingOk && !ping.jsonOk && ping.jsonError" title="JSON 模式报错" :label="ping.jsonError" />
      <van-cell v-if="!pingOk" title="报错" :label="ping.error || '未知'" />
    </van-cell-group>

    <van-cell-group v-if="report" inset>
      <van-cell title="运行环境" :value="modeText" />
      <van-cell v-if="report.platform" title="架构" :value="report.platform" />
      <van-cell v-if="report.nodeVersion" title="Node 版本" :value="report.nodeVersion" />
      <van-cell v-if="report.rpcMs !== undefined" title="RPC 耗时" :value="`${report.rpcMs} ms`" />
      <van-cell title="数据目录可写" :value="yesNo(report.writable)" :value-class="report.writable ? 'v-ok' : 'v-err'" />
      <van-cell title="sqlite" :value="yesNo(report.sqlite)" :value-class="report.sqlite ? 'v-ok' : 'v-err'" />
      <van-cell title="FTS5" :value="yesNo(report.fts5)" :value-class="report.fts5 ? 'v-ok' : 'v-err'" />
      <van-cell title="备忘条数" :value="String(report.counts?.memos ?? '-')" />
      <van-cell title="术语条数" :value="String(report.counts?.glossary ?? '-')" />
      <van-cell title="LLM Key" :value="report.llm?.hasKey ? `已配置（${report.llm.keyLength} 字符）` : '未配置'" :value-class="report.llm?.hasKey ? 'v-ok' : 'v-err'" />
      <van-cell title="文本模型" :value="report.llm?.model || '-'" />
      <van-cell title="LLM 地址" :value="report.llm?.baseURL || '-'" />
    </van-cell-group>

    <p class="hint">数据目录、配置文件路径属于排查信息，需要反馈问题时再复制。</p>
    <textarea
      v-if="report"
      class="raw"
      rows="6"
      readonly
      :value="JSON.stringify(report, null, 2)"
    />
    <p v-if="reportError" class="err-line">{{ reportError }}</p>
  </div>
</template>

<style scoped>
.settings-panel { padding: 16px; }
.desc { font-size: 12px; color: #888; margin-bottom: 12px; line-height: 1.5; }
.row-actions { display: flex; gap: 8px; margin-bottom: 12px; }
.problem-box { background: #fdecea; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.problem-line { display: flex; align-items: flex-start; gap: 5px; font-size: 12px; color: #c62828; line-height: 1.6; }
.problem-line .van-icon { margin-top: 2px; flex: none; }
.ok-box { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #2e7d32; background: #e8f5e9; border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
.ping-group { margin-bottom: 12px; }
.v-ok { color: #2e7d32 !important; }
.v-err { color: #c62828 !important; }
.hint { font-size: 11px; color: #999; margin: 12px 0 6px; line-height: 1.6; }
.raw { display: block; width: 100%; padding: 10px; border: 1px solid #eee; border-radius: 8px; background: #fafafa; color: #666; font-size: 11px; font-family: monospace; line-height: 1.5; resize: none; }
.err-line { font-size: 12px; color: #c62828; margin-top: 8px; }
</style>
