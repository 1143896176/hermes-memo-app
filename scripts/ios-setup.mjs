#!/usr/bin/env node
/**
 * iOS 工程补齐脚本（macOS 写 Info.plist，全平台补插件注册表）
 *
 * 为什么需要它：
 * `npx cap add ios` 生成的是 Capacitor 的模板工程，里面只有最基本的
 * Info.plist。这个 App 用到相机、相册、麦克风、系统语音识别，还有
 * "导出备份文件"功能，这些在 iOS 上全部依赖 Info.plist 的声明——少一条就是
 * 运行时直接崩（不是报错，是闪退），而且 App Store 提交时才会被拒，很晚才发现。
 *
 * 另外 `cap sync` 会重写 ios/App/App/capacitor.config.json 的 packageClassList，
 * 而它只认识 node_modules 里的插件；SystemSpeechPlugin.swift 是写在 App target
 * 里的本地插件，每次 sync 后都必须补回去，否则 JS 侧调用直接找不到实现。
 *
 * 用法（在 Mac 上、`npx cap add ios` 之后执行）：
 *   node scripts/ios-setup.mjs          # 写入 Info.plist + 补插件注册表
 *   node scripts/ios-setup.mjs --check  # 只检查，不改文件
 *
 * 幂等：可以反复执行，已存在的键会被覆盖成期望值。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLIST = join(ROOT, 'ios', 'App', 'App', 'Info.plist')
const CAP_CONFIG = join(ROOT, 'ios', 'App', 'App', 'capacitor.config.json')
const CHECK_ONLY = process.argv.includes('--check')

/** 需要写入的键。string 用 -string，boolean 用 -bool。 */
const ENTRIES = [
  // ── 权限文案：缺任何一条，调用对应能力时进程直接终止 ──
  ['NSCameraUsageDescription', 'string', '用于拍摄纸质备忘、票据并识别文字，照片仅在本机处理。'],
  ['NSPhotoLibraryUsageDescription', 'string', '用于从相册选择图片并识别其中的文字，图片仅在本机处理。'],
  ['NSMicrophoneUsageDescription', 'string', '用于语音输入备忘，录音会发送到语音识别服务转成文字。'],
  // 系统语音识别（SFSpeechRecognizer）需要单独的授权文案，和麦克风是两次弹窗
  ['NSSpeechRecognitionUsageDescription', 'string', '用于把你说的话实时转成备忘文字，语音由系统识别服务处理。'],

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

/**
 * 写在 App target 里的本地插件（不是 npm 包）。
 *
 * 为什么要在这里补：iOS 的插件注册表 `packageClassList` 由 `cap sync` 生成，
 * 它只会扫描 node_modules 里的 Capacitor 插件，App 工程自己的 Swift 类永远进不去。
 * 而 Capacitor 8 的 autoRegisterPlugins 默认开启，手动 registerPluginType 是空操作，
 * 所以只能改这份生成出来的 JSON——每次 sync 都会重写，必须每次补一遍。
 */
const LOCAL_PLUGINS = ['SystemSpeechPlugin']

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

/** 把写在 App target 里的 Swift 插件补进 Capacitor 的插件注册表 */
function ensureLocalPlugins() {
  if (!existsSync(CAP_CONFIG)) return { reason: 'missing-config' }

  let conf
  try {
    conf = JSON.parse(readFileSync(CAP_CONFIG, 'utf8'))
  } catch (e) {
    return { reason: 'bad-json', error: e.message }
  }

  const list = Array.isArray(conf.packageClassList) ? conf.packageClassList : []
  const missing = LOCAL_PLUGINS.filter(n => !list.includes(n))
  if (!missing.length) return { ok: true }

  // --check 只报告，不落盘
  if (CHECK_ONLY) return { missing }

  conf.packageClassList = [...list, ...missing]
  // cap sync 生成的是 tab 缩进，这里保持同样风格，避免整文件 diff
  writeFileSync(CAP_CONFIG, JSON.stringify(conf, null, '\t') + '\n', 'utf8')
  return { missing, fixed: true }
}

function reportLocalPlugins(r) {
  if (r.ok) {
    console.log(`\n本地插件注册：✓ ${LOCAL_PLUGINS.join(', ')} 已在 packageClassList 中`)
  } else if (r.reason === 'missing-config') {
    console.warn(`\n本地插件注册：✗ 找不到 ${CAP_CONFIG}（先跑 npx cap sync ios）`)
  } else if (r.reason === 'bad-json') {
    console.warn(`\n本地插件注册：✗ capacitor.config.json 解析失败：${r.error}`)
  } else if (r.fixed) {
    console.log(`\n本地插件注册：→ 已补入 ${r.missing.join(', ')}`)
  } else {
    console.log(`\n本地插件注册：✗ 待补入 ${r.missing.join(', ')}（检查模式，未修改）`)
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

  // ── 1. 本地插件注册：纯 Node 实现，Windows 上也能补 ──
  reportLocalPlugins(ensureLocalPlugins())

  if (process.platform !== 'darwin') {
    console.warn('[ios-setup] 当前不是 macOS，plutil 不可用，Info.plist 只做检查。')
  }

  // ── 2. Info.plist ──
  const canWritePlist = process.platform === 'darwin' && !CHECK_ONLY
  let before = null
  let plistText = ''
  try {
    plistText = readFileSync(PLIST, 'utf8')
  } catch {}
  try {
    before = readPlist()
  } catch {
    // 非 macOS 没有 plutil；退回文本匹配，只能确认"键在不在"，读不了值
    before = null
    if (process.platform === 'darwin') {
      // macOS 上 plutil 不该失败，一旦失败说明 plist 被改坏了，
      // 此时静默跳过写入会让人误以为"已补齐"，所以显式告警
      console.warn('⚠️  plutil 读取 Info.plist 失败，本次跳过写入，只做文本检查。')
    }
  }

  const plan = []
  let changed = 0

  for (const [key, type, value] of ENTRIES) {
    const desired = type === 'bool' ? Boolean(value) : String(value)
    // 能解析出 JSON 就按值比对；否则只按 <key> 是否出现来判断
    const current = before ? before[key] : (plistText.includes(`<key>${key}</key>`) ? desired : undefined)
    const ok = before ? current === desired : current !== undefined
    plan.push({ key, ok, current, desired })
    if (ok || !canWritePlist) continue
    setKey(key, type, value)
    changed++
  }

  console.log('\nInfo.plist 检查结果：')
  for (const p of plan) {
    const mark = p.ok ? '✓' : (canWritePlist ? '→' : '✗')
    const now = p.ok
      ? '已符合'
      : before
        ? `当前=${JSON.stringify(p.current ?? null)} → 期望=${JSON.stringify(p.desired)}`
        : '缺失（无法读值，仅确认键不存在）'
    console.log(`  ${mark} ${p.key.padEnd(34)} ${now}`)
  }

  if (canWritePlist) console.log(`\n已更新 ${changed} 项：${PLIST}`)

  // ── 3. 后续校验：这几步错了，装到手机上就是白屏 ──
  const publicDir = join(ROOT, 'ios', 'App', 'App', 'public')
  const nodeEntry = join(publicDir, 'nodejs', 'index.js')
  if (existsSync(nodeEntry)) {
    console.log('✓ Node 运行时项目已同步到 ios/App/App/public/nodejs')
  } else if (canWritePlist) {
    console.warn(
      '\n⚠️  ios/App/App/public/nodejs/index.js 不存在。\n' +
      '   先执行 `npm run build && npx cap sync ios`，否则 Node 运行时找不到项目目录，\n' +
      '   App 启动后会一直停在"本地数据库未就绪"。\n'
    )
  }

  if (!canWritePlist) {
    const missing = plan.filter(p => !p.ok).length
    console.log(`\n${missing ? `${missing} 项待写入` : '全部符合'}（未修改 Info.plist）\n`)
    return
  }

  console.log(
    '\n下一步：\n' +
    '  1. open ios/App/App.xcodeproj（SPM 工程没有 .xcworkspace，别去找）\n' +
    '  2. Signing & Capabilities 里选你的 Team，Bundle ID 保持 com.hermes.memo\n' +
    '  3. 确认 Package Dependencies 里有 Capacitor、CapacitorKeyboard、CapawesomeCapacitorNodejs\n' +
    '  4. 确认 App target 的 Compile Sources 里有 SystemSpeechPlugin.swift\n' +
    '  5. 真机跑一次：点语音按钮应弹出麦克风 + 语音识别两次授权\n'
  )
}

main()
