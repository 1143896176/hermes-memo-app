/**
 * 系统语音识别（Android SpeechRecognizer / iOS SFSpeechRecognizer）
 *
 * 为什么需要它：WebView 里没有可用的 webkitSpeechRecognition（Android System
 * WebView 根本不实现，iOS WKWebView 也不暴露），而云端 ASR 又受格式和免费额度
 * 限制。系统识别由设备自带的语音服务完成，实时出字、不消耗 API 额度。
 *
 * 原生侧实现两端各一份，对外契约完全一致：
 *   - Android: android/app/src/main/java/com/hermes/memo/SystemSpeechPlugin.java
 *   - iOS    : ios/App/App/SystemSpeechPlugin.swift
 *
 * ⚠️ Android 关键坑：不少国产机的「系统默认识别服务」指向 Google 语音服务
 * （com.google.android.googlequicksearchbox），国内网络根本连不上，
 * 一识别就报 ERROR_NETWORK（"系统语音服务网络异常"）。
 * 原生插件已改为枚举全部 RecognitionService 并优先选择厂商服务；
 * 若设备上只有 Google 一家，probe() 会返回 googleOnly=true，
 * 此时应当直接用云端识别，不要白点一次。
 *
 * ⚠️ iOS 关键差异：只有系统一家服务（googleOnly 恒为 false），但需要
 * 麦克风 + 语音识别两重授权；默认走离线识别（不上传音频、不依赖网络），
 * 离线模型没下好时原生会自动退回在线重试一次，前端不用管。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { currentPlatform } from './platform'

export interface SystemSpeechResult {
  text: string
}

export interface SystemSpeechService {
  packageName: string
  className: string
  label: string
  /** Google 系服务：国内网络不可用（仅 Android 会出现） */
  google: boolean
  system: boolean
}

export interface SystemSpeechProbe {
  /** 设备上是否存在识别服务（存在 ≠ 能用） */
  available: boolean
  services: SystemSpeechService[]
  /** 只有 Google 服务 → 国内基本必失败（iOS 恒为 false） */
  googleOnly: boolean
  selected: string | null
  selectedLabel: string | null
  /** 是否支持离线识别（Android 恒为 false，iOS 13+ 视语言模型而定） */
  onDevice?: boolean
  /** 语音识别授权状态（仅 iOS：authorized / denied / restricted / notDetermined） */
  authStatus?: string
  /** 麦克风是否已授权（仅 iOS：区分"没授权"和"没服务"两种情况） */
  micGranted?: boolean
}

