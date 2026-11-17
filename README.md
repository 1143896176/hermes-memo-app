# 智能备忘录 (hermes-memo-app)

一个基于 Vue3 + Capacitor + DeepAgents 的 Android 智能备忘录应用。

## 核心特性

- **🤖 Agent 架构（灵魂）**：基于 deepagents/browser + LangChain，Agent 自主决策调用工具（保存/搜索/列表/删除/术语/技能/导出），不是手工管线
- **零后端依赖**：所有数据用 sql.js（SQLite WASM）存本地并持久化到 IndexedDB；Agent 全部在 WebView 内运行
- **双交互模式**：
  - 📋 备忘录 tab：快捷录入（文本/语音/拍照 OCR）→ LLM 解析草稿 → 确认保存
  - 🤖 Agent 对话 tab：自然语言对话，Agent 自主调用工具
- **术语词典 + 反馈学习**：长词优先 + 计数自增 + 30 天时效衰减，自动记录用户修改
- **智能推断**：从历史相似备忘补全缺省 location/due_date
- **技能系统**：Agent 可创建/修改/删除自己的技能（procedural memory）
- **MEMORY.md / USER.md**：持久记忆 + 用户画像注入 Agent systemPrompt

## 技术栈

| 层 | 技术 |
|---|---|
| Agent 框架 | deepagents/browser（StateBackend + MemorySaver） |
| LLM | @langchain/openai（ChatOpenAI，baseURL 用户配置） |
| 工具 | @langchain/core（tool 包装）+ zod schema |
| 框架 | Vue 3.5 + `<script setup>` + TypeScript |
| 构建 | Vite 8 |
| 移动壳 | Capacitor 8 (Android) |
| 本地存储 | sql.js (SQLite WASM) → IndexedDB 持久化 |
| OCR | 智谱 `glm-4v-flash` |
| 语音 | `webkitSpeechRecognition`（仅 Android WebView） |

## 目录结构

```
hermes-memo-app/
├── android/              # Capacitor Android 工程
├── public/
│   └── sql-wasm.wasm
└── src/
    ├── App.vue           # 根布局 + 草稿管线状态机
    ├── services/
    │   ├── api.ts        # re-export engine
    │   ├── engine.ts     # sql.js + LLM + OCR + 词典纠错 + 持久化
    │   └── agent.ts      # DeepAgents 架构（Agent 框架 + 工具集）
    └── components/
        ├── MemoInput.vue     # 录入（文本/语音/拍照 OCR）
        ├── MemoList.vue      # 列表 + 过滤 + 全文搜索 + CRUD
        ├── DraftCard.vue     # 草稿确认/修改（含推测字段）
        ├── AgentChat.vue     # Agent 对话界面（自然语言交互）
        ├── SettingsPanel.vue # API Key 配置
        ├── GlossaryPanel.vue # 术语词典管理
        ├── MemoryPanel.vue   # 记忆 / 用户画像 / 技能管理
        └── ExportPanel.vue   # JSON 导出
```

## 使用

### 开发

```bash
npm i
npm run dev          # Web 预览
npm run build        # 构建 dist/
npm run cap:sync     # 同步到 Android
npm run cap:open     # 用 Android Studio 打开 android/
```

### 首次配置

App 启动后点右上角 ⚙️ → 🔑 API 设置：

- **LLM API Key**：OpenAI 兼容接口的 Key（主 + 可选备用）
- **接口地址** / **模型名称**：默认 `https://api.openai.com/v1` / `gpt-4o-mini`，可换 DeepSeek、智谱、Kimi、自部署代理等
- **OCR API Key**：智谱开放平台 Key（用于拍照 OCR，免费模型 `glm-4v-flash`）

Key 在本地用 base64 混淆后存 SQLite，不上传。

## 工作流

1. 右下角 ＋ → 录入文本（键盘 / 语音 / 拍照）
2. LLM 解析为结构化草稿，自动应用术语词典纠错
3. DraftCard 预览 → ✅ 确认保存 / ✏️ 修改后重新生成 / ❌ 取消
4. 主列表查看 / 过滤 / 完成 / 删除

## 数据持久化

- sql.js 是 SQLite 编译成 WebAssembly 的内存数据库，浏览器关闭即丢
- 引擎层每次写操作后 `db.export()` 出整个 SQLite 二进制，写入 IndexedDB（key=`sqlite-db`，db=`hermes-memo`）
- 启动时先尝试从 IndexedDB 加载二进制恢复，失败则新建空库

## 许可

私有项目。