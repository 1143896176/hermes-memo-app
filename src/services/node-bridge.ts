/**
 * WebView 侧 Node Bridge 客户端
 *
 * 与 Android 内嵌的 Node.js runtime 通信（通过 @capawesome/capacitor-nodejs）。
 * Node runtime 里跑的是完整 hermes-ts 核心：deepagents + FTS5 + 多.db + fs。
 *
 * 通信协议：
 *   WebView → Node:  Nodejs.send({ id, method, params })
 *   Node → WebView:  Nodejs.send({ id, result }) 或 { id, error }
 *   Node 启动就绪:   Nodejs.send({ __ready: true })
 *
 * 在非 Capacitor 环境（纯浏览器开发预览）下，自动降级到 src/services/engine.ts
 * 的浏览器版实现（sql.js + deepagents/browser），保证开发时不依赖真机。
 */

import { Capacitor } from '@capacitor/core'

// ── Node.js bridge（仅 Capacitor 原生环境可用） ──
let _Nodejs: any = null
let _nodeReady = false
let _readyPromise: Promise<boolean> | null = null
const _pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
let _callId = 0

// 运行环境检测
function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

// 初始化标记（避免重复加载）
let _pluginLoaded = false

export function loadNodejsPluginSync() {
  if (_pluginLoaded) return _Nodejs
  if (!isNative()) return null
  _pluginLoaded = true
  // 动态 import 是异步的，但触发后 _Nodejs 会在下一 tick 赋值
  // 用 import() 触发加载，但不 await——依赖 listener 在赋值后立即注册
  import('@capawesome/capacitor-nodejs').then((mod) => {
    _Nodejs = mod.Nodejs
    registerListeners()
  }).catch((e) => {
    console.warn('[node-bridge] plugin load failed:', e)
    _pluginLoaded = false  // 允许重试
  })
  return _Nodejs  // 可能是 null（首次调用时还在加载）
}

function registerListeners() {
  if (!_Nodejs) return
  try {
    // Capacitor 把所有 Node → WebView 的 channel.post 事件包装成 'message' 事件
    // event 结构: { eventName: string, args: any[] }
    _Nodejs.addListener('message', (event: any) => {
      const eventName = event?.eventName
      const data = event?.args?.[0]
      if (eventName === 'rpc') {
        // RPC 响应: { id, result|error }
        if (data && data.id && _pending.has(data.id)) {
          const p = _pending.get(data.id)!
          _pending.delete(data.id)
          if (data.error) p.reject(new Error(data.error))
          else p.resolve(data.result)
        }
      } else if (eventName === 'ready') {
        _nodeReady = true
        console.log('[node-bridge] Node runtime ready:', data)
      }
    })
    // 主动检查就绪
    _Nodejs.isReady().then((r: any) => {
      if (r && r.ready) {
        _nodeReady = true
        console.log('[node-bridge] Node already ready (isReady API)')
      }
    }).catch(() => {})
  } catch (e) {
    console.warn('[node-bridge] registerListeners failed:', e)
  }
}

// 说明：早期有一个 async 版 loadNodejsPlugin，已全部改为 loadNodejsPluginSync
// （await Proxy 会触发 then trap 导致卡死），此处不再保留死代码。

/** 等待 Node runtime 就绪 */
export async function waitForNode(timeoutMs = 10000): Promise<boolean> {
  if (!isNative()) return false
  if (_nodeReady) return true
  if (_readyPromise) return _readyPromise

  const p = new Promise<boolean>(async (resolve) => {
    try {
      // 同步触发加载（不 await，避免 Proxy then trap）
      if (!_Nodejs) loadNodejsPluginSync()
      // 等待 _Nodejs 赋值
      let tries = 0
      while (!_Nodejs && tries < 50) {
        await new Promise(r => setTimeout(r, 10))
        tries++
      }
      if (!_Nodejs) { resolve(false); return }
      // 检查是否已就绪
      if (_nodeReady) { resolve(true); return }
      // 等待 ready 事件（registerListeners 会设 _nodeReady）
      const checkInterval = setInterval(() => {
        if (_nodeReady) {
          clearInterval(checkInterval)
          clearTimeout(timeoutHandle)
          resolve(true)
        }
      }, 100)
      const timeoutHandle = setTimeout(() => {
        clearInterval(checkInterval)
        resolve(_nodeReady)
      }, timeoutMs)
    } catch (e) {
      console.warn('[node-bridge] waitForNode error:', e)
      resolve(false)
    }
  })
  // 等待失败（超时 / 插件加载失败）时清掉缓存，允许下一次调用重新等待。
  // 否则一次超时会把 _readyPromise 永久钉在 false，之后所有数据调用都拿不到数据库。
  p.then((ok) => { if (!ok) _readyPromise = null })
  _readyPromise = p
  return p
}

