# opencode 任务书 — Vant UI 全量重写 + 打包完整性

> 目标读者：opencode（执行者）。主 Agent 只做诊断/验收，不写代码。
> 分支：`ui-optimize`（已切）。基线计划书：`.hermes/plans/ui-optimize-plan.md`（必读，本任务书是其执行细化版）。

## 0. 总目标

把 hermes-memo-app（Vue3 + Vite + Capacitor Android）当前所有自定义样式组件，全量重写为 Vant 4 组件，并保证 `vite build` 产物 + Capacitor `cap sync` 产物里**所有运行时依赖（CSS / wasm / nodejs 运行时 / 字体 / 图标 / 图片）都被正确打入 app 包内**，不依赖任何 CDN 或网络资源。

## 1. 硬约束（违反任一条都算失败）

### 1.1 打包完整性（用户最高优先级要求）

**所有运行时用到的内容必须进入 app 里**。具体：

| 资源 | 来源 | 必须出现在 |
|------|------|-----------|
| Vant CSS | `vant/lib/index.css` 在 `src/main.ts` 被 `import` | `dist/assets/*.css`（被 Vite 打进 bundle，**禁止**在 `index.html` 用 `<link>` 引 CDN） |
| Vant 字体/图标 | Vant 组件内部引用 | 同上，由 Vite 自动 base64 内联或拷到 `dist/assets/` |
| sql-wasm.wasm | `public/sql-wasm.wasm` | `dist/sql-wasm.wasm`（public 自动拷贝，不要动） |
| nodejs 运行时 | `public/nodejs/` 整目录 | `dist/nodejs/`（public 自动拷贝，不要动） |
| favicon.svg | `public/favicon.svg` | `dist/favicon.svg`（不要动） |
| hero.png | `src/assets/hero.png` | 被 `import` 后进 `dist/assets/`（Vite 自动） |
| 所有 JS chunk | Vite 打包 | `dist/assets/*.js` |

**禁止操作**：
- ❌ 在 `index.html` 加 `<link rel="stylesheet" href="https://...vant...">` 这类 CDN 引用
- ❌ 用 `unplugin-vue-components` 的 resolver 走 CDN 模式（必须本地 import）
- ❌ 删除或重命名 `public/sql-wasm.wasm` / `public/nodejs/`
- ❌ 改 `vite.config.ts` 的 `base: './'`（Capacitor WebView 必须相对路径）
- ❌ 改 `capacitor.config.ts` 的 `webDir: 'dist'`

**必须操作**：
- ✅ `src/main.ts` 顶部加 `import 'vant/lib/index.css'`
- ✅ 每个使用 Vant 的 `.vue` 文件按需 `import { NavBar, Popup, ... } from 'vant'`（Vant 4 默认按需 JS，CSS 由全量 `index.css` 兜底；不要装 `unplugin` 自动 resolver，避免 CDN 风险）
- ✅ 完工后跑 `pnpm build`，检查 `dist/` 下：`index.html` 不含任何 `https://` 外链；`dist/assets/*.css` 体积应明显增大（Vant 全量 ~250KB）；`dist/nodejs/`、`dist/sql-wasm.wasm`、`dist/favicon.svg` 齐全

### 1.2 代码风格

- 一个方法/语句一行（不要用 `;` 串多语句）
- `<template>` 缩进 2 空格，`<script setup lang="ts">`
- 保留所有现有 `<script>` 里的业务逻辑、ref 名、事件名、API 调用——只换 view 层
- 删除被替换组件的旧 `<style scoped>` 块；Vant 自带样式足够。**例外**：消息气泡（AgentChat）保留自定义样式
- `src/style.css` 删除（Vant reset 替代），`main.ts` 里若有 `import './style.css'` 也要删

### 1.3 行为不变

- 所有 emit/props 签名不变
- `showSettings` + `settingsPanel` 两个 ref 配合的逻辑保留（计划书「v-model:show 陷阱」已写明）
- `refreshKey`、`draft`、`onTextSubmit`、`onConfirm`、`onRevise`、`onCancel`、`openSettings`、`closeSettings`、`onSettingsBlur` 全部保留
- AgentChat 的快捷指令、语音按钮、loading 态保留
- SettingsPanel 的字段（apiKey1/apiKey2/apiBase/modelName/ocrKey/ocrModel）保留
- 不要动 `src/services/` 下任何文件
- 不要动 `src/polyfills/`
- 不要动 `capacitor.config.ts` / `vite.config.ts` / `.npmrc` / `tsconfig*.json`

## 2. 重写顺序与每步验收（必须逐个 vite build 验证）

