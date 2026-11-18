# Hermes Memo App — iOS 版开发计划

## 分支与起点

- 分支：`ios-dev`（基于 `ui-optimize` 最新 commit `42cbed2`）
- 起点：Vant UI 完整版 + Android 已跑通 v1.11
- 平台方案：Capacitor iOS（与 Android 同栈，复用 Vue3 Web 代码）

## 关键技术结论（已查证）

### 1. `@capawesome/capacitor-nodejs` 支持 iOS ✅
- npm 包本身跨平台，Capacitor 8.x Active support
- **iOS 只支持 Swift Package Manager（SPM），不支持 CocoaPods**
- iOS runtime 二进制 `NodeMobile.xcframework` 由 postinstall 下载，且**只在 macOS 上下载**
  （`scripts/postinstall.js` 里有 `process.platform !== 'darwin'` 直接返回）
- 插件按 `Bundle.main.bundlePath + "/public/" + nodeDir` 找 Node 项目 → 与 `webDir: dist` 的拷贝结果天然对齐
- `bridge.app.datadir()` 在 iOS 上返回 `NSSearchPathForDirectoriesInDomains(.documentDirectory)`，
  所以 `public/nodejs/paths.js` 的落盘逻辑不用改

### 2. iOS 限制
- **No JIT**：iOS JS 引擎纯解释器模式，比 Android 慢 → Agent 响应可能略慢
- **iOS Simulator 只支持 arm64 模拟器 slice** → 需要 Apple Silicon Mac
- **`process.exit()` 被 App Store 禁止** → 已审计，运行时代码无调用
- **No child_process**：移动平台不支持子进程 → deepagents 的 `grep` 工具会 spawn `rg`，
  但 ripgrepSearch 有 `proc.on('error')` 兜底，失败会退化成纯 JS 子串搜索
- **Native addons 只在 Android 支持 prebuilds** → 项目用 `node:sqlite` 内建模块，不涉及

### 3. 业务代码几乎零改动
`src/services/node-bridge.ts` 用 `Capacitor.isNativePlatform()` 检测原生环境，iOS 自动走 Node 分支。
需要改的只有平台文案和 iOS 特有的交互（键盘、权限）。

## 已完成

### Windows 阶段（本机可做，已全部完成）

| 项 | 结果 |
|---|---|
| `ios/` 原生工程 | ✅ 已生成并纳入仓库（`npx cap add ios` 只解压模板，不依赖 macOS） |
| SPM 依赖 | ✅ `CapacitorKeyboard` + `CapawesomeCapacitorNodejs` 已写入 `ios/App/CapApp-SPM/Package.swift` |
| Info.plist 权限 | ✅ 相机 / 相册 / 麦克风三条 usage 文案 |
| 备份文件可见 | ✅ `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` |
| 出口合规 | ✅ `ITSAppUsesNonExemptEncryption = false` |
| 设备能力 | ✅ `UIRequiredDeviceCapabilities` 由模板的 `armv7` 改为 `arm64`（最低 iOS 15，全是 arm64） |
| 版本号 | ✅ 对齐 Android：`MARKETING_VERSION 1.11` / `CURRENT_PROJECT_VERSION 14` |
| App 图标 / 启动屏 | ✅ 用 `public/favicon.svg` 渲染 1024 图标（渐变底 + 白色标志，无 alpha）+ 2732 启动屏，替换模板的 Capacitor 占位图 |
| 键盘适配 | ✅ 新增 `@capacitor/keyboard`，`resize: native` + `style: LIGHT` + `autoBackdropColor: auto` |
| 键盘收起 | ✅ `src/services/keyboard.ts`：点空白处失焦（iOS 没有返回键） |
| WebView 参数 | ✅ `contentInset: never` / `zoomEnabled: false` / `preferredContentMode: mobile` |
| 构建脚本放行 | ✅ 新增 `pnpm-workspace.yaml` 的 `allowBuilds`（pnpm 12 不再读 package.json 的 `allowScripts`，原来那份是无效的，会导致 Mac 上 NodeMobile 不下载） |
| 包体瘦身 | ✅ `vite.config.ts` 构建时剔除 `vendor.bundle.mjs`(5.9MB) / `build-bundle.js` / `package-lock.json`，dist 16MB → 9.5MB |
| 启动自检 | ✅ `public/nodejs/index.js` 打印 `capabilities`（sqlite / ripgrep），iOS 首跑定位问题用 |

### 仍需在 Mac 上做的（无法在本机验证）