/** 调用 Node runtime 的方法 */
export async function callNode<T = any>(method: string, params?: any): Promise<T> {
  if (!isNative()) {
    throw new Error('node-bridge 仅在原生环境可用，开发预览请用 engine.ts 浏览器版')
  }
  // 同步获取插件（避免 await Proxy 的 then trap）
  if (!_Nodejs) loadNodejsPluginSync()
  const nodejs = _Nodejs
  if (!nodejs) {
    // 同步加载没完成，等一下再试
    await new Promise(r => setTimeout(r, 200))
    if (!_Nodejs) throw new Error('Node.js 插件加载失败')
  }
  const plugin = _Nodejs!

  // 确保就绪
  if (!_nodeReady) {
    const ok = await waitForNode()
    if (!ok) throw new Error('Node runtime 未就绪（10s 超时）')
  }

  const id = ++_callId
  return new Promise<T>((resolve, reject) => {
    _pending.set(id, { resolve, reject })
    // 发送 RPC 到 Node（用 Promise.resolve 包装避免 then trap）
    Promise.resolve(plugin.send({ eventName: 'rpc', args: [{ id, method, params }] }))
    // 单次调用超时
    setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id)
        reject(new Error(`Node 调用超时: ${method}（30s）`))
      }
    }, 30_000)
  })
}

/** 当前是否在原生环境且 Node runtime 已就绪 */
export function isNodeReady(): boolean {
  return isNative() && _nodeReady
}

/**
 * 决定这次调用走 Node 还是浏览器引擎。
 *
 * 注意：不能直接用 isNodeReady()。App 启动瞬间 Node 还没起来，
 * 此时 isNodeReady() === false，会静默降级到浏览器版 sql.js（那是另一份
 * 空数据库），于是首页第一次加载永远是空列表 —— 等用户点一下筛选条件，
 * Node 已就绪，数据才出现。这就是"默认活跃但列表没数据"的根因。
 *
 * 所以原生环境下先等 Node 就绪，等不到就抛错（让 UI 明确报错并允许重试），
 * 而不是悄悄返回空数据。
 */
async function shouldUseNode(waitMs = 15000): Promise<boolean> {
  if (!isNativeEnv()) return false
  if (_nodeReady) return true
  const ok = await waitForNode(waitMs)
  if (!ok) throw new Error('本地数据库（Node 运行时）未就绪，请稍后重试')
  return true
}

/** 是否运行在原生环境（Android APK 内） */
export function isNativeEnv(): boolean {
  return isNative()
}

// ═══════════════════════════
// 高层 API：透明切换 Node / 浏览器引擎
// ═══════════════════════════

/**
 * 统一服务层：原生环境走 Node runtime（完整 hermes-ts），浏览器开发预览走 engine.ts
 * UI 组件只调用这里的函数，不直接 callNode 也不直接 import engine
 */

// 延迟 import engine 避免原生环境也加载浏览器版
async function browserEngine() {
  return await import('./engine')
}
async function browserAgent() {
  return await import('./agent')
}

// ── Agent 对话 ──
export async function chatWithAgent(text: string, threadId?: string): Promise<string> {
  if (await shouldUseNode()) {
    const r = await callNode<{ reply: string }>('agent.chat', { text, threadId: threadId || 'default' })
    return r.reply
  }
  const agent = await browserAgent()
  return agent.chatWithAgent(text, threadId)
}