### Step 1 — App.vue（最优先，165 行）

**当前**：自定义 `<header>` + `<div class="settings-dropdown">` + `<div class="overlay">` + `<div class="main-tabs">` + `<button class="fab">`

**替换映射**：

| 原结构 | Vant 组件 | 备注 |
|--------|----------|------|
| `<header>` 标题 + ⚙️ 按钮 | `<van-nav-bar title="智能备忘录" left-arrow={false}>` 右侧 `<template #right><van-icon name="setting-o" @click="..."/></template>` | `safe-area-inset-top` 自动适配刘海 |
| `.settings-dropdown`（下拉菜单） | `<van-action-sheet v-model:show="showSettings" :actions="settingsActions" @select="onSelectSettings" cancel-text="取消" close-on-click-action>` | settingsActions = 5 项（术语词典/导出/设置/记忆/知识库）；select 后调 openSettings(action.name 对应值) |
| `.overlay`（全屏设置弹层） | `<van-popup v-model:show="showSettingsPanel" position="bottom" :style="{ height: '85%' }" round closeable close-icon-position="top-left">` 内含 `<van-nav-bar :title="panelTitle" @click-left="closeSettings">` + 动态 component | 需要 `showSettingsPanel = computed(() => !!settingsPanel.value)` 读，`closeSettings` 写 `settingsPanel.value=null`；**不能** `v-model:show` 直接绑 `!!settingsPanel`（计划书陷阱 1） |
| `.main-tabs`（memos/agent 切换） | `<van-tabbar v-model="mainTab">` + 两个 `<van-tabbar-item icon="notes-o">备忘录</van-tabbar-item>` / `<van-tabbar-item icon="chat-o">助手</van-tabbar-item>` | `safe-area-inset-bottom`；保留 refreshKey 触发逻辑（切回 memos 时 ++） |
| `.fab`（＋ 录入） | `<van-floating-bubble icon="plus" @click="showInput = true">` 或 `<van-button type="primary" round icon="plus" class="fab">`；若 Vant 版本无 floating-bubble 用后者 | 固定右下，z-index 高于 tabbar |

**验收 Step 1**：
- [ ] `pnpm build` 通过，无 TS 错误
- [ ] `dist/index.html` 无 `https://` 外链
- [ ] `dist/assets/*.css` 含 Vant（grep `van-nav-bar` 命中）
- [ ] App.vue 内不再有 `<header>`/`settings-dropdown`/`overlay`/`main-tabs`/`fab` 字样
- [ ] `dist/nodejs/` / `dist/sql-wasm.wasm` / `dist/favicon.svg` 仍在

### Step 2 — MemoList.vue（103 行）

| 原 | Vant |
|----|------|
| `<input>` 搜索框 | `<van-search v-model="searchQuery" shape="round" placeholder="搜索备忘录" @search="load" />` |
| 三个 filter 按钮 | `<van-tabs v-model:active="filter" @change="load" sticky>` 三个 `<van-tab title="全部/本周/收藏">` |
| 卡片列表 | `<van-cell-group inset>` + `<van-swipe-cell>` 包每条；右滑出现删除按钮 |
| 标签 | `<van-tag type="primary" plain>` |
| 空态 | `<van-empty description="暂无备忘录" />` |
| 加载中 | `<van-loading type="spinner" vertical>` |

**验收**：`pnpm build` 过 + dist 完整性同上 + MemoList 不再有 `<input>` / 自定义 filter 按钮。

### Step 3 — AgentChat.vue（106 行）

| 原 | Vant |
|----|------|
| 消息气泡 `<div class="msg">` | **保留**自定义样式（计划书明确保留） |
| `<textarea>` | `<van-field v-model="input" type="textarea" autosize rows="1" maxlength="-1" />` |
| 发送按钮 | `<van-button type="primary" :loading="loading" :disabled="!input.trim()" @click="send">发送</van-button>` |
| 语音按钮 | `<van-button icon="volume-o" @click="toggleVoice" />` |
| 快捷指令 | `<van-button size="small" plain v-for="cmd in quickCommands">` |

**验收**：`pnpm build` 过；气泡样式块保留；textarea 替换为 van-field。

### Step 4 — SettingsPanel.vue（179 行）

全部 `<label>+<input>` 换 `<van-field>`：

```html
<van-field v-model="form.apiKey1" type="password" label="LLM Key" placeholder="主 LLM API Key" />
<van-field v-model="form.apiKey2" type="password" label="备用 Key" />
<van-field v-model="form.apiBase" label="LLM 地址" placeholder="https://open.bigmodel.cn/api/paas/v4" />
<van-field v-model="form.modelName" label="文本模型" />
<van-field v-model="form.ocrKey" type="password" label="OCR Key" />
<van-field v-model="form.ocrModel" label="视觉模型" />
<van-button block type="primary" @click="save" :loading="saving">保存</van-button>
```

