<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { DropdownMenu, DropdownItem, Field } from 'vant'
import { fetchMemos, searchMemos, updateMemoStatus, deleteMemo } from '../services/api'

interface Memo { id: number; title: string; content: string; event?: string; tags: string[]; location: string; due_date: string; status: string; created_at: string; updated_at: string }

const items = ref<Memo[]>([])
const filter = ref('active')
const locFilter = ref('')
const tagFilter = ref('')
const searchQuery = ref('')
const loading = ref(true)
const loadError = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const params: Record<string, string> = {}
    if (filter.value !== 'all') params.status = filter.value
    if (locFilter.value) params.location = locFilter.value
    if (tagFilter.value.trim()) params.tag = tagFilter.value.trim()
    const q = searchQuery.value.trim()
    const data = q ? await searchMemos(q, params) : await fetchMemos(params)
    items.value = data.items || (data as any).results || []
  } catch (e: any) {
    loadError.value = e?.message || '加载失败'
    items.value = []
  } finally {
    loading.value = false
  }
}

function fmtMinute(s?: string) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s)
}

const allLocations = ref<string[]>([])
// 地点下拉选项：全部地点 + 各地点（带 location-o 图标）
const locOptions = computed(() => [
  { text: '全部地点', value: '', icon: 'location-o' },
  ...allLocations.value.map(loc => ({ text: loc, value: loc, icon: 'location-o' })),
])
async function loadLocations() {
  try {
    const params: Record<string, string> = {}
    if (filter.value !== 'all') params.status = filter.value
    const data = await fetchMemos(params)
    const set = new Set<string>()
    ;(data.items || []).forEach((m: Memo) => { if (m.location) set.add(m.location) })
    allLocations.value = [...set].sort()
    if (locFilter.value && !allLocations.value.includes(locFilter.value)) locFilter.value = ''
  } catch {
    allLocations.value = []
  }
}

function onFilterChange(name: string | number) {
  filter.value = String(name)
  load()
  loadLocations()
}

// 输入即过滤：清空时立即回全量，有内容时保持旧行为由 @search 触发
function onSearchChange() {
  if (!searchQuery.value.trim()) load()
}
function onSearchEnter() { load() }

async function toggleStatus(memo: Memo) {
  const newStatus = memo.status === 'done' ? 'active' : 'done'
  await updateMemoStatus(memo.id, newStatus)
  load()
  loadLocations()
}

async function del(id: number) {
  if (!confirm('确定删除？')) return
  await deleteMemo(id)
  load()
  loadLocations()
}

async function retry() {
  await load()
  await loadLocations()
}

const emptyText = computed(() => {
  if (searchQuery.value) return '未找到匹配'
  if (locFilter.value || tagFilter.value.trim()) return '当前筛选无笔记'
  if (filter.value === 'active') return '暂无活跃笔记'
  if (filter.value === 'done') return '暂无已完成'
  return '暂无笔记'
})

onMounted(() => {
  load()
  loadLocations()
})
</script>

