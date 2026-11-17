<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
    <!-- 标题由弹框头部统一渲染，这里不再重复一次 -->
    <p class="desc">录入常见错别字，生成草稿时自动修正。</p>
    <div class="add-form">
      <input v-model="wrong" placeholder="错误词" />
      <span class="arrow">→</span>
      <input v-model="correct" placeholder="正确词" />
      <button @click="add">添加</button>
    </div>
    <div class="terms">
      <div v-for="t in terms" :key="t.id" class="term-row">
        <span class="wrong">{{ t.wrong_term }}</span>
        <span>→</span>
        <span class="correct">{{ t.correct_term }}</span>
        <span class="count">×{{ t.count }}</span>
        <button class="del" @click="remove(t.id)">×</button>
      </div>
      <div v-if="!terms.length" class="empty">暂无术语</div>
    </div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; }
.desc { font-size: 12px; color: #888; line-height: 1.6; margin-bottom: 12px; }
/* 窄屏（手机）下 4 个元素一行会挤成一团，允许换行：两个输入框一行，按钮独占一行 */
.add-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 16px; }
.add-form input {
  flex: 1 1 38%; min-width: 0; padding: 9px 10px;
  border: 1px solid #ddd; border-radius: 8px; font-size: 14px;
  transition: border-color .15s, box-shadow .15s;
}
.add-form input:focus {
  outline: none; border-color: #4a90d9;
  box-shadow: 0 0 0 3px rgba(74,144,217,.12);
}
.add-form input::placeholder { color: #bbb; }
.add-form .arrow { color: #aaa; font-size: 14px; }
.add-form button {
  flex: 0 0 100%; padding: 9px; background: #4a90d9; color: #fff;
  border: none; border-radius: 8px; cursor: pointer; font-size: 14px;
}
.add-form button:active { background: #3d7fc4; }
.term-row { display: flex; gap: 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; font-size: 14px; }
.wrong { color: #e55; text-decoration: line-through; }
.correct { color: #4a8; font-weight: 600; }
.count { color: #999; font-size: 12px; margin-left: auto; }
.del { background: none; border: none; color: #e55; font-size: 18px; cursor: pointer; padding: 0 6px; line-height: 1; }
.empty { text-align: center; color: #999; padding: 20px; font-size: 13px; }
</style>