外层可包 `<van-cell-group inset>` 让字段成组。

**验收**：`pnpm build` 过；字段全替换；保存逻辑不变。

### Step 5 — 其他面板（低优先，可一次性做完）

- **GlossaryPanel.vue**（74 行）：`<van-field>`（搜索）+ `<van-tag>` + `<van-button>` 删除/添加
- **MemoryPanel.vue**（217 行）：`<van-tabs>` 切记忆/技能 + `<van-field>` + `<van-tag>` + `<van-button>`
- **KnowledgePanel.vue**（142 行）：`<van-search>` + `<van-cell-group>` + `<van-swipe-cell>` + `<van-empty>`
- **ExportPanel.vue**（107 行）：`<van-checkbox-group>` + `<van-button block>`

**验收**：每个改完都 `pnpm build` 过。

### Step 6 — 收尾

- 删除 `src/style.css` 文件 + `main.ts` 里它的 import（如有）
- 在 `main.ts` 最顶部加 `import 'vant/lib/index.css'`（确保 Vant 样式在业务样式前加载）
- 跑最终 `pnpm build`
- 跑 `pnpm typecheck`（如果有该 script；没有就 `npx vue-tsc --noEmit`）

## 3. 最终验收清单（完工后 opencode 自己跑一遍并贴输出）

```bash
cd C:/work-space/hermes-memo-app

# 1. 构建
pnpm build 2>&1 | tail -20

# 2. dist 完整性
ls dist/
ls dist/assets/ | grep -E "\.css$|\.js$"
ls dist/nodejs/ | head
ls dist/sql-wasm.wasm dist/favicon.svg

# 3. 无 CDN 外链（必须空输出）
grep -E 'https?://' dist/index.html | grep -v '<!--' || echo "OK: no external links"

# 4. Vant 样式进 bundle
grep -c 'van-nav-bar\|van-tabbar\|van-popup' dist/assets/*.css

# 5. TS 检查
npx vue-tsc --noEmit 2>&1 | tail -20
```

**完工报告必须包含**：
- 每步 `pnpm build` 是否过
- dist 完整性 ls 输出
- `grep 'https?://' dist/index.html` 输出（证明无外链）
- `npx vue-tsc --noEmit` 输出
- 修改的文件列表（`git diff --stat`）

## 4. 不要做（do NOT 清单）

- ❌ 不要 `git commit`（保持工作树让主 Agent 验收）
- ❌ 不要动 `src/services/`、`src/polyfills/`、`capacitor.config.ts`、`vite.config.ts`、`.npmrc`、`tsconfig*.json`、`public/` 下任何文件
- ❌ 不要装新 npm 包（Vant 4.10.2 已在依赖里）
- ❌ 不要引入 `unplugin-vue-components` / `vite-plugin-style-import` 等 CDN-prone 自动 import 插件
- ❌ 不要改组件的 props/emit 签名
- ❌ 不要重写 AgentChat 的消息气泡样式（保留）
- ❌ 不要在 `index.html` 加任何 `<link>` / `<script src="https://">`
- ❌ 不要试图「优化」业务逻辑——本任务只换 view 层
- ❌ 遇到清单外项（如某个组件有计划书没列的字段），按 (b) 处理：继续做，但在完工报告里明确 callout

## 5. 参考文件（绝对路径）

- 计划书：`C:/work-space/hermes-memo-app/.hermes/plans/ui-optimize-plan.md`
- 待改文件目录：`C:/work-space/hermes-memo-app/src/`
- Vant 4 文档（如需查组件 API）：`https://vant-ui.github.io/vant/` —— **仅查文档**，不要把文档资源拷进项目
- 当前 main.ts：`C:/work-space/hermes-memo-app/src/main.ts`（只 3 行，加 vant css import）
- 当前 vite.config.ts：`C:/work-space/hermes-memo-app/vite.config.ts`（base: './'，不要动）

## 6. 遇到问题的处理

- 某个 Vant 组件 API 在 4.10.2 与文档不符 → 用 `node -e "const v=require('vant'); console.log(Object.keys(v))"` 看实际导出
- TS 报错 Vant 类型缺失 → 检查 `tsconfig.app.json` 的 `types` 是否含 `vant`；如缺，加 `"types": ["vant"]` 到 compilerOptions（这是允许的小改）
- 构建后 dist 缺资源 → 立即停下报告，不要继续