<template>
  <div class="list">
    <van-search
      v-model="searchQuery"
      shape="round"
      placeholder="搜索备忘录"
      @search="onSearchEnter"
      @clear="onSearchChange"
      @update:model-value="onSearchChange"
    />

    <van-tabs v-model:active="filter" @change="onFilterChange">
      <van-tab name="all" title="全部" />
      <van-tab name="active" title="活跃" />
      <van-tab name="done" title="已完成" />
    </van-tabs>

    <div class="loc-filters" v-if="allLocations.length">
      <div class="loc-field loc-dropdown">
        <van-dropdown-menu :active-color="'#4a90d9'" :overlay="true">
          <van-dropdown-item v-model="locFilter" :options="locOptions" @change="load()" />
        </van-dropdown-menu>
      </div>
      <div class="loc-field loc-tag">
        <van-field
          v-model="tagFilter"
          placeholder="标签"
          left-icon="label-o"
          @keydown.enter="load()"
        />
      </div>
    </div>

    <div v-if="loading" class="loading-wrap">
      <van-loading type="spinner" vertical>加载中...</van-loading>
    </div>

    <div v-else-if="loadError" class="empty-wrap">
      <van-empty>
        <template #description>
          <span class="empty-err"><van-icon name="warning-o" size="13" /> {{ loadError }}</span>
        </template>
      </van-empty>
      <div class="retry-wrap">
        <van-button round type="primary" size="small" @click="retry">重试</van-button>
      </div>
    </div>

    <div v-else-if="!items.length" class="empty-wrap">
      <van-empty :description="emptyText" />
    </div>

    <div v-else class="cards">
      <div v-for="m in items" :key="m.id" class="card" :class="{ done: m.status === 'done' }">
        <div class="key-row" v-if="m.event || m.due_date || m.location">
          <span class="k k-event" v-if="m.event"><van-icon name="flag-o" size="12" /> {{ m.event }}</span>
          <span class="k k-time" v-if="m.due_date"><van-icon name="clock-o" size="12" /> {{ m.due_date }}</span>
          <span class="k k-loc" v-if="m.location"><van-icon name="location-o" size="12" /> {{ m.location }}</span>
        </div>
        <div class="card-head">
          <van-icon
            :name="m.status === 'done' ? 'success' : 'circle'"
            :color="m.status === 'done' ? '#4caf50' : '#e53935'"
            size="16"
          />
          <strong>{{ m.title }}</strong>
        </div>
        <div class="card-body">{{ m.content.slice(0, 120) }}</div>
        <div class="card-meta">
          <van-tag v-for="t in m.tags" :key="t" type="primary" plain>{{ t }}</van-tag>
        </div>
        <div class="card-time">
          <van-icon name="clock-o" size="12" />
          <span>创建 {{ fmtMinute(m.created_at) }}<span v-if="m.updated_at && fmtMinute(m.updated_at) !== fmtMinute(m.created_at)"> · 更新 {{ fmtMinute(m.updated_at) }}</span></span>
        </div>
        <div class="card-actions">
          <van-button
            size="small"
            :icon="m.status === 'done' ? 'replay' : 'success'"
            @click="toggleStatus(m)"
          >{{ m.status === 'done' ? '恢复' : '完成' }}</van-button>
          <van-button size="small" type="danger" icon="delete-o" @click="del(m.id)" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 自身撑满可用高度并承接滚动（父级是 .page-scroll） */
.list {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 12px;
}
.loading-wrap { text-align: center; padding: 60px 0; }
.empty-wrap { padding: 20px 0; }
.empty-err { display: inline-flex; align-items: center; gap: 4px; color: #b26a00; }
.retry-wrap { text-align: center; padding-bottom: 20px; }
.loc-filters { display: flex; gap: 8px; align-items: center; margin: 8px 12px 12px; flex-wrap: wrap; }
.loc-field {
  flex: 0 0 auto;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
}
.loc-dropdown {
  min-width: 110px;
}
/* 让 van-dropdown-menu 内部 bar 贴合容器，无额外阴影 */
.loc-dropdown :deep(.van-dropdown-menu__bar) {
  height: 32px;
  box-shadow: none;
  border: 1px solid #ebedf0;
  border-radius: 8px;
  padding: 0 8px;
}
.loc-tag {
  flex: 1;
  min-width: 120px;
}
.loc-tag :deep(.van-field) {
  padding: 6px 8px;
}
.loc-tag :deep(.van-field .van-cell__title) {
  display: none;
}
.loc-tag :deep(.van-field .van-field__left-icon) {
  margin-right: 6px;
  color: #888;
}
.loc-label { display: inline-flex; align-items: center; color: #888; }
.cards { padding: 0 12px; display: flex; flex-direction: column; gap: 10px; }
.card { background: #fafafa; border-radius: 10px; padding: 12px; border-left: 4px solid #4a90d9; }
.card.done { border-left-color: #aaa; opacity: .6; }
.key-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed #e0e0e0; }
.k { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
.k-event { background: #e8f0fe; color: #1976d2; }
.k-time { background: #fff3cd; color: #b26a00; }
.k-loc { background: #e8f5e9; color: #2e7d32; }
.card-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.card-body { font-size: 14px; color: #555; margin-bottom: 6px; }
.card-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; min-height: 0; }
.card-time { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #9aa0a6; margin-bottom: 8px; }
.card-actions { display: flex; gap: 8px; }
</style>
