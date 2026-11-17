<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  getMemoryProfile, setMemoryProfile,
  listSkills, saveSkill, deleteSkill,
} from '../services/api'

type Tab = 'memory' | 'skills'
const tab = ref<Tab>('memory')

// ── 记忆 / 用户画像 ──
const memory = ref('')
const user = ref('')
const saved = ref(false)

async function loadProfile() {
  const p = await getMemoryProfile()
  memory.value = p.memory
  user.value = p.user
}

async function saveProfile() {
  await setMemoryProfile(memory.value, user.value)
  saved.value = true
  setTimeout(() => saved.value = false, 2000)
}

// ── Skills ──
const skills = ref<any[]>([])
const newSkillName = ref('')
const newSkillContent = ref('')
const editingSkill = ref<any | null>(null)
const viewingSkill = ref<any | null>(null)

async function loadSkills() {
  const r = await listSkills()
  skills.value = r.skills
}

async function addOrUpdateSkill() {
  if (!newSkillName.value.trim() || !newSkillContent.value.trim()) return
  await saveSkill(newSkillName.value.trim(), newSkillContent.value)
  newSkillName.value = ''
  newSkillContent.value = ''
  editingSkill.value = null
  loadSkills()
}

function editSkill(s: any) {
  editingSkill.value = s
  newSkillName.value = s.name
  newSkillContent.value = s.content
  viewingSkill.value = null
}

function viewSkill(s: any) {
  viewingSkill.value = s
  editingSkill.value = null
}

const deletingName = ref<string | null>(null)

async function removeSkill(name: string) {
  deletingName.value = name
}

async function doDeleteSkill() {
  const name = deletingName.value
  if (!name) return
  deletingName.value = null
  await deleteSkill(name)
  if (editingSkill.value?.name === name) {
    editingSkill.value = null
    newSkillName.value = ''
    newSkillContent.value = ''
  }
  loadSkills()
}

onMounted(() => { loadProfile(); loadSkills() })
</script>

