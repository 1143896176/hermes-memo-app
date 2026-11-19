# 智能备忘录 (hermes-memo-app)

一个基于 Vue3 + Capacitor + DeepAgents 的智能备忘录应用，Android / iOS 双端同一套代码。

> **微信小程序版**：见同目录下 `hermes-memo-wx`（基于微信云开发，功能等价、最小开发量迁移）。

## 核心特性

- **🤖 Agent 架构（灵魂）**：基于 deepagents/browser + LangChain，Agent 自主决策调用工具（保存/搜索/列表/删除/术语/技能/导出），不是手工管线
- **零后端依赖**：原生端用 Node 运行时 `node:sqlite`（FTS5 全文搜索）；浏览器预览用 sql.js（SQLite WASM）持久化到 IndexedDB；Agent 全部在 WebView 内运行
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
| UI | Vant 4（全量注册，图标统一用 `van-icon`） |
| 构建 | Vite 8 |
| 移动壳 | Capacitor 8（Android + iOS） |
| 本地存储 | 原生：Node 运行时 `node:sqlite`（FTS5）；浏览器预览：sql.js → IndexedDB |
| OCR | 智谱 `glm-4.6v-flash`（永久免费） |
| ASR | 默认智谱 GLM-ASR（`open.bigmodel.cn`，云端识别）；Android/iOS 系统语音识别作为离线兜底 |

### 默认 LLM 配置

| 项 | 默认值 | 说明 |
|---|---|---|
| 文本模型 | `nvidia/nemotron-3.5-super-vl:free` | OpenRouter 免费档 |
| 视觉模型（OCR） | `glm-4.6v-flash` | 智谱永久免费 |
| LLM 地址 | `https://openrouter.ai/api/v1` | OpenRouter（国内多数网络可达，无需翻墙） |
| ASR 地址 | `https://open.bigmodel.cn/api/paas/v4` | 智谱（国内直连） |

**推荐配置**：全切智谱 BigModel（`glm-4.6v-flash` 文本 + 视觉 + ASR 三合一，全国内直连、零翻墙、零成本）。
仓库根目录有 `zhipu-free-config.json`，App 内「导出分享 → 导入备份」即可一键切换。

## 目录结构

```
hermes-memo-app/
├── android/              # Capacitor Android 工程
├── ios/                  # Capacitor iOS 工程（SPM，最低 iOS 15）
├── scripts/
│   └── ios-setup.mjs     # Mac 上补 Info.plist 权限；全平台补本地插件注册表
├── public/
│   ├── nodejs/           # 内嵌 Node 运行时（deepagents + sqlite）
│   └── sql-wasm.wasm
└── src/
    ├── App.vue           # 根布局 + 草稿管线状态机
    ├── services/
    │   ├── api.ts        # re-export engine
    │   ├── engine.ts     # 浏览器版：sql.js + LLM + OCR + 纠错
    │   ├── agent.ts      # 浏览器版 DeepAgents
    │   ├── node-bridge.ts# 原生：Node 运行时 RPC / 浏览器降级路由
    │   ├── platform.ts   # iOS / Android / Web 判定
    │   └── keyboard.ts   # 点空白处收键盘（iOS 无返回键）
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
pnpm i               # 必须是 pnpm：pnpm-workspace.yaml 里放行了构建脚本
pnpm dev             # Web 预览（浏览器版引擎，无 Node 运行时）
pnpm build           # 构建 dist/
pnpm cap:sync:android
pnpm cap:open        # 用 Android Studio 打开 android/
```

### iOS 构建（需要 macOS + Xcode 15+）

Windows 上只能生成 `ios/` 工程骨架，编译必须上 Mac：

```bash
# 1. 装依赖（postinstall 会下载 NodeMobile.xcframework，约 100MB）
#    不要设 CAPACITOR_NODEJS_SKIP_DOWNLOAD=1，否则编译时找不到 NodeMobile
pnpm install

# 2. 产出 dist 并同步进 iOS 工程
pnpm build
npx cap sync ios

# 3. 补 Info.plist（相机/相册/麦克风权限、备份文件可见性、出口合规）
pnpm ios:setup

# 4. 打开工程（SPM 工程，打开 .xcodeproj —— 这个模板没有生成 .xcworkspace）
pnpm cap:open:ios
```

Xcode 里还需要：Signing & Capabilities 选 Team，Bundle ID 保持 `com.hermes.memo`，
确认 Package Dependencies 里出现 `Capacitor`、`CapacitorKeyboard`、`CapawesomeCapacitorNodejs`。

真机首跑先看控制台里的 `[hermes-node] capabilities` —— 它会打印 `sqlite` 与 `ripgrep`
是否可用，这是判断 iOS 上数据库能不能开的唯一快速线索。

### 没有 Mac：用 GitHub Actions 云端构建

`.github/workflows/ios.yml` 会在 `macos-15` runner 上跑完
`安装依赖 → 类型检查 → 构建前端 → cap sync → 补 Info.plist → archive → 打包 ipa`，
产物是一个**未签名**的 `hermes-memo-unsigned.ipa`，从 Actions 页面下载。

