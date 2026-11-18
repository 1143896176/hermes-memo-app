/**
 * 输入焦点辅助 —— 主要是给 iOS 用的。
 *
 * Android 上有返回键可以收起键盘，iOS 没有：textarea 聚焦后，系统键盘
 * 只有"完成/换行"键，点在空白处也不会失焦。用户打完字后如果没有立刻
 * 点「生成草稿」，键盘就一直占着半屏，看起来像卡死。
 *
 * 所以这里补一个"点空白处失焦"。
 *
 * 注意不要用 capture 阶段、也不要在 button 上抢焦点：
 * iOS 上先 blur 再 click，WebView 会因为键盘收起导致布局位移，
 * 那一次点击就落空了（点"发送"没反应）。只在非交互元素上失焦。
 */

/** 判定"这一下点的是交互控件"，不要在这些元素上抢焦点 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'label',
  'input',
  'textarea',
  'select',
  '.van-button',
  '.van-cell',
  '.van-tab',
  '.van-tabbar-item',
  '.van-checkbox',
  '.van-field',
  '.van-icon',
].join(',')

let installed = false

export function initKeyboardDismiss() {
  if (installed) return
  if (typeof document === 'undefined') return
  installed = true

  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target as HTMLElement | null
      if (!el || typeof el.closest !== 'function') return
      if (el.isContentEditable) return
      if (el.closest(INTERACTIVE_SELECTOR)) return

      const active = document.activeElement as HTMLElement | null
      if (!active) return
      const tag = active.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) {
        active.blur()
      }
    },
    // 冒泡阶段：让控件自己的 click 先跑完，再收键盘
    false,
  )
}
