<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Tabs, Tab, Field, Button, Tag } from 'vant'
import {
  getMemoryProfile, setMemoryProfile,
  listSkills, saveSkill, deleteSkill,
} from '../services/api'

// 注意：不能命名为 Tab，会与上方 import { Tab } from 'vant' 冲突
type TabKey = 'memory' | 'skills'
const tab = ref<TabKey>('memory')

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
    <van-tabs v-model:active="tab" shrink>
      <van-tab name="memory">
        <template #title><van-icon name="bulb-o" size="14" class="tab-ico" />记忆与画像</template>
      </van-tab>
      <van-tab name="skills">
        <template #title><van-icon name="fire-o" size="14" class="tab-ico" />技能</template>
      </van-tab>
    </van-tabs>

    <div v-if="tab === 'memory'">
      <p class="desc">
        MEMORY.md 持久记忆 + USER.md 用户画像，会注入到 LLM 的系统提示词，
        让助手更懂你。每次生成草稿时自动加载。
      </p>

      <van-cell-group inset class="field-group">
        <van-field
          v-model="user"
          type="textarea"
          rows="5"
          label="用户画像"
          placeholder="例如：用户是程序员，常用术语：G代码、刀轨、A2UI&#10;偏好简洁回复&#10;工作日在北京"
        />
        <van-field
          v-model="memory"
          type="textarea"
          rows="6"
          label="持久记忆"
          placeholder="例如：常用地点：公司（海淀）、家（朝阳）&#10;每周五下午有周会&#10;对花粉过敏"
        />
      </van-cell-group>

      <div class="save-wrap">
        <van-button block type="primary" :icon="saved ? 'success' : 'passed'" @click="saveProfile">{{ saved ? '已保存' : '保存' }}</van-button>
      </div>
    </div>

    <div v-else>
      <p class="desc">技能是 markdown 写的过程知识，可被复用。本地存储。</p>

      <div v-if="deletingName" class="delete-confirm">
        <span>确认删除「{{ deletingName }}」？</span>
        <van-button size="small" type="danger" @click="doDeleteSkill">删除</van-button>
        <van-button size="small" @click="deletingName = null">取消</van-button>
      </div>

      <div class="skill-form">
        <van-field v-model="newSkillName" placeholder="技能名（如 meeting-notes）" />
        <van-field v-model="newSkillContent" type="textarea" rows="4" placeholder="技能内容（markdown）" />
        <van-button block type="primary" size="small" :icon="editingSkill ? 'edit' : 'plus'" @click="addOrUpdateSkill">{{ editingSkill ? '更新' : '添加' }}</van-button>
        <van-button v-if="editingSkill" block size="small" @click="editingSkill = null; newSkillName = ''; newSkillContent = ''">取消</van-button>
      </div>

      <div class="skill-list">
        <div v-for="s in skills" :key="s.id" class="skill-row">
          <div class="skill-info" @click="viewSkill(s)">
            <strong>{{ s.name }}</strong>
            <span class="meta">{{ (s.content || '').slice(0, 60) }}{{ s.content.length > 60 ? '...' : '' }}</span>
          </div>
          <div class="row-actions">
            <van-button size="mini" icon="edit" @click="editSkill(s)" />
            <van-button size="mini" type="danger" icon="delete-o" @click="removeSkill(s.name)" />
          </div>
        </div>
        <div v-if="!skills.length" class="empty">暂无技能</div>
      </div>

      <div v-if="viewingSkill" class="skill-view">
        <div class="skill-view-head">
          <strong>{{ viewingSkill.name }}</strong>
          <van-button size="mini" icon="cross" @click="viewingSkill = null" />
        </div>
        <pre class="skill-view-content">{{ viewingSkill.content }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.tab-ico { margin-right: 4px; vertical-align: -2px; }
.desc { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 14px; }
.field-group { margin: 0 0 16px; }
.save-wrap { margin-top: 16px; }
.skill-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
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
.row-actions { display: flex; gap: 4px; }
.empty { text-align: center; color: #999; padding: 20px; font-size: 13px; }
</style>