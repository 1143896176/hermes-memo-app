<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
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
const msgOk = ref(false)

async function load() {
  try {
    items.value = search.value
      ? await searchKnowledge(search.value)
      : await fetchKnowledge()
  } catch {}
}

// 输入即搜：加防抖，避免每敲一个字符都打一次接口
let searchTimer: any = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { load() }, 250)
}
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer) })

function startNew() {
  editing.value = { title: '', content: '', tags: [], linked_memo_id: null }
}

function editItem(item: KnowledgeItem) {
  editing.value = { ...item, tags: [...(item.tags || [])] }
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
    msgOk.value = true
    msg.value = '已保存'
    setTimeout(() => { msg.value = '' }, 1500)
    await load()
  } catch (e: any) {
    msgOk.value = false
    msg.value = e?.message || '保存失败'
  }
}

async function remove(id: number) {
  if (!confirm('确定删除这条知识？')) return
  try {
    await deleteKnowledge(id)
    await load()
  } catch {}
}

function cancel() { editing.value = null }

function addTag(tag: string) {
  if (!tag.trim() || !editing.value) return
  editing.value.tags = [...(editing.value.tags || []), tag.trim()]
  newTag.value = ''
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
      <van-search
        v-model="search"
        shape="round"
        placeholder="搜索知识..."
        @search="load"
        @clear="load"
        @update:model-value="onSearchInput"
      />
      <van-button type="primary" size="small" icon="plus" class="add-btn" @click="startNew">新建</van-button>
    </div>

    <p v-if="msg" class="msg" :class="msgOk ? 'ok' : 'err'">
      <van-icon :name="msgOk ? 'passed' : 'warning-o'" size="12" /> {{ msg }}
    </p>

    <div v-if="editing" class="edit-form">
      <van-field v-model="editing.title" label="标题" placeholder="标题" />
      <van-field v-model="editing.content" type="textarea" rows="8" label="内容" placeholder="详细内容（操作步骤、注意事项...）" />
      <div class="f-tags">
        <van-tag v-for="(t, i) in editing.tags" :key="i" closeable @close="removeTag(i)">{{ t }}</van-tag>
        <van-field v-model="newTag" placeholder="添加标签" class="tag-input" @keydown.enter="addTag(newTag)" />
      </div>
      <div class="f-actions">
        <van-button type="primary" @click="save">保存</van-button>
        <van-button @click="cancel">取消</van-button>
      </div>
    </div>

    <div v-else class="list">
      <van-cell-group v-if="items.length" inset>
        <van-cell
          v-for="it in items"
          :key="it.id"
          :title="it.title"
          is-link
          @click="editItem(it)"
        >
          <template #label>
            <div class="item-label">
              <p class="item-content">{{ it.content.slice(0, 120) }}{{ it.content.length > 120 ? '...' : '' }}</p>
              <div v-if="it.tags?.length" class="item-tags">
                <van-tag v-for="t in it.tags" :key="t" size="small" plain type="primary">{{ t }}</van-tag>
              </div>
              <div class="item-foot">
                <span class="item-date">{{ it.updated_at?.slice(0, 10) }}</span>
                <van-button size="mini" type="danger" plain @click.stop="remove(it.id)">删除</van-button>
              </div>
            </div>
          </template>
        </van-cell>
      </van-cell-group>
      <div v-else class="empty-wrap">
        <van-empty description="暂无知识条目。点「+ 新建」添加第一条。" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; margin-bottom: 12px; line-height: 1.6; }
.bar { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; }
.bar :deep(.van-search) { flex: 1; padding: 0; }
.add-btn { flex-shrink: 0; }
.edit-form { background: #f9f9f9; padding: 12px; border-radius: 10px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.f-tags { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.tag-input { flex: 1; min-width: 90px; padding: 0; }
.f-actions { display: flex; gap: 8px; }
.item-label { margin-top: 4px; }
.item-content { font-size: 13px; color: #555; line-height: 1.5; }
.item-tags { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.item-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.item-date { font-size: 11px; color: #999; }
.empty-wrap { padding: 20px 0; }
.msg { font-size: 12px; padding: 6px 8px; border-radius: 6px; margin-bottom: 8px; }
.msg .van-icon { vertical-align: -2px; margin-right: 2px; }
.msg.ok { background: #e8f5e9; color: #2e7d32; }
.msg.err { background: #fdecea; color: #c62828; }
</style>
