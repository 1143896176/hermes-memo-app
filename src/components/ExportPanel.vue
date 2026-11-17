<script setup lang="ts">
import { ref } from 'vue'
import { exportData, importData, isNativeEnv } from '../services/node-bridge'

const emit = defineEmits<{ imported: [] }>()

const opts = ref({
  memos: true, includeDone: true,
  glossary: true, skills: true, knowledge: true,
  memory: true, config: false,
})
const msg = ref('')
const errMsg = ref('')
const busy = ref(false)
const filePath = ref('')

async function handleExport() {
  busy.value = true; msg.value = ''; errMsg.value = ''; filePath.value = ''
  try {
    if (isNativeEnv()) {
      // Node 端直接写文件到 Download 目录
      const { callNode } = await import('../services/node-bridge')
      const result = await (callNode as any)('export.file', { ...opts.value })
      filePath.value = result.file
      msg.value = '\u2705 已保存到 ' + result.file
    } else {
      // 浏览器端：触发下载
      const data = await exportData({ ...opts.value })
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
      const a = document.createElement('a')
      a.href = url; a.download = `memo-backup-${stamp}.json`
      a.click(); window.open(url)
      URL.revokeObjectURL(url)
      msg.value = '\u2705 已导出'
    }
  } catch (e: any) {
    errMsg.value = '\u274c 导出失败：' + (e?.message || String(e))
  } finally { busy.value = false }
}

async function handleImport() {
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.json'
  input.onchange = async (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    busy.value = true; msg.value = ''; errMsg.value = ''; filePath.value = ''
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const result = await importData(data)
      msg.value = '\u2705 已导入 ' + (result.imported ?? '?') + ' 条'
      emit('imported')
    } catch (e: any) {
      errMsg.value = '\u274c 导入失败：' + (e?.message || String(e))
    } finally { busy.value = false }
  }
  input.click()
}
</script>

<template>
  <div class="panel">
    <p class="desc">勾选要导出的数据类型，生成 JSON 备份文件。导入时选择备份文件即可恢复。</p>

    <div class="checks">
      <label><input type="checkbox" v-model="opts.memos"> 备忘录</label>
      <label v-if="opts.memos"><input type="checkbox" v-model="opts.includeDone" class="sub"> 含已完成</label>
      <label><input type="checkbox" v-model="opts.glossary"> 术语词典</label>
      <label><input type="checkbox" v-model="opts.skills"> 技能</label>
      <label><input type="checkbox" v-model="opts.knowledge"> 知识库</label>
      <label><input type="checkbox" v-model="opts.memory"> 记忆 &amp; 画像</label>
      <label><input type="checkbox" v-model="opts.config"> 配置（模型/地址，不含 Key）</label>
    </div>

    <div class="btns">
      <button :disabled="busy" @click="handleExport">📦 导出</button>
      <button :disabled="busy" @click="handleImport">📥 导入备份</button>
    </div>

    <p v-if="msg" class="msg ok">{{ msg }}</p>
    <p v-if="errMsg" class="msg err">{{ errMsg }}</p>
    <p v-if="filePath" class="file-path">📁 {{ filePath }}</p>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 14px; }
.checks { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.checks label { font-size: 14px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.checks input[type=checkbox] { width: 16px; height: 16px; }
.checks .sub { margin-left: 24px; }
.btns { display: flex; gap: 8px; }
.btns button {
  flex: 1; padding: 11px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer;
  background: #4a90d9; color: #fff;
}
.btns button:nth-child(2) { background: #388e3c; }
.btns button:disabled { opacity: .5; cursor: not-allowed; }
.msg { margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 13px; }
.msg.ok { background: #e8f5e9; color: #2e7d32; }
.msg.err { background: #fdecea; color: #c62828; }
.file-path { font-size: 11px; color: #888; margin-top: 8px; word-break: break-all; }
</style>