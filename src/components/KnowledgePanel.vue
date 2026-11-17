<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { fetchKnowledge, searchKnowledge, saveKnowledge, deleteKnowledge } from '../services/node-bridge'

interface KnowledgeItem {
  id: number; title: string; content: string; tags: string[]
  linked_memo_id: number | null; created_at: string; updated_at: string
}

const items = ref<KnowledgeItem[]>([])
const search = ref('')
const editing = ref<Partial<KnowledgeItem> | null>(null)
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
      <input v-model="search" placeholder="搜索知识..." @input="load" class="search-input" />
      <button @click="load">🔍</button>
      <button @click="startNew" class="add-btn">+ 新建</button>
    </div>

    <p v-if="msg" class="msg">{{ msg }}</p>

    <!-- 编辑表单 -->
    <div v-if="editing" class="edit-form">
      <input v-model="editing.title" placeholder="标题" class="f-title" />
      <textarea v-model="editing.content" placeholder="详细内容（操作步骤、注意事项...）" rows="8" class="f-content" />
      <div class="f-tags">
        <span v-for="(t, i) in editing.tags" :key="i" class="tag">{{ t }} <button @click="removeTag(i)">×</button></span>
        <input v-model="newTag" placeholder="添加标签" @keydown.enter="addTag(newTag); newTag=''" class="tag-input" />
      </div>
      <div class="f-actions">
        <button @click="save" class="save-btn">保存</button>
        <button @click="cancel" class="cancel-btn">取消</button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="!editing" class="list">
      <div v-for="it in items" :key="it.id" class="item">
        <div class="item-header" @click="editItem(it)">
          <strong>{{ it.title }}</strong>
          <span class="item-date">{{ it.updated_at?.slice(0, 10) }}</span>
        </div>
        <p class="item-content">{{ it.content.slice(0, 120) }}{{ it.content.length > 120 ? '...' : '' }}</p>
        <p v-if="it.tags?.length" class="item-tags">
          <span v-for="t in it.tags" :key="t" class="tag">{{ t }}</span>
        </p>
        <button class="del-btn" @click.stop="remove(it.id)">删除</button>
      </div>
      <p v-if="!items.length" class="empty">暂无知识条目。点「+ 新建」添加第一条。</p>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; margin-bottom: 12px; }
.bar { display: flex; gap: 6px; margin-bottom: 12px; }
.search-input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
.bar button { padding: 8px 12px; background: #eee; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; cursor: pointer; }
.add-btn { background: #4a90d9; color: #fff; border-color: #4a90d9; }

.edit-form { background: #f9f9f9; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
.f-title { display: block; width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 8px; }
.f-content { display: block; width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical; margin-bottom: 8px; }
.f-tags { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 10px; }
.tag { display: inline-flex; align-items: center; gap: 2px; padding: 3px 8px; background: #e3f2fd; border-radius: 12px; font-size: 12px; }
.tag button { padding: 0 3px; border: none; background: none; color: #999; cursor: pointer; font-size: 14px; }
.tag-input { border: none; outline: none; font-size: 12px; padding: 4px; width: 80px; }
.f-actions { display: flex; gap: 8px; }
.save-btn { padding: 8px 20px; background: #4a90d9; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
.cancel-btn { padding: 8px 20px; background: #eee; border: 1px solid #ddd; border-radius: 8px; cursor: pointer; }

.list { display: flex; flex-direction: column; gap: 8px; }
.item { background: #fff; border: 1px solid #eee; border-radius: 10px; padding: 10px; position: relative; }
.item-header { cursor: pointer; display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.item-header strong { font-size: 14px; }
.item-date { font-size: 11px; color: #999; }
.item-content { font-size: 13px; color: #555; margin: 0; line-height: 1.5; }
.item-tags { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.del-btn { position: absolute; top: 8px; right: 8px; padding: 2px 8px; background: #fee; border: 1px solid #fcc; border-radius: 6px; font-size: 12px; color: #c62828; cursor: pointer; }
.empty { text-align: center; color: #999; font-size: 13px; padding: 20px; }
.msg { font-size: 12px; padding: 6px; border-radius: 6px; margin-bottom: 8px; }
</style>