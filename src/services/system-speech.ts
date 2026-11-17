/**
 * 系统语音识别（Android SpeechRecognizer）
 *
 * 为什么需要它：Android WebView 里没有 webkitSpeechRecognition（那是 Chrome
 * 浏览器独有），而云端 ASR 又受格式和免费额度限制。系统识别由设备自带的
 * 语音服务完成，实时出字、不消耗 API 额度。
 *
 * 原生侧实现在 android/app/src/main/java/com/hermes/memo/SystemSpeechPlugin.java。
 *
 * ⚠️ 关键坑：不少国产机的「系统默认识别服务」指向 Google 语音服务
 * （com.google.android.googlequicksearchbox），国内网络根本连不上，
 * 一识别就报 ERROR_NETWORK（"系统语音服务网络异常"）。
 * 原生插件已改为枚举全部 RecognitionService 并优先选择厂商服务；
 * 若设备上只有 Google 一家，probe() 会返回 googleOnly=true，
 * 此时应当直接用云端识别，不要白点一次。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface SystemSpeechResult {
  text: string
}

export interface SystemSpeechService {
  packageName: string
  className: string
  label: string
  /** Google 系服务：国内网络不可用 */
  google: boolean
  system: boolean
}

export interface SystemSpeechProbe {
  /** 设备上是否存在识别服务（存在 ≠ 能用） */
  available: boolean
  services: SystemSpeechService[]
  /** 只有 Google 服务 → 国内基本必失败 */
  googleOnly: boolean
  selected: string | null
  selectedLabel: string | null
}

interface SystemSpeechNative {
  probe(): Promise<{
    available: boolean
    services: SystemSpeechService[]
    googleOnly: boolean
    selected: string | null
    selectedLabel: string | null
  }>
  available(): Promise<{ available: boolean }>
  start(options: { language?: string }): Promise<SystemSpeechResult>
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
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
})()

const EMPTY_PROBE: SystemSpeechProbe = {
  available: false, services: [], googleOnly: false, selected: null, selectedLabel: null,
}

let _probe: SystemSpeechProbe | null = null

/** 是否运行在 Android 原生壳里（只有这里有插件） */
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
  onStart?: () => void
  onPartial?: (text: string) => void
  /** 兜底超时：系统识别偶尔既不回调结果也不报错 */
  timeoutMs?: number
}

/** 把原生错误码归一成「是否属于服务端/网络问题」，这类失败应改走云端 */
export function isServiceUnavailableError(e: any): boolean {
  const code = String(e?.code ?? e?.reason ?? '')
  if (['NETWORK', 'SERVER', 'TOO_MANY', 'LANG_NOT_SUPPORTED', 'LANG_UNAVAILABLE', 'NO_SERVICE', 'START_FAILED'].includes(code)) {
    return true
  }
  // 原生 error 事件里的数字码：1=NETWORK_TIMEOUT 2=NETWORK 4=SERVER 11=SERVER_DISCONNECTED
  const num = Number(e?.code)
  if ([1, 2, 4, 11].includes(num)) return true
  const msg = String(e?.message || '')
  return /网络|服务返回错误|连接超时|连不上|没有可用的系统语音识别服务/.test(msg)
}

/**
 * 开始一次系统语音识别。
 * resolve 时返回最终文本；用户说太久没出声，系统会自动结束。
 */
export async function listenSystemSpeech(opts: ListenOptions = {}): Promise<SystemSpeechResult> {
  if (!SUPPORTED) throw new Error('当前环境不支持系统语音识别')

  const handles: { remove: () => Promise<void> }[] = []
  let timer: any = null

  try {
    handles.push(await Native.addListener('started', () => opts.onStart?.()))
    if (opts.onPartial) {
      handles.push(await Native.addListener('partial', (d) => opts.onPartial?.(d?.text || '')))
    }

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        Native.stop().catch(() => {})
        reject(new Error('语音识别超时，请重试'))
      }, opts.timeoutMs ?? 30_000)
    })

    const r = await Promise.race([
      Native.start({ language: opts.language || 'zh-CN' }),
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
