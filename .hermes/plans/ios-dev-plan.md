# Hermes Memo App — iOS 版开发计划

## 分支与起点

- 分支：`ios-dev`（基于 `ui-optimize` 最新 commit `42cbed2`）
- 起点：Vant UI 完整版 + Android 已跑通 v1.11
- 平台方案：Capacitor iOS（与 Android 同栈，复用 Vue3 Web 代码）

## 关键技术结论（已查证）

### 1. `@capawesome/capacitor-nodejs` 支持 iOS ✅
- npm 包本身跨平台，Capacitor 8.x Active support
- **iOS 只支持 Swift Package Manager（SPM），不支持 CocoaPods**
- iOS runtime 二进制在 `npm install` 时下载，**只在 macOS 上下载**
- Windows 上可设 `CAPACITOR_NODEJS_SKIP_DOWNLOAD=1` 跳过 iOS 二进制下载（反正 Windows 也编译不了 IPA）

### 2. iOS 限制（必须知道的）
- **No JIT**：iOS JS 引擎纯解释器模式，比 Android 慢 → Agent 响应可能略慢
- **iOS Simulator 只支持 arm64 模拟器 slice** → 必须 Apple Silicon Mac（M1/M2/M3）才能跑模拟器
- **`process.exit()` 被 App Store 禁止** → Node 端代码若有 process.exit 要改
- **App 体积增大**：每 CPU 架构 +几十 MB
- **Single instance**：Node runtime 只能启动一次，不能重启
- **No child_process**：移动平台不支持子进程
- **Native addons 只在 Android 支持 prebuilds** → iOS 不支持 native addons

### 3. 业务代码零改动（已验证）
`src/services/node-bridge.ts` 用 `Capacitor.isNativePlatform()` 检测原生环境——iOS 上自动走 Node runtime 分支，无需改 WebView 代码。

## Windows 阶段能做的事

### Step 1: 安装 iOS 平台包（Windows 可装，二进制下载会被跳过）
```bash
# 先设环境变量跳过 iOS 二进制下载（Windows 下没意义）
export CAPACITOR_NODEJS_SKIP_DOWNLOAD=1
node "C:/Users/Administrator/AppData/Local/Volta/tools/image/packages/pnpm/node_modules/pnpm/bin/pnpm.mjs" add @capacitor/ios
```

### Step 2: 添加 iOS 原生工程（需要 macOS！）
```bash
# 这一步在 Mac 上跑，Windows 跑不了
npx cap add ios
```
⚠️ `cap add ios` 实际需要 macOS + Xcode。Windows 上可以预先准备好 capacitor.config 的 iOS 相关配置，但 `ios/` 目录必须在 Mac 上生成。

### Step 3: capacitor.config.ts 调整（Windows 可做）
- 检查 `appId: 'com.hermes.memo'` 是否符合 Apple Bundle ID 规范（反域名格式，已合规）
- iOS 不需要 `server.allowNavigation`（iOS WKWebView 默认允许 https 跨域 fetch）
- Nodejs 插件配置 `nodeDir: 'nodejs'` + `startMode: 'auto'` 已对齐 iOS

### Step 4: 代码审计（Windows 可做）
- [ ] 全项目搜 `process.exit(`，确认 Node 端代码无调用（App Store 禁止）
- [ ] 全项目搜 `child_process`，确认无使用（iOS 不支持）
- [ ] 全项目搜 native addon require（如 `better-sqlite3`），确认 iOS 不可用
- [ ] sql.js 用 wasm，无 native addon → iOS 兼容 ✅
- [ ] deepagents/langchain 纯 JS → iOS 兼容 ✅

### Step 5: PWA fallback（可选，Windows 可做）
作为 iOS 原生版开发期间的临时方案，加 manifest.json + Service Worker，让 iOS Safari 用户可以"加到主屏幕"作为轻量版使用。

## Mac 阶段需要做的事（拿到 Mac 后）

### 必需
1. 安装 Xcode 15+（App Store）
2. 安装 CocoaPods（虽然 capacitor-nodejs 不支持 pod，但其他 Capacitor 插件可能需要）—— 实际上 Capacitor 6+ 已默认 SPM，可能不需要 pod
3. `npx cap add ios` 生成 ios/ 工程
4. 配置 Bundle ID、签名证书（Apple Developer 账号 $99/年）
5. SPM 添加 capacitor-nodejs 包（Xcode → File → Add Package Dependencies）
6. `npx cap sync ios` 同步 web 资源
7. Xcode 打开 `ios/App/App.xcworkspace` 编译运行

### iOS 特有调整
- **Info.plist**：相机/相册/麦克风权限说明文案（NSCameraUsageDescription / NSPhotoLibraryUsageDescription / NSSpeechRecognitionUsageDescription）
- **safe-area**：Vant 的 NavBar/Tabbar 已有 `safe-area-inset-top/bottom`，iOS 刘海屏自动适配
- **WKWebView** 比 Android WebView 性能更好，且对 ES2020+ 支持完整

## 当前 git 状态

```
分支: ios-dev (基于 ui-optimize @ 42cbed2)
远程: 仅本地，未 push
工作树: 干净
```

## 不做的事
- 不在 Windows 上跑 `npx cap add ios`（会失败，需要 macOS）
- 不在 Windows 上尝试编译 IPA
- 不重写 Vue3 Web 代码（Android 已验证，iOS WebView 兼容）
- 不切换到 React Native / Swift 原生（已选 Capacitor 方案）