**关于免费额度**（这条决定仓库该怎么建）：

| 仓库可见性 | macOS 额度 | 额外要求 |
|---|---|---|
| 公开 | 完全免费、不限分钟 | 无 |
| 私有 | 免费 2000 分钟 ÷ 10 倍倍率 ≈ **实际 200 分钟** | 必须先绑定付款方式，否则 macOS 任务直接排队不动 |

按 15 分钟一次构建算，私有仓库每月只能跑十来次。想长期白用就开个公开镜像仓库；
项目里已确认没有硬编码密钥（API Key 是运行时在设置页填的）。

**推送到 GitHub**（origin 是 Gitee，需要一个 GitHub 远端）：

```bash
git remote add github https://github.com/<你的账号>/hermes-memo-app.git
git push github ios-dev          # 工作流监听 ios-dev / main / master
```

推上去后自动触发，也可以在 Actions 页面手动 `Run workflow`。

**装到 iPhone 上**（Windows 就能做，不需要 Mac）：

1. Actions 跑完后在 Artifacts 里下载 `hermes-memo-unsigned-ipa`
2. 解压得到 `hermes-memo-unsigned.ipa`
3. 用 [Sideloadly](https://sideloadly.io/) 连上 iPhone，填自己的 Apple ID 签名安装
4. 手机「设置 → 通用 → VPN与设备管理」里信任该开发者证书

免费 Apple ID 签名有 **7 天有效期**，过期需重新签装一次；同时最多 3 个自签 App。
要上 TestFlight 或装到别人的手机上，才需要 99 美元/年的 Apple Developer Program——
那时把证书导出成 `.p12` 和 `.mobileprovision` 存成 Secrets，在 workflow 里换成
`xcodebuild -exportArchive` 即可（当前是故意留白，避免没有证书时流水线跑不通）。

工程里的 `App.xcscheme` 是**手写提交的共享 scheme**。`cap add ios` 只生成用户级
scheme，Xcode 打开时会自动补，但 GitHub runner 上没有这个动作，
`xcodebuild -scheme App` 会报 "scheme not found"——所以它必须进版本库。

### iOS 与 Android 的已知差异

| 项 | Android | iOS |
|---|---|---|
| 系统语音识别（不花额度） | 支持（SpeechRecognizer 插件） | 支持（SFSpeechRecognizer 插件，默认离线识别，失败自动转在线） |
| 语音授权 | 1 次（麦克风） | 2 次（麦克风 + 语音识别），均需在 Info.plist 声明 |
| 导出备份文件位置 | App 私有目录，通过 FileProvider 分享 | 「文件」App → 我的 iPhone → 智能备忘录 → data/exports |
| 键盘顶起页面 | `windowSoftInputMode=adjustResize` | `@capacitor/keyboard` 的 `resize: native` |
| 最低系统 | Android 6+ | iOS 15+ |

### 首次配置

App 启动后点右上角 ⚙️ → 🔑 API 设置：

- **LLM API Key**：OpenAI 兼容接口的 Key（主 + 可选备用）
- **LLM 地址 / 文本模型**：默认 OpenRouter（`https://openrouter.ai/api/v1` + `nvidia/nemotron-3.5-super-vl:free`）
  - 想换国内免费方案：导入 `zhipu-free-config.json`（App 内「导出分享 → 导入备份」），地址变 `https://open.bigmodel.cn/api/paas/v4`、模型变 `glm-4.6v-flash`
  - 也可换 DeepSeek、Kimi、自部署代理等
- **OCR API Key**：智谱开放平台 Key（拍照 OCR，免费模型 `glm-4.6v-flash`）
- **ASR Key / 地址**：默认智谱 `open.bigmodel.cn`（语音转写）；也支持 Groq、硅基流动等 OpenAI 兼容 ASR

Key 在本地用 base64 混淆后存 SQLite，不上传。

## 工作流

1. 右下角 ＋ → 录入文本（键盘 / 语音 / 拍照）
2. LLM 解析为结构化草稿，自动应用术语词典纠错
3. DraftCard 预览 → ✅ 确认保存 / ✏️ 修改后重新生成 / ❌ 取消
4. 主列表查看 / 过滤 / 完成 / 删除

## 数据持久化

**原生端（Android / iOS）**：
- Node 运行时（nodejs-mobile）内嵌 `node:sqlite`（Node 24 内置，支持 FTS5）
- 多个 `.db` 文件存 App 私有目录（`memos.db` / `glossary.db` / `feedback.db` / `knowledge.db` / `hermes.db`）
- WAL 模式，进程重启数据不丢

**浏览器预览（开发模式）**：
- sql.js 是 SQLite 编译成 WebAssembly 的内存数据库，浏览器关闭即丢
- 引擎层每次写操作后 `db.export()` 出整个 SQLite 二进制，写入 IndexedDB（key=`sqlite-db`，db=`hermes-memo`）
- 启动时先尝试从 IndexedDB 加载二进制恢复，失败则新建空库

**微信小程序版**（`hermes-memo-wx`）：用云开发数据库（NoSQL），非 SQLite。

## 许可

私有项目。