<template>
  <div class="panel">
    <!-- Tab 切换 -->
    <div class="tabs">
      <button :class="{ sel: tab === 'memory' }" @click="tab = 'memory'">🧠 记忆与画像</button>
      <button :class="{ sel: tab === 'skills' }" @click="tab = 'skills'">⚡ 技能</button>
    </div>

    <!-- 记忆 / 画像 -->
    <div v-if="tab === 'memory'">
      <p class="desc">
        MEMORY.md 持久记忆 + USER.md 用户画像，会注入到 LLM 的系统提示词，
        让助手更懂你。每次生成草稿时自动加载。
      </p>

      <label>👤 用户画像 (USER.md)</label>
      <textarea v-model="user" rows="6" placeholder="例如：&#10;用户是程序员，常用术语：G代码、刀轨、A2UI&#10;偏好简洁回复&#10;工作日在北京" />

      <label>🧠 持久记忆 (MEMORY.md)</label>
      <textarea v-model="memory" rows="8" placeholder="例如：&#10;常用地点：公司（海淀）、家（朝阳）&#10;每周五下午有周会&#10;对花粉过敏" />

      <button class="save-btn" @click="saveProfile">
        {{ saved ? '✅ 已保存' : '💾 保存' }}
      </button>
    </div>

    <!-- Skills -->
    <div v-else>
      <p class="desc">技能是 markdown 写的过程知识，可被复用。本地存储。</p>

      <!-- 删除确认条 -->
      <div v-if="deletingName" class="delete-confirm">
        <span>确认删除「{{ deletingName }}」？</span>
        <button class="d-yes" @click="doDeleteSkill">删除</button>
        <button class="d-no" @click="deletingName = null">取消</button>
      </div>

      <div class="skill-form">
        <input v-model="newSkillName" placeholder="技能名（如 meeting-notes）" />
        <textarea v-model="newSkillContent" rows="4" placeholder="技能内容（markdown）" />
        <button @click="addOrUpdateSkill">{{ editingSkill ? '✏️ 更新' : '➕ 添加' }}</button>
        <button v-if="editingSkill" class="cancel" @click="editingSkill = null; newSkillName = ''; newSkillContent = ''">取消</button>
      </div>

      <div class="skill-list">
        <div v-for="s in skills" :key="s.id" class="skill-row">
          <div class="skill-info" @click="viewSkill(s)">
            <strong>{{ s.name }}</strong>
            <span class="meta">{{ (s.content || '').slice(0, 60) }}{{ s.content.length > 60 ? '...' : '' }}</span>
          </div>
          <div class="row-actions">
            <button @click="editSkill(s)">✏️</button>
            <button class="del" @click="removeSkill(s.name)">🗑</button>
          </div>
        </div>
        <div v-if="!skills.length" class="empty">暂无技能</div>
      </div>

      <!-- 技能查看 -->
      <div v-if="viewingSkill" class="skill-view">
        <div class="skill-view-head">
          <strong>{{ viewingSkill.name }}</strong>
          <button @click="viewingSkill = null">✕</button>
        </div>
        <pre class="skill-view-content">{{ viewingSkill.content }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #eee; }
.tabs button {
  padding: 8px 12px; border: none; background: none; cursor: pointer;
  font-size: 14px; border-bottom: 2px solid transparent; color: #666;
}
.tabs button.sel { color: #4a90d9; border-bottom-color: #4a90d9; }
.desc { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 14px; }
label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; color: #444; }
textarea {
  display: block; width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;
  font-size: 13px; font-family: inherit; line-height: 1.6; color: #333;
  /* 移动端禁用拖拽改高，避免手指误触把弹框顶变形 */
  resize: none;
  transition: border-color .15s, box-shadow .15s;
}
textarea:focus, .skill-form input:focus {
  outline: none; border-color: #4a90d9;
  box-shadow: 0 0 0 3px rgba(74,144,217,.12);
}
textarea::placeholder, .skill-form input::placeholder { color: #bbb; }
.save-btn {
  width: 100%; margin-top: 16px; padding: 12px;
  background: #4a90d9; color: #fff; border: none; border-radius: 10px;
  font-size: 15px; cursor: pointer;
}
.save-btn:active { background: #3d7fc4; }
.skill-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.skill-form input, .skill-form textarea {
  padding: 8px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px;
}
.skill-form button {
  padding: 8px; background: #4a90d9; color: #fff;
  border: none; border-radius: 8px; cursor: pointer; font-size: 13px;
}
.skill-form .cancel { background: #eee; color: #666; }
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-row {
  display: grid; grid-template-columns: 1fr auto; gap: 4px;
  padding: 10px; border: 1px solid #eee; border-radius: 8px;
}
.skill-info { cursor: pointer; min-width: 0; }
.skill-row strong { font-size: 13px; display: block; }
.skill-row .meta { font-size: 12px; color: #888; }
.skill-view { margin-top: 12px; background: #f9f9f9; border-radius: 10px; padding: 12px; }
.skill-view-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.skill-view-head strong { font-size: 14px; }
.skill-view-head button { padding: 2px 8px; border: 1px solid #ddd; background: #fff; border-radius: 4px; cursor: pointer; font-size: 14px; }
.skill-view-content {
  white-space: pre-wrap; word-break: break-word; font-size: 12px;
  font-family: monospace; line-height: 1.6; color: #333; max-height: 300px;
  overflow-y: auto; background: #fff; padding: 10px; border-radius: 8px; margin: 0;
}
.delete-confirm {
  display: flex; align-items: center; gap: 8px; padding: 10px;
  background: #fdecea; border-radius: 8px; margin-bottom: 12px; font-size: 13px;
}
.delete-confirm span { flex: 1; color: #c62828; }
.d-yes { padding: 6px 14px; background: #e55; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.d-no { padding: 6px 14px; background: #eee; color: #666; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; font-size: 13px; }
.row-actions { display: flex; gap: 4px; }
.row-actions button { padding: 2px 8px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; }
.row-actions .del { color: #e55; }
.empty { text-align: center; color: #999; padding: 20px; font-size: 13px; }
</style>