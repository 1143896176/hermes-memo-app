/**
 * 平台判定 —— 只回答"我是谁"，不做任何业务判断。
 *
 * 为什么要单独一个文件：
 * 同一个功能在 Android 和 iOS 上的可用能力不一样（系统语音识别只有 Android
 * 有原生插件、WebView 内核不同导致报错文案也不同）。散落在各组件里写
 * `Capacitor.getPlatform() === 'android'` 会把平台知识撕成碎片，
 * 加第三个平台（Web/PWA）时无处下手。
 */
import { Capacitor } from '@capacitor/core'

export type AppPlatform = 'ios' | 'android' | 'web'

/** 当前运行平台（浏览器预览时是 'web'） */
export function currentPlatform(): AppPlatform {
  try {
    const p = Capacitor.getPlatform()
    if (p === 'ios' || p === 'android') return p
    return 'web'
  } catch {
    return 'web'
  }
}

/** 是否在原生壳里（Android APK / iOS App） */
export function isNativeShell(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export function isIOS(): boolean {
  return currentPlatform() === 'ios'
}

export function isAndroid(): boolean {
  return currentPlatform() === 'android'
}

/**
 * WebView 内核名称 —— 只用于"转码失败/解码失败"这类兜底报错，
 * 告诉用户该更新什么。写死 Android 会让 iOS 用户看到牛头不对马嘴的提示。
 */
export function webViewEngineName(): string {
  const p = currentPlatform()
  if (p === 'ios') return 'iOS 系统 WebView（WKWebView）'
  if (p === 'android') return 'Android System WebView'
  return '当前浏览器'
}
