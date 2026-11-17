<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Search, CellGroup, Cell, SwipeCell, Empty, Button, Tag } from 'vant'
import { fetchKnowledge, searchKnowledge, saveKnowledge, deleteKnowledge } from '../services/node-bridge'

interface KnowledgeItem {
  id: number; title: string; content: string; tags: string[]
  linked_memo_id: number | null; created_at: string; updated_at: string
}

const items = ref<KnowledgeItem[]>([])
const search = ref('')
const editing = ref<Partial<KnowledgeItem> | null>(null)
const newTag = ref('')
const msg = ref('')

async function load() {
  try {
    items.value = search.value
      ? await searchKnowledge(search.value)
      : await fetchKnowledge()
  } catch {}
}

function startNew() {
  editing.value = { title: '', content: '', tags: [], linked_memo_id: null }
}

function editItem(item: KnowledgeItem) {
  editing.value = { ...item, tags: [...item.tags] }
}

async function save() {
  if (!editing.value?.title?.trim() || !editing.value?.content?.trim()) return
  try {
    await saveKnowledge({
      id: editing.value.id,
      title: editing.value.title.trim(),
      content: editing.value.content.trim(),
      tags: editing.value.tags || [],
      linked_memo_id: editing.value.linked_memo_id || null,
    })
    editing.value = null
    msg.value = '\u2705 已保存'
    setTimeout(() => msg.value = '', 1500)
    await load()
  } catch (e: any) {
    msg.value = '\u274c ' + (e?.message || '保存失败')
  }
}

async function remove(id: number) {
  try {
    await deleteKnowledge(id)
    await load()
  } catch {}
}

function cancel() { editing.value = null }
function addTag(tag: string) {
  if (!tag.trim() || !editing.value) return
  editing.value.tags = [...(editing.value.tags || []), tag.trim()]
}
function removeTag(i: number) {
  if (!editing.value) return
  editing.value.tags = editing.value.tags?.filter((_, j) => j !== i)
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <p class="desc">知识库：记录操作流程、注意事项、经验教训。Agent 对话时可搜索引用。</p>

    <div class="bar">
      <van-search v-model="search" shape="round" placeholder="搜索知识..." @search="load" @clear="load" @update:model-value="load" />
      <van-button type="primary" size="small" @click="startNew" class="add-btn">+ 新建</van-button>
    </div>

    <p v-if="msg" class="msg">{{ msg }}</p>

    <div v-if="editing" class="edit-form">
      <van-field v-model="editing.title" label="标题" placeholder="标题" />
      <van-field v-model="editing.content" type="textarea" rows="8" label="内容" placeholder="详细内容（操作步骤、注意事项...）" />
      <div class="f-tags">
        <van-tag v-for="(t, i) in editing.tags" :key="i" closeable @close="removeTag(i)">{{ t }}</van-tag>
        <van-field v-model="newTag" placeholder="添加标签" @keydown.enter="addTag(newTag); newTag=''" class="tag-input" />
      </div>
      <div class="f-actions">
        <van-button type="primary" @click="save">保存</van-button>
        <van-button @click="cancel">取消</van-button>
      </div>
    </div>

    <div v-if="!editing" class="list">
      <van-cell-group inset>
        <van-swipe-cell v-for="it in items" :key="it.id">
          <van-cell :title="it.title" :label="it.content.slice(0, 120) + (it.content.length > 120 ? '...' : '')" is-link @click="editItem(it)">
            <template #default>
              <span class="item-date">{{ it.updated_at?.slice(0, 10) }}</span>
            </template>
            <template #label>
              <div>
                <span class="item-label-text">{{ it.content.slice(0, 120) }}{{ it.content.length > 120 ? '...' : '' }}</span>
                <div v-if="it.tags?.length" class="item-tags">
                  <van-tag v-for="t in it.tags" :key="t" size="small" plain type="primary">{{ t }}</van-tag>
                </div>
              </div>
            </template>
          </van-cell>
        </van-swipe-cell>
      </van-cell-group>
      <div v-if="!items.length" class="empty-wrap">
        <van-empty description="暂无知识条目。点「+ 新建」添加第一条。" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; margin-bottom: 12px; }
.bar { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; }
.bar :deep(.van-search) { flex: 1; padding: 0; }
.add-btn { flex-shrink: 0; }
.edit-form { background: #f9f9f9; padding: 12px; border-radius: 10px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.f-tags { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.tag-input { flex: 1; min-width: 80px; padding: 0; }
.f-actions { display: flex; gap: 8px; }
.item-date { font-size: 11px; color: #999; }
.item-label-text { font-size: 13px; color: #555; }
.item-tags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
.empty-wrap { padding: 20px 0; }
.msg { font-size: 12px; padding: 6px; border-radius: 6px; margin-bottom: 8px; }
</style>