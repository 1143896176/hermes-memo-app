<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { fetchMemos, searchMemos, updateMemoStatus, deleteMemo } from '../services/api'

interface Memo { id: number; title: string; content: string; event?: string; tags: string[]; location: string; due_date: string; status: string; created_at: string; updated_at: string }
const items = ref<Memo[]>([]); const filter = ref('active'); const locFilter = ref(''); const tagFilter = ref('')
const searchQuery = ref(''); const loading = ref(true); const loadError = ref('')

async function load() {
  loading.value = true; loadError.value = ''
  try {
    const params: Record<string, string> = {}
    if (filter.value !== 'all') params.status = filter.value
    if (locFilter.value) params.location = locFilter.value
    if (tagFilter.value.trim()) params.tag = tagFilter.value.trim()
    const q = searchQuery.value.trim()
    const data = q ? await searchMemos(q, params) : await fetchMemos(params)
    items.value = data.items || (data as any).results || []
  } catch (e: any) { loadError.value = e?.message || '加载失败'; items.value = [] }
  finally { loading.value = false }
}

function fmtMinute(s?: string) { if (!s) return ''; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s) }

const allLocations = ref<string[]>([])
async function loadLocations() {
  try { const params: Record<string, string> = {}; if (filter.value !== 'all') params.status = filter.value; const data = await fetchMemos(params); const set = new Set<string>(); (data.items || []).forEach((m: Memo) => { if (m.location) set.add(m.location) }); allLocations.value = [...set].sort(); if (locFilter.value && !allLocations.value.includes(locFilter.value)) locFilter.value = '' }
  catch { allLocations.value = [] }
}

function setFilter(f: string) { filter.value = f; load(); loadLocations() }
function onSearchInput() { if (!searchQuery.value.trim()) load() }
async function toggleStatus(memo: Memo) { const newStatus = memo.status === 'done' ? 'active' : 'done'; await updateMemoStatus(memo.id, newStatus); load(); loadLocations() }
async function del(id: number) { if (!confirm('确定删除？')) return; await deleteMemo(id); load(); loadLocations() }
async function retry() { await load(); await loadLocations() }
onMounted(() => { load(); loadLocations() })
</script>

<template>
  <div class="list">
    <div class="search-box">
      <input v-model="searchQuery" placeholder="🔍 搜索备忘..." @keydown.enter="load" @input="onSearchInput" />
      <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''; load()">✕</button>
    </div>
    <div class="filters">
      <button v-for="f in ['all','active','done']" :key="f" :class="{ sel: filter === f }" @click="setFilter(f)">{{ f === 'all' ? '全部' : f === 'active' ? '活跃' : '已完成' }}</button>
    </div>
    <div class="loc-filters" v-if="allLocations.length">
      <span class="loc-label">📍</span>
      <select v-model="locFilter" @change="load()"><option value="">全部地点</option><option v-for="loc in allLocations" :key="loc" :value="loc">{{ loc }}</option></select>
      <span class="loc-label">🏷</span>
      <input v-model="tagFilter" placeholder="标签" class="tag-input" @keydown.enter="load()" />
    </div>
    <div v-if="loading" class="empty">加载中...</div>
    <div v-else-if="loadError" class="empty err"><p>⚠️ {{ loadError }}</p><button class="retry-btn" @click="retry">重试</button></div>
    <div v-else-if="!items.length" class="empty"><template v-if="searchQuery">未找到匹配</template><template v-else-if="locFilter||tagFilter.trim()">当前筛选无笔记</template><template v-else-if="filter==='active'">暂无活跃笔记</template><template v-else-if="filter==='done'">暂无已完成</template><template v-else>暂无笔记</template></div>
    <div v-for="m in items" :key="m.id" class="card" :class="{ done: m.status === 'done' }">
      <div class="key-row" v-if="m.event || m.due_date || m.location">
        <span class="k k-event" v-if="m.event">📌 {{ m.event }}</span>
        <span class="k k-time" v-if="m.due_date">⏰ {{ m.due_date }}</span>
        <span class="k k-loc" v-if="m.location">📍 {{ m.location }}</span>
      </div>
      <div class="card-head"><span class="status">{{ m.status === 'done' ? '✅' : '🔴' }}</span><strong>{{ m.title }}</strong></div>
      <div class="card-body">{{ m.content.slice(0, 120) }}</div>
      <div class="card-meta"><span v-for="t in m.tags" :key="t" class="tag">{{ t }}</span></div>
      <div class="card-time">🕒 创建 {{ fmtMinute(m.created_at) }}<span v-if="m.updated_at&&fmtMinute(m.updated_at)!==fmtMinute(m.created_at)"> · 更新 {{ fmtMinute(m.updated_at) }}</span></div>
      <div class="card-actions"><button @click="toggleStatus(m)">{{ m.status==='done'?'↩ 恢复':'✅ 完成' }}</button><button class="del" @click="del(m.id)">🗑</button></div>
    </div>
  </div>
</template>

<style scoped>
.list { padding: 12px; }
.search-box { position: relative; margin-bottom: 10px; }
.search-box input { width: 100%; padding: 10px 36px 10px 12px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; outline: none; }
.search-box input:focus { border-color: #4a90d9; }
.clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border: none; border-radius: 50%; background: #eee; color: #666; cursor: pointer; font-size: 12px; }
.filters { display: flex; gap: 8px; margin-bottom: 8px; }
.filters button { padding: 6px 16px; border: 1px solid #ddd; border-radius: 16px; background: #fff; cursor: pointer; font-size: 13px; }
.filters button.sel { background: #4a90d9; color: #fff; border-color: #4a90d9; }
.loc-filters { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.loc-label { font-size: 14px; }
.tag-input { padding: 4px 8px; border: 1px solid #ddd; border-radius: 12px; font-size: 12px; width: 80px; outline: none; }
.tag-input:focus { border-color: #4a90d9; }
.loc-filters select { padding: 4px 8px; border: 1px solid #ddd; border-radius: 12px; font-size: 12px; }
.card { background: #fafafa; border-radius: 10px; padding: 12px; margin-bottom: 10px; border-left: 4px solid #4a90d9; }
.card.done { border-left-color: #aaa; opacity: .6; }
.key-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e0e0e0; }
.k { font-size: 12px; padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
.k-event { background: #e8f0fe; color: #1976d2; }
.k-time { background: #fff3cd; color: #b26a00; }
.k-loc { background: #e8f5e9; color: #2e7d32; }
.card-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.card-body { font-size: 14px; color: #555; margin-bottom: 6px; }
.card-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #888; margin-bottom: 8px; }
.tag { background: #e8f0fe; color: #4a90d9; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.card-time { font-size: 11px; color: #9aa0a6; margin-bottom: 8px; }
.card-actions { display: flex; gap: 8px; }
.card-actions button { padding: 4px 12px; border: 1px solid #ddd; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.card-actions button.del { color: #e55; }
.empty { text-align: center; color: #999; padding: 40px 0; }
.empty.err { color: #b26a00; }
.retry-btn { margin-top: 12px; padding: 8px 20px; border: 1px solid #4a90d9; border-radius: 18px; background: #fff; color: #4a90d9; font-size: 13px; cursor: pointer; }
</style>