<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Field, Button, Tag } from 'vant'
import { fetchGlossary, addGlossary, removeGlossary } from '../services/api'

const terms = ref<any[]>([])
const wrong = ref('')
const correct = ref('')

async function load() {
  const data = await fetchGlossary()
  terms.value = data.terms
}
async function add() {
  if (!wrong.value || !correct.value) return
  await addGlossary(wrong.value, correct.value)
  wrong.value = ''; correct.value = ''; load()
}
async function remove(id: number) {
  await removeGlossary(id)
  load()
}
onMounted(load)
</script>

<template>
  <div class="panel">
    <p class="desc">录入常见错别字，生成草稿时自动修正。</p>
    <div class="add-form">
      <van-field v-model="wrong" placeholder="错误词" class="add-field" />
      <span class="arrow">→</span>
      <van-field v-model="correct" placeholder="正确词" class="add-field" />
      <van-button block type="primary" size="small" @click="add">添加</van-button>
    </div>
    <div class="terms">
      <div v-for="t in terms" :key="t.id" class="term-row">
        <span class="wrong">{{ t.wrong_term }}</span>
        <span>→</span>
        <span class="correct">{{ t.correct_term }}</span>
        <van-tag type="warning" size="small" plain>×{{ t.count }}</van-tag>
        <van-button size="mini" type="danger" icon="cross" @click="remove(t.id)" />
      </div>
      <div v-if="!terms.length" class="empty">暂无术语</div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 12px; }
.add-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 16px; }
.add-field { flex: 1 1 38%; min-width: 0; padding: 0; }
.arrow { color: #aaa; font-size: 14px; }
.term-row { display: flex; gap: 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; font-size: 14px; }
.wrong { color: #e55; text-decoration: line-through; }
.correct { color: #4a8; font-weight: 600; }
.empty { text-align: center; color: #999; padding: 20px; font-size: 13px; }
</style>