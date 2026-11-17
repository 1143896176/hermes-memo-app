# Hermes Memo App — Vant UI 重写计划书

## 前置条件

### 安装 Vant 4
```bash
pnpm add vant
```

### 入口配置
`src/main.ts` 加一行：
```ts
import 'vant/lib/index.css'
```

### ⚠️ pnpm + capacitor-nodejs CMake 问题
pnpm 虚拟存储会导致 Gradle CMake 找不到路径。在 `.npmrc` 中配置：
```
public-hoist-pattern[]=*capacitor-nodejs*
shamefully-hoist=true
```
然后 `rm -rf node_modules && pnpm install` 重装。

---

## 重写计划（按优先级）

### 1. App.vue — 主框架 ⭐ 最优先
**当前状态**：自定义 header + 自定义 tabs + 自定义 overlay + FAB
**目标**：Vant 组件替代

| 原组件 | Vant 替换 |
|--------|----------|
| `<header>` + 标题 + ⚙️ 按钮 | `<van-nav-bar title="智能备忘录" @click-right="..." />` |
| `<div class="settings-dropdown">` | `<van-action-sheet v-model:show="..." :actions="[...]">` |
| `<div class="overlay">` 设置弹出 | `<van-popup v-model:show="..." position="bottom" :style="{ height: '85%' }">` |
| `<div class="main-tabs">` | `<van-tabbar v-model="mainTab">` 底部导航 |
| `<button class="fab">＋</button>` | `<van-floating-bubble icon="add">` |

**注意**：
- `v-model:show` 不能直接绑 `!!settingsPanel`（表达式不可用作 v-model），需要一个 `showSettings: boolean` 和 `settingsPanel: string|null` 两个 ref 配合
- Popup 内的 NavBar 用 `@click-left` 关闭
- 旧的 `style.css` 和 `<style>` 块删除，Vant 自带 reset

### 2. MemoList.vue
**当前**：自定义搜索框 + 三个 filter 按钮 + 自定义卡片
**目标**：

| 原组件 | Vant 替换 |
|--------|----------|
| 搜索框 `<input>` | `<van-search v-model="searchQuery" shape="round" @search="load">` |
| 三个 filter 按钮 | `<van-tabs v-model:active="filter" @change="load">` |
| 卡片列表 | `<van-cell-group inset>` + `<van-swipe-cell>` |
| 标签 | `<van-tag type="primary" plain>` |
| 空态 | `<van-empty>` |
| 加载中 | `<van-loading>` |

### 3. AgentChat.vue
**当前**：自定义聊天 bubble + textarea + 按钮
**目标**：

| 原组件 | Vant 替换 |
|--------|----------|
| 消息气泡 | 保留自定义样式，只换外层 |
| `<textarea>` | `<van-field v-model="input" autosize>` |
| 发送/语音按钮 | `<van-button type="primary" :loading="loading">` |
| 快捷指令按钮 | `<van-button size="small" plain>` |

### 4. SettingsPanel.vue
**当前**：自定义 label + input + button
**目标**：全部用 `<van-field>` + `<van-button>`

```html
<van-field v-model="apiKey1" type="password" label="LLM Key" placeholder="OpenRouter Key" />
<van-field v-model="apiBase" label="LLM 地址" />
<van-field v-model="modelName" label="模型" />
<!-- ... -->
<van-button block type="primary" @click="save">保存</van-button>
```

### 5. 其他面板（低优先级）
- **GlossaryPanel** — `<van-field>` + `<van-tag>` + `<van-button>`
- **MemoryPanel** — `<van-tabs>` 切换记忆/技能 + `<van-field>` + `<van-tag>`
- **KnowledgePanel** — `<van-search>` + `<van-cell-group>` + `<van-swipe-cell>`
- **ExportPanel** — `<van-checkbox-group>` + `<van-button>`

---

## 关键注意事项

1. **v-model:show 陷阱**：Vant 的 `<van-popup v-model:show>` 要求表达式必须是可赋值的 ref，不能是 `!!ref` 这种计算表达式
2. **样式冲突**：删除旧的 `src/style.css`、各组件的 `<style scoped>` 大部分可删，Vant 自带样式
3. **destroy-on-close**：Popup 关闭后内部组件状态会丢失，如需保留用 `<keep-alive>`
4. **safe-area**：顶部 NavBar 和底部 Tabbar 用 `safe-area-inset-top/bottom` 属性自动适配
5. **构建验证**：每次改完一个组件立即 `vite build` 验证，不要一次改多个

---

## 分支策略
- `master` — 稳定版，当前运行的代码
- `ui-optimize` — Vant UI 重写分支，可随时切回 master

回退命令：`git checkout master`

---

## 当前各组件文件路径（共 10 个 Vue 文件）
```
src/App.vue                     # 主框架 ⭐
src/components/MemoList.vue     # 备忘录列表 ⭐
src/components/MemoInput.vue    # 录入面板
src/components/AgentChat.vue    # Agent 对话 ⭐
src/components/DraftCard.vue    # 草稿确认卡片
src/components/SettingsPanel.vue # API 设置 ⭐
src/components/GlossaryPanel.vue # 术语词典
src/components/MemoryPanel.vue   # 记忆/技能
src/components/KnowledgePanel.vue # 知识库
src/components/ExportPanel.vue   # 导出/导入
```

⭐ = 优先重写