// ── 草稿结果类型（与 engine.ts 的 DraftResult 对齐） ──
export type DraftResult = {
  draft: {
    title: string; content: string
    event: string
    tags: string[]
    location: string; due_date: string
    inferred_location?: string; inferred_due_date?: string
    [key: string]: any
  }
  rawText: string
  correctedText: string
  corrections: { from: string; to: string }[]
  /** LLM 是否真的参与了结构化（false = 已降级为原文草稿） */
  llmUsed?: boolean
  jsonMode?: boolean
  /** 降级原因，UI 直接展示给用户 */
  llmError?: string
  missingKeyFields?: string[]
  missingFields?: string[]
}

// ── 备忘录 CRUD ──
export async function fetchMemos(params?: Record<string, string>) {
  if (await shouldUseNode()) return callNode('memo.list', params)
  const e = await browserEngine()
  return e.fetchMemos(params)
}

export async function searchMemos(query: string, params?: Record<string, string>) {
  if (await shouldUseNode()) return callNode('memo.search', { query, ...params })
  const e = await browserEngine()
  return e.searchMemos(query, params)
}

export async function saveMemo(data: { title: string; content: string; tags?: string[]; location?: string; due_date?: string; event?: string }) {
  if (await shouldUseNode()) return callNode('memo.save', data)
  const e = await browserEngine()
  return e.saveMemo(data)
}

export async function updateMemoStatus(id: number, status: string) {
  if (await shouldUseNode()) return callNode('memo.update_status', { id, status })
  const e = await browserEngine()
  return e.updateMemoStatus(id, status)
}

export async function deleteMemo(id: number) {
  if (await shouldUseNode()) return callNode('memo.delete', { id })
  const e = await browserEngine()
  return e.deleteMemo(id)
}

// ── 草稿管线（Node 版完整管线，浏览器版降级） ──
export async function createDraft(text: string) {
  if (await shouldUseNode()) return callNode('draft.text', { text })
  const e = await browserEngine()
  return e.createDraft(text)
}

export async function reviseDraft(originalText: string, newText: string) {
  if (await shouldUseNode()) return callNode('draft.revise', { originalText, newText })
  const e = await browserEngine()
  return e.reviseDraft(originalText, newText)
}

export async function confirmDraft(d: any) {
  if (await shouldUseNode()) {
    try {
      return await callNode('draft.confirm', { draft: d })
    } catch (e: any) {
      // 兜底：结构化确认只是"存库 + 学习修正"，失败了也不能让用户刚识别出来的备忘丢掉。
      // 直接走最朴素的 memo.save（不做学习记录），能存进去就先存。
      const dd = (d && d.draft) ? d.draft : (d || {})
      const title = String(dd.title || dd.content || '').trim()
      const content = String(dd.content || dd.title || '').trim()
      if (!title && !content) throw e
      try {
        const r: any = await callNode('memo.save', {
          title: (title || content.slice(0, 30)).slice(0, 60),
          content: content || title,
          tags: Array.isArray(dd.tags) ? dd.tags.filter((t: any) => typeof t === 'string') : [],
          event: typeof dd.event === 'string' ? dd.event : '',
          location: dd.location || dd.inferred_location || '',
          due_date: dd.due_date || dd.inferred_due_date || '',
        })
        return { ...r, fallback: true }
      } catch (e2: any) {
        throw new Error(`${e?.message || e}；兜底保存同样失败：${e2?.message || e2}`)
      }
    }
  }
  const e = await browserEngine()
  return e.confirmDraft(d)
}

/**
 * 读取 Node 侧落盘的配置（不含 Key 明文）；浏览器预览返回 null。
 *
 * 原生环境里真正持久的是 DATA_DIR/llm-config.json，WebView 的 engine 配置
 * 只是内存 + IndexedDB。启动时先读这里，才能避免"用默认值覆盖用户配置"。
 */
export async function getNodeConfig(): Promise<{
  hasApiKey: boolean; keyLength: number
  model: string; baseURL: string
  ocrModel?: string; asrBase?: string
  configFile?: string
} | null> {
  if (!isNativeEnv()) return null
  try {
    return await callNode('config.get')
  } catch (e) {
    console.warn('[node-bridge] config.get failed:', e)
    return null
  }
}

