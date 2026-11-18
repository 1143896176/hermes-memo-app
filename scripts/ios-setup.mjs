#!/usr/bin/env node
/**
 * iOS 工程补齐脚本（macOS 专用，Windows 上只做检查不写入）
 *
 * 为什么需要它：
 * `npx cap add ios` 生成的是 Capacitor 的模板工程，里面只有最基本的
 * Info.plist。这个 App 用到相机、相册、麦克风，还有"导出备份文件"功能，
 * 这些在 iOS 上全部依赖 Info.plist 的声明——少一条就是运行时直接崩
 * （不是报错，是闪退），而且 App Store 提交时才会被拒，很晚才发现。
 *
 * 用法（在 Mac 上、`npx cap add ios` 之后执行）：
 *   node scripts/ios-setup.mjs          # 写入 Info.plist
 *   node scripts/ios-setup.mjs --check  # 只检查，不改文件
 *
 * 幂等：可以反复执行，已存在的键会被覆盖成期望值。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLIST = join(ROOT, 'ios', 'App', 'App', 'Info.plist')
const CHECK_ONLY = process.argv.includes('--check')

/** 需要写入的键。string 用 -string，boolean 用 -bool。 */
const ENTRIES = [
  // ── 权限文案：缺任何一条，调用对应能力时进程直接终止 ──
  ['NSCameraUsageDescription', 'string', '用于拍摄纸质备忘、票据并识别文字，照片仅在本机处理。'],
  ['NSPhotoLibraryUsageDescription', 'string', '用于从相册选择图片并识别其中的文字，图片仅在本机处理。'],
  ['NSMicrophoneUsageDescription', 'string', '用于语音输入备忘，录音会发送到语音识别服务转成文字。'],

  // ── 备份文件可见性 ──
  // Node 运行时把导出结果写在 Documents/data/exports/。
  // 不开这两项，用户在 iOS 上没有"文件"入口能看到它，等于导出了拿不到。
  ['UIFileSharingEnabled', 'bool', true],
  ['LSSupportsOpeningDocumentsInPlace', 'bool', true],

  // ── 出口合规 ──
  // App 只用系统 HTTPS/TLS 与本机 SQLite，属于豁免范围。
  // 声明 false 后每次上传都不再被问"是否使用加密"。
  ['ITSAppUsesNonExemptEncryption', 'bool', false],
]

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
}

function readPlist() {
  // plutil 能把二进制 plist 也转成 JSON，Xcode 有时会存成 binary
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', PLIST]))
}

function setKey(key, type, value) {
  const args = type === 'bool'
    ? ['-replace', key, '-bool', String(value)]
    : ['-replace', key, '-string', String(value)]
  try {
    run('plutil', [...args, PLIST])
    return 'updated'
  } catch {
    // 键不存在时 -replace 会失败，改用 -insert
    const insertArgs = type === 'bool'
      ? ['-insert', key, '-bool', String(value)]
      : ['-insert', key, '-string', String(value)]
    run('plutil', [...insertArgs, PLIST])
    return 'added'
  }
}

function main() {
  if (!existsSync(PLIST)) {
    console.error(
      '\n找不到 ios/App/App/Info.plist。\n' +
      'iOS 原生工程只能在 macOS + Xcode 上生成，先在 Mac 上依次执行：\n\n' +
      '  npm install            # 必须让 @capawesome/capacitor-nodejs 的 postinstall 在 macOS 上跑，\n' +
      '                         # 它会把 NodeMobile.xcframework 下载到 node_modules 里\n' +
      '  npx cap add ios        # 生成 ios/ 工程\n' +
      '  npm run build          # 产出 dist（含 nodejs 运行时）\n' +
      '  npx cap sync ios       # 把 dist 拷进 ios/App/App/public\n' +
      '  node scripts/ios-setup.mjs\n\n' +
      '注意：不要设置 CAPACITOR_NODEJS_SKIP_DOWNLOAD=1，否则 Node 运行时的 iOS 二进制不会下载，编译会失败。\n'
    )
    process.exit(1)
  }

  if (process.platform !== 'darwin') {
    console.warn('[ios-setup] 当前不是 macOS，plutil 不可用，只做检查。')
  }

  const before = readPlist()
  const plan = []
  let changed = 0

  for (const [key, type, value] of ENTRIES) {
    const current = before[key]
    const desired = type === 'bool' ? Boolean(value) : String(value)
    const ok = current === desired
    plan.push({ key, ok, current, desired })
    if (ok) continue
    if (CHECK_ONLY || process.platform !== 'darwin') continue
    setKey(key, type, value)
    changed++
  }

  console.log('\nInfo.plist 检查结果：')
  for (const p of plan) {
    const mark = p.ok ? '✓' : (CHECK_ONLY || process.platform !== 'darwin' ? '✗' : '→')
    const now = p.ok ? '已符合' : `当前=${JSON.stringify(p.current ?? null)} → 期望=${JSON.stringify(p.desired)}`
    console.log(`  ${mark} ${p.key.padEnd(34)} ${now}`)
  }

  if (CHECK_ONLY || process.platform !== 'darwin') {
    const missing = plan.filter(p => !p.ok).length
    console.log(`\n${missing ? `${missing} 项待写入` : '全部符合'}（检查模式，未修改文件）\n`)
    return
  }

  console.log(`\n已更新 ${changed} 项：${PLIST}`)

  // ── 后续校验：这几步错了，装到手机上就是白屏 ──
  const publicDir = join(ROOT, 'ios', 'App', 'App', 'public')
  const nodeEntry = join(publicDir, 'nodejs', 'index.js')
  if (!existsSync(nodeEntry)) {
    console.warn(
      '\n⚠️  ios/App/App/public/nodejs/index.js 不存在。\n' +
      '   先执行 `npm run build && npx cap sync ios`，否则 Node 运行时找不到项目目录，\n' +
      '   App 启动后会一直停在"本地数据库未就绪"。\n'
    )
  } else {
    console.log('✓ Node 运行时项目已同步到 ios/App/App/public/nodejs')
  }

  console.log(
    '\n下一步：\n' +
    '  1. open ios/App/App.xcodeproj（SPM 工程没有 .xcworkspace，别去找）\n' +
    '  2. Signing & Capabilities 里选你的 Team，Bundle ID 保持 com.hermes.memo\n' +
    '  3. 确认 Package Dependencies 里有 Capacitor、CapacitorKeyboard、CapawesomeCapacitorNodejs\n' +
    '  4. 真机跑一次，看 Xcode 控制台里的 [hermes-node] capabilities 日志\n'
  )
}

main()