1. `pnpm install`（让 postinstall 下载 `NodeMobile.xcframework`）
2. `pnpm build && npx cap sync ios`
3. `pnpm ios:setup`（幂等，重复执行无害；`--check` 只检查不改）
4. Xcode 打开 `ios/App/App.xcodeproj`（SPM 工程没有 .xcworkspace），配 Team / 签名后真机跑
5. 看控制台 `[hermes-node] capabilities`：`sqlite` 必须为 `true`，否则数据库全挂
6. 走一遍主流程：录入 → 草稿 → 保存 → 列表 → Agent 对话 → 导出 → 导入

## 明确不做

- 不在 Windows 上编译 IPA
- 不重写 Vue3 Web 代码（Android 已验证，iOS WebView 兼容）
- 不切换到 React Native / Swift 原生
- 不实现 iOS 原生语音识别（SFSpeechRecognizer）—— 需在 Xcode 里加 Swift 插件并手改
  `project.pbxproj`，无法在 Windows 上验证，先用云端 ASR，UI 已按平台自动切换文案

## 当前 git 状态

```
分支: ios-dev
工作树: 有未提交改动（ios/ 为新增未跟踪目录）
```

## 补充：iOS 子进程护栏（实现阶段新增）

`public/nodejs/index.js` 顶部加了一段只在 `process.platform === 'ios'` 生效的护栏，
把 `child_process` 的 `spawn / spawnSync / exec / execSync / execFile / execFileSync / fork`
全部替换成"同步抛出明确错误"。

原因：nodejs-mobile 的 iOS 二进制没有子进程实现。Agent 的 grep 工具会 `spawn('rg', ...)`，
在 iOS 上这类调用未必抛出可捕获的异常，而是让整个 Node 进程退出——进程一死，
bridge、数据库、UI 全挂，日志里还看不出是谁干的。护栏让失败收敛到"那一次工具调用报错"。

同一原因，启动自检里的 `capabilities.ripgrep` 在 iOS 上直接置 `false`，不再 `execFileSync('which', ['rg'])`：
为了一个诊断信息去冒启动闪退的风险不值得。

## 补充：`npx cap copy ios` 在受限环境下的替代

`cap copy` 内部是 `fs-extra.remove(ios/App/App/public)` 再 copy。如果运行环境拦截删除
（本机沙箱的 safe-delete 垫片会拦 >50 文件的删除，trash 又失败），会直接报
`Error during a trash operation`。`ios/App/App/public` 已被 `ios/.gitignore` 忽略，
是纯生成物，可以绕过 cap：

```bash
npx vite build
cp -Rf dist/. ios/App/App/public/          # 覆盖式同步
# 若 dist 资源哈希变了，手工删掉 public/assets 里旧的 index-*.js / *.css
```

CI 或正常机器上仍应优先 `npx cap sync ios`。

## GitHub Actions 云端构建（无 Mac 方案）

`.github/workflows/ios.yml`，`macos-15` runner，产出未签名 `hermes-memo-unsigned.ipa`。

流水线：`pnpm install → vue-tsc → vite build → cap sync ios → ios-setup → xcodebuild archive（CODE_SIGNING_ALLOWED=NO）→ zip 成 ipa → upload-artifact`。

**两个必须知道的前提**：
- 免费额度按仓库可见性分叉：公开仓库 macOS 不限分钟；私有仓库 2000 分钟 ÷ 10 倍倍率 ≈ 实际 200 分钟，且 macOS 任务要求账号先绑付款方式（否则任务卡住不动）。
- 私有仓库额度只够每月十来次构建，长期用建议开公开镜像仓库。

**工程侧补的东西**：手写并提交了 `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`。
`cap add ios`（SPM 模板）只生成用户级 scheme，Xcode 打开时才自动补；GitHub runner 上没有这个动作，
`xcodebuild -scheme App` 会报 `scheme not found`，所以共享 scheme 必须进版本库。

**签名策略**：默认不签名。CI 不需要任何证书 Secret，Windows 上用 Sideloadly + 免费 Apple ID
本地签名安装（7 天有效期）。要 TestFlight / 分发才需要 99 美元账号，届时导出 .p12 + .mobileprovision
存 Secrets，把 archive 换成 `-exportArchive`。

**纠正一处文档错误**：本文档早前写的「打开 App.xcworkspace」是错的。Capacitor 8 的 SPM 模板
不生成 workspace，`npx cap open ios` 在 SPM 模式下打开的就是 `App.xcodeproj`
（见 `@capacitor/cli/dist/ios/open.js` 的 `packageManager == 'SPM'` 分支）。
README、scripts/ios-setup.mjs 的提示文案已同步改正。