interface SystemSpeechNative {
  probe(): Promise<{
    available: boolean
    services: SystemSpeechService[]
    googleOnly: boolean
    selected: string | null
    selectedLabel: string | null
    onDevice?: boolean
    authStatus?: string
    micGranted?: boolean
  }>
  available(): Promise<{ available: boolean }>
  start(options: { language?: string; preferOnDevice?: boolean }): Promise<SystemSpeechResult>
  stop(): Promise<void>
  cancel(): Promise<void>
  addListener(
    eventName: 'started' | 'partial' | 'result' | 'error',
    listener: (data: any) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const Native = registerPlugin<SystemSpeechNative>('SystemSpeech')

const SUPPORTED = (() => {
  try {
    if (!Capacitor.isNativePlatform()) return false
    const p = Capacitor.getPlatform()
    return p === 'android' || p === 'ios'
  } catch {
    return false
  }
})()

const IS_IOS = (() => {
  try {
    return currentPlatform() === 'ios'
  } catch {
    return false
  }
})()

const EMPTY_PROBE: SystemSpeechProbe = {
  available: false, services: [], googleOnly: false, selected: null, selectedLabel: null,
}

let _probe: SystemSpeechProbe | null = null

/** 是否运行在原生壳里且本平台有对应插件（Android APK / iOS App） */
export function systemSpeechSupported(): boolean {
  return SUPPORTED
}

/** 探测设备上的识别服务（结果缓存，除非显式 reset） */
export async function probeSystemSpeech(): Promise<SystemSpeechProbe> {
  if (!SUPPORTED) return { ...EMPTY_PROBE }
  if (_probe) return _probe
  try {
    const r = await Native.probe()
    _probe = {
      available: !!r?.available,
      services: Array.isArray(r?.services) ? r.services : [],
      googleOnly: !!r?.googleOnly,
      selected: r?.selected ?? null,
      selectedLabel: r?.selectedLabel ?? null,
      onDevice: !!r?.onDevice,
      authStatus: r?.authStatus,
      micGranted: r?.micGranted,
    }
  } catch {
    _probe = { ...EMPTY_PROBE }
  }
  return _probe
}

/** 设备是否真的有可用的系统语音识别服务 */
export async function isSystemSpeechAvailable(): Promise<boolean> {
  if (!SUPPORTED) return false
  const p = await probeSystemSpeech()
  // 只有 Google 服务时视为不可用：国内网络必然 ERROR_NETWORK
  return p.available && !p.googleOnly
}

/** 让下一次判断重新探测（例如用户刚在系统里装了语音服务） */
export function resetSystemSpeechProbe() {
  _probe = null
}

export interface ListenOptions {
  language?: string
  /** 优先离线识别（仅 iOS 有意义；默认 true，模型缺失时原生自动退回在线） */
  preferOnDevice?: boolean
  onStart?: () => void
  onPartial?: (text: string) => void
  /** 兜底超时：系统识别偶尔既不回调结果也不报错 */
  timeoutMs?: number
}

/**
 * 把原生错误码归一成「是否属于服务端/网络问题」，这类失败应改走云端。
 *
 * 注意要排除的都是"用户能处理"的错误：没权限、听不清、被取消、服务忙——
 * 这些转云端也救不回来，反而会让用户莫名其妙被切走并多花一次额度。
 * 两端的 code 集合由原生侧对齐（见各自的 mapError/switch）。
 */
export function isServiceUnavailableError(e: any): boolean {
  const code = String(e?.code ?? e?.reason ?? '')
  if (['NETWORK', 'SERVER', 'TOO_MANY', 'LANG_NOT_SUPPORTED', 'LANG_UNAVAILABLE', 'NO_SERVICE', 'START_FAILED'].includes(code)) {
    return true
  }
  // Android 原生 error 事件里的数字码：1=NETWORK_TIMEOUT 2=NETWORK 4=SERVER 11=SERVER_DISCONNECTED
  const num = Number(e?.code)
  if ([1, 2, 4, 11].includes(num)) return true
  const msg = String(e?.message || '')
  return /网络|服务返回错误|连接超时|连不上|没有可用的系统语音识别服务|服务当前不可用/.test(msg)
}

/** 是否属于"用户需要去设置里改权限"的错误（不该自动切云端） */
export function isPermissionError(e: any): boolean {
  const code = String(e?.code ?? e?.reason ?? '')
  if (code === 'PERMISSION_DENIED') return true
  return /权限/.test(String(e?.message || ''))
}

/**
 * 开始一次系统语音识别。
 * resolve 时返回最终文本；用户说太久没出声，系统会自动结束。
 */
export async function listenSystemSpeech(opts: ListenOptions = {}): Promise<SystemSpeechResult> {
  if (!SUPPORTED) throw new Error('当前环境不支持系统语音识别')

  const handles: { remove: () => Promise<void> }[] = []
  let timer: any = null

  // iOS 单次最多约 55s（原生侧限流），JS 兜底要比它长一点，
  // 否则长句说到一半被前端判超时，反而把已经识别出来的字丢了
  const timeoutMs = opts.timeoutMs ?? (IS_IOS ? 60_000 : 30_000)
  // 停止采音后原生还要等 final result，留这段宽限再判超时
  const GRACE_MS = 2_500

  try {
    handles.push(await Native.addListener('started', () => opts.onStart?.()))
    if (opts.onPartial) {
      handles.push(await Native.addListener('partial', (d) => opts.onPartial?.(d?.text || '')))
    }

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 先让原生收尾（已说的话仍会 resolve），只有它也不回才判超时
        Native.stop().catch(() => {})
        timer = setTimeout(() => reject(new Error('语音识别超时，请重试')), GRACE_MS)
      }, timeoutMs)
    })

    const r = await Promise.race([
      Native.start({
        language: opts.language || 'zh-CN',
        preferOnDevice: opts.preferOnDevice ?? true,
      }),
      timeout,
    ])
    return { text: (r?.text || '').trim() }
  } finally {
    if (timer) clearTimeout(timer)
    await Promise.all(handles.map((h) => h.remove().catch(() => {})))
  }
}

/** 让系统识别提前收尾（已说的话仍会返回结果） */
export async function stopSystemSpeech(): Promise<void> {
  if (!SUPPORTED) return
  try { await Native.stop() } catch {}
}

/** 直接放弃这次识别 */
export async function cancelSystemSpeech(): Promise<void> {
  if (!SUPPORTED) return
  try { await Native.cancel() } catch {}
}