// ── 诊断：把"哪一层坏了"变成一次按钮点击 ──
/** 运行环境 + 数据库 + LLM 配置的完整自检（原生走 Node，浏览器走 sql.js） */
export async function diagnose(): Promise<any> {
  if (isNativeEnv()) {
    const started = Date.now()
    try {
      const r = await callNode('diag.report')
      return { mode: 'node', rpcMs: Date.now() - started, ...r }
    } catch (e: any) {
      // Node 起来了但 diag 失败，或 Node 根本没起来 —— 这两种要靠这里的报错区分
      return {
        mode: 'node',
        rpcMs: Date.now() - started,
        fatal: e?.message || String(e),
        nodeReady: isNodeReady(),
      }
    }
  }
  const e = await browserEngine()
  const cfg = e.getApiConfig()
  const report: any = {
    mode: 'browser',
    platform: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    llm: { hasKey: !!cfg.apiKey1, keyLength: (cfg.apiKey1 || '').length, model: cfg.modelName, baseURL: cfg.apiBase },
    counts: {},
  }
  try {
    const r: any = await e.fetchMemos({ limit: '1' })
    report.counts.memos = r.total
  } catch (err: any) {
    report.countError = err?.message || String(err)
  }
  return report
}

/** 真打一次模型请求，返回 401/402/404/429 这类原始错误 */
export async function llmPing(): Promise<any> {
  if (isNativeEnv()) {
    try {
      return { mode: 'node', ...(await callNode('llm.ping')) }
    } catch (e: any) {
      return { mode: 'node', ok: false, error: e?.message || String(e) }
    }
  }
  const e = await browserEngine()
  return { mode: 'browser', ...(await e.pingLLM()) }
}

// ── 草稿字段 Schema（决定"输出什么字段"，默认含 event/due_date/location 三要素） ──
export async function getDraftSchema() {
  if (await shouldUseNode()) return callNode('draft.schema.get')
  // 浏览器预览模式不支持自定义 schema，返回空壳由 UI 提示
  return { fields: [], defaultFields: [], isCustom: false, path: '', browserMode: true }
}

export async function setDraftSchema(fields: any[] | null) {
  if (await shouldUseNode()) return callNode('draft.schema.set', { fields })
  throw new Error('自定义草稿字段依赖 Node 运行时，请在 App 内配置（浏览器预览不支持）')
}

// ── 术语词典 ──
export async function fetchGlossary() {
  if (await shouldUseNode()) return callNode('glossary.list')
  const e = await browserEngine()
  return e.fetchGlossary()
}

export async function addGlossary(wrong_term: string, correct_term: string) {
  if (await shouldUseNode()) return callNode('glossary.add', { wrong_term, correct_term })
  const e = await browserEngine()
  return e.addGlossary(wrong_term, correct_term)
}

export async function removeGlossary(id: number) {
  if (await shouldUseNode()) return callNode('glossary.remove', { id })
  const e = await browserEngine()
  return e.removeGlossary(id)
}

// ── OCR ──
export async function ocrRecognize(file: File): Promise<{ text: string; confidence: number }> {
  // OCR 始终在 WebView 侧做（要 FileReader + fetch 智谱），不走 Node
  const e = await browserEngine()
  return e.ocrRecognize(file)
}

// ── 语音转文字 ──
export async function transcribeAudio(
  blob: Blob,
  opts?: { hotwords?: string[] },
): Promise<{ text: string }> {
  // 录音产物在 WebView 里（MediaRecorder），转写也在 WebView 侧 fetch 智谱 ASR
  const e = await browserEngine()
  return e.transcribeAudio(blob, opts)
}

// ── 记忆 / 用户画像 ──
export async function getMemoryProfile() {
  if (await shouldUseNode()) return callNode<{ memory: string; user: string }>('memory.get')
  const e = await browserEngine()
  return e.getMemoryProfile()
}

export async function setMemoryProfile(memory: string, user: string) {
  if (await shouldUseNode()) return callNode('memory.set', { memory, user })
  const e = await browserEngine()
  return e.setMemoryProfile(memory, user)
}

// ── 技能管理（完整 6 action） ──
export async function listSkills() {
  if (await shouldUseNode()) return callNode('skill.list')
  const e = await browserEngine()
  return e.listSkills()
}

export async function getSkill(name: string) {
  if (await shouldUseNode()) return callNode('skill.view', { name })
  const e = await browserEngine()
  return e.getSkill(name)
}

export async function saveSkill(name: string, content: string) {
  if (await shouldUseNode()) return callNode('skill.manage', { action: 'create', name, content })
  const e = await browserEngine()
  return e.saveSkill(name, content)
}

export async function deleteSkill(name: string) {
  if (await shouldUseNode()) return callNode('skill.manage', { action: 'delete', name })
  const e = await browserEngine()
  return e.deleteSkill(name)
}

/** 完整 skill_manage（仅 Node runtime 支持 write_file/remove_file） */
export async function skillManage(action: string, params: any) {
  if (await shouldUseNode()) return callNode('skill.manage', { action, ...params })
  // 浏览器降级：只支持 create/edit/delete/patch
  const e = await browserEngine()
  if (action === 'create' || action === 'edit') return e.saveSkill(params.name, params.content)
  if (action === 'delete') return e.deleteSkill(params.name)
  if (action === 'patch') {
    const s = await e.getSkill(params.name)
    if (!s) throw new Error('skill not found')
    return e.saveSkill(params.name, (s.content || '').replace(params.old_string, params.new_string))
  }
  throw new Error(`浏览器环境不支持 skill action: ${action}（write_file/remove_file 需 Node runtime）`)
}

// ── 导出 ──
export async function doExport(scope?: string, includeDone?: boolean) {
  if (await shouldUseNode()) return callNode('export.all', { scope, includeDone })
  const e = await browserEngine()
  return e.doExport(scope as any, includeDone)
}

export interface ExportOptions {
  memos?: boolean; includeDone?: boolean
  glossary?: boolean; skills?: boolean
  memory?: boolean; config?: boolean
}
/** 导出数据为 JSON 对象（浏览器下载 / Node 原生） */
export async function exportData(opts: ExportOptions = {}): Promise<any> {
  if (await shouldUseNode()) return callNode('export.data', opts)
  const e = await browserEngine()
  return e.exportData(opts)
}

/** 导入 JSON 数据 */
export async function importData(json: any): Promise<{ imported: number; skipped: number }> {
  if (await shouldUseNode()) return callNode('import.data', { json })
  const e = await browserEngine()
  return e.importData(json)
}

// ── 知识库 ──
export async function fetchKnowledge(): Promise<any[]> {
  if (await shouldUseNode()) return callNode('knowledge.list')
  const e = await browserEngine()
  return e.fetchKnowledge()
}

export async function searchKnowledge(query: string): Promise<any[]> {
  if (await shouldUseNode()) return callNode('knowledge.search', { query })
  const e = await browserEngine()
  return e.searchKnowledge(query)
}

export async function saveKnowledge(data: any): Promise<{ id: number }> {
  if (await shouldUseNode()) return callNode('knowledge.save', data)
  const e = await browserEngine()
  return e.saveKnowledge(data)
}

export async function deleteKnowledge(id: number): Promise<{ ok: boolean }> {
  if (await shouldUseNode()) return callNode('knowledge.delete', { id })
  const e = await browserEngine()
  return e.deleteKnowledge(id)
}

// ── API 配置（需同步传给 Node runtime） ──
export async function syncApiConfigToNode(config: {
  apiKey1: string; apiKey2: string; apiBase: string; modelName: string
  ocrKey: string; ocrModel: string
  asrKey: string; asrBase: string
}) {
  // 浏览器侧也存一份（engine.ts 的 setApiConfig）
  const e = await browserEngine()
  e.setApiConfig(config)

  if (!isNativeEnv()) return

  // 映射成 Node 侧契约字段（public/nodejs/config.js 里是 apiKey/baseURL/model）。
  // 直接把 apiKey1/apiBase/modelName 传过去会被 setConfig 忽略，
  // 导致 ChatOpenAI 拿不到 apiKey，报 "Missing credentials"。
  const payload = {
    apiKey: config.apiKey1 || config.apiKey2 || '',
    apiKey2: config.apiKey2 || '',
    baseURL: config.apiBase || '',
    model: config.modelName || '',
    temperature: 0,
    ocrKey: config.ocrKey || '',
    ocrModel: config.ocrModel || '',
        asrKey: config.asrKey || '',
        asrBase: config.asrBase || '',
      }
  // 不判断 isNodeReady()：callNode 内部会 waitForNode，
  // 否则设置面板在 Node 未就绪时点保存会静默丢配置
  await callNode('config.set', payload)
}
