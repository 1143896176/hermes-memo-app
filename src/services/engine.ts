/**
 * 智能备忘录引擎 — WebView 内运行
 *
 * 无 Node.js 依赖，全部在浏览器/WebView 中执行：
 * - sql.js（SQLite WASM）→ 本地数据，持久化到 IndexedDB
 * - fetch → LLM / OCR（云端 API）
 * - 术语词典 → 注入 LLM 提示词做纠错，并记录到 corrections 表
 */

import initSqlJs, { type Database as SqlJsDb } from 'sql.js'
import { webViewEngineName } from './platform'

// ═══════════════════════════
// API 配置（用户自行填入，存本地 DB）
// ═══════════════════════════

// ═══════════════════════════
// 模型常量（智谱 BigModel 免费档）
// ═══════════════════════════

/** 当前长期免费的文本模型 */
export const DEFAULT_TEXT_MODEL = 'nvidia/nemotron-3.5-super-vl:free'
/** OpenRouter 免费模型 */
export const DEFAULT_VISION_MODEL = 'glm-4.6v-flash'
export const LEGACY_TEXT_MODELS: string[] = []

let _apiKey1 = ''
let _apiKey2 = ''
let _apiBase = 'https://openrouter.ai/api/v1'
let _modelName = DEFAULT_TEXT_MODEL
let _ocrKey = ''
let _ocrModel = DEFAULT_VISION_MODEL

let _asrKey = ''
let _asrBase = 'https://api.siliconflow.cn/v1'
// 轻量混淆：base64 编码，避免 SQLite 直接 SELECT 看到 sk- 明文
// 注：这是混淆不是加密，纯前端无真加密（密钥必在前端），仅防一眼可见
function obscure(s: string): string {
  if (!s) return ''
  try { return btoa(unescape(encodeURIComponent(s))) } catch { return s }
}
function unobscure(s: string): string {
  if (!s) return ''
  try { return decodeURIComponent(escape(atob(s))) } catch { return s }
}

export function getApiConfig() {
  return {
    apiKey1: _apiKey1, apiKey2: _apiKey2,
    apiBase: _apiBase, modelName: _modelName,
    ocrKey: _ocrKey, ocrModel: _ocrModel,
    asrKey: _asrKey, asrBase: _asrBase,
  }
}

export function setApiConfig(c: {
  apiKey1?: string; apiKey2?: string; apiBase?: string; modelName?: string
  ocrKey?: string; ocrModel?: string
  asrKey?: string; asrBase?: string
}) {
  if (c.apiKey1 !== undefined) _apiKey1 = c.apiKey1
  if (c.apiKey2 !== undefined) _apiKey2 = c.apiKey2
  if (c.apiBase !== undefined) _apiBase = c.apiBase
  if (c.modelName !== undefined) _modelName = c.modelName
  if (c.ocrKey !== undefined) _ocrKey = c.ocrKey
  if (c.ocrModel !== undefined) _ocrModel = c.ocrModel
  if (c.asrKey !== undefined) _asrKey = c.asrKey
  if (c.asrBase !== undefined) _asrBase = c.asrBase
  if (dbReady) {
    exec('DELETE FROM settings WHERE key IN (?,?,?,?,?,?,?,?)',
      ['apiKey1','apiKey2','apiBase','modelName','ocrKey','ocrModel','asrKey','asrBase'])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['apiKey1', obscure(_apiKey1)])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['apiKey2', obscure(_apiKey2)])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['apiBase', _apiBase])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['modelName', _modelName])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['ocrKey', obscure(_ocrKey)])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['ocrModel', _ocrModel])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['asrKey', obscure(_asrKey)])
    exec('INSERT INTO settings (key,value) VALUES (?,?)', ['asrBase', _asrBase])
  }
}

// ═══════════════════════════
// IndexedDB 持久化层
// sql.js 是内存库，关 App 即丢；每次写后把 db.export() 存到 IndexedDB
// ═══════════════════════════

const IDB_NAME = 'hermes-memo'
const IDB_STORE = 'kv'
const IDB_KEY = 'sqlite-db'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' &&
           typeof indexedDB.open === 'function' &&
      // Capacitor Android WebView 在某些隐身模式/无痕模式下可能禁用 IDB
      !(navigator as any)?.webkitTransient?.userAgent?.includes?.('private')
  } catch {
    return false
  }
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  if (!idbAvailable()) return null
  const idb = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: Uint8Array): Promise<void> {
  if (!idbAvailable()) return
  const idb = await openIdb()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ═══════════════════════════
// 时间工具
// ═══════════════════════════

/**
 * 本地时间字符串：YYYY-MM-DD HH:mm:ss（展示时取到分）
 *
 * 不要用 toISOString() —— 那是 UTC，中国用户看到的创建时间会早 8 小时。
 */
export function nowStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ═══════════════════════════
// SQLite 初始化
// ═══════════════════════════

let SQL: any
let db: SqlJsDb
let dbReady = false
let persistTimer: any = null

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    if (!db) return
    try {
      const bytes = db.export()
      await idbSet(IDB_KEY, bytes)
    } catch (e) {
      console.error('persist db failed:', e)
    }
  }, 150)
}

async function initDb() {
  if (dbReady) return
  SQL = await initSqlJs({ locateFile: () => './sql-wasm.wasm' })
  // 尝试从 IndexedDB 恢复
  const saved = await idbGet(IDB_KEY)
  if (saved && saved.byteLength > 0) {
    try {
      db = new SQL.Database(saved as Uint8Array)
      // 验证恢复的库是否可用（能执行 SELECT 1 + 有 memos 表）
      db.run('SELECT 1')
      const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memos'")
      const hasMemos = check.step()
      check.free()
      if (!hasMemos) throw new Error('memos table missing')
    } catch (e) {
      console.warn('saved db corrupted, recreating from scratch:', e)
      db = new SQL.Database()
      // 清掉 IndexedDB 里的坏库
      try { await idbSet(IDB_KEY, new Uint8Array(0)) } catch {}
    }
  } else {
    db = new SQL.Database()
  }
  // 建表（用 try/catch 防止旧库 schema 冲突）
  try {
    db.run(`CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT DEFAULT '',
      event TEXT DEFAULT '',
      location TEXT DEFAULT '',
      due_date TEXT DEFAULT '', status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  } catch (e) {
    console.warn('CREATE TABLE memos failed, dropping and recreating:', e)
    try { db.run('DROP TABLE IF EXISTS memos') } catch {}
    db.run(`CREATE TABLE memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT DEFAULT '',
      event TEXT DEFAULT '',
      location TEXT DEFAULT '',
      due_date TEXT DEFAULT '', status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  }
  // 兼容旧库：若没有 event 列则添加
  const cols = queryAll("PRAGMA table_info(memos)").map((r: any) => r.name)
  if (!cols.includes('event')) {
    try { db.run("ALTER TABLE memos ADD COLUMN event TEXT DEFAULT ''") } catch (e) {
      console.warn('ALTER TABLE memos ADD event failed:', e)
    }
  }
  // 兼容旧库：历史 created_at / updated_at 存的是 UTC（早期用 toISOString），
  // 一次性平移到本地时区，只跑一次（localStorage 打标记）
  try {
    const TZ_FLAG = 'hermes.tz_local_fixed'
    if (typeof localStorage !== 'undefined' && !localStorage.getItem(TZ_FLAG)) {
      const offsetMin = -new Date().getTimezoneOffset()
      const pat = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'"
      const count = queryOne('SELECT COUNT(*) AS c FROM memos')?.c || 0
      if (count > 0 && offsetMin !== 0) {
        const shift = `${offsetMin > 0 ? '+' : '-'}${Math.abs(offsetMin)} minutes`
        exec(
          `UPDATE memos SET
             created_at = CASE WHEN created_at GLOB ${pat} THEN datetime(created_at, ?) ELSE created_at END,
             updated_at = CASE WHEN updated_at GLOB ${pat} THEN datetime(updated_at, ?) ELSE updated_at END`,
          [shift, shift]
        )
        console.log(`[engine] 迁移：${count} 条历史时间从 UTC 平移到本地时区`)
      }
      localStorage.setItem(TZ_FLAG, nowStr())
    }
  } catch (e) {
    console.warn('timezone migration failed:', e)
  }
  try {
    db.run(`CREATE TABLE IF NOT EXISTS glossary_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, wrong_term TEXT NOT NULL,
      correct_term TEXT NOT NULL, count INTEGER DEFAULT 1,
      source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now','localtime'))
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
      field_name TEXT NOT NULL, original_value TEXT,
      corrected_value TEXT NOT NULL, context_snippet TEXT,
      source TEXT DEFAULT 'ui', count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS feedback_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original TEXT NOT NULL,
      corrected TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS term_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wrong_term TEXT NOT NULL,
      correct_term TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_used TEXT NOT NULL
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_fc_original ON feedback_corrections(original)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_tc_wrong ON term_corrections(wrong_term)`)
        db.run(`CREATE TABLE IF NOT EXISTS knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL, content TEXT NOT NULL,
          tags TEXT DEFAULT '', linked_memo_id INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`)
        db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`)
  } catch (e) {
    console.warn('CREATE TABLE (aux) failed:', e)
  }
  // 加载已保存的 API Key（解混淆）
  const rows = queryAll('SELECT key, value FROM settings')
  rows.forEach((r: any) => {
    if (r.key === 'apiKey1') _apiKey1 = unobscure(r.value)
    else if (r.key === 'apiKey2') _apiKey2 = unobscure(r.value)
    else if (r.key === 'apiBase') _apiBase = r.value
    else if (r.key === 'modelName') _modelName = r.value
    else if (r.key === 'ocrKey') _ocrKey = unobscure(r.value)
    else if (r.key === 'ocrModel') _ocrModel = r.value
    else if (r.key === 'asrKey') _asrKey = unobscure(r.value)
    else if (r.key === 'asrBase') _asrBase = r.value
      })
      // 自动迁移：已下线的旧模型 → 当前默认模型
      if (LEGACY_TEXT_MODELS.includes(_modelName)) {
        _modelName = DEFAULT_TEXT_MODEL
        exec('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['modelName', _modelName])
        schedulePersist()
      }
      dbReady = true
  // 首次恢复后也持久化一次（建表后的 schema）
  schedulePersist()
}

function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql)
  if (!stmt) {
    console.error('queryAll: prepare returned null for SQL:', sql.slice(0, 100))
    return []
  }
  if (params.length) stmt.bind(params)
  const cols = stmt.getColumnNames()
  const rows: any[] = []
  while (stmt.step()) {
    const vals = stmt.get()
    const row: any = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    rows.push(row)
  }
  stmt.free()
  return rows
}

function queryOne(sql: string, params: any[] = []): any | null {
  const rows = queryAll(sql, params)
  return rows[0] || null
}

function exec(sql: string, params: any[] = []) {
  db.run(sql, params)
  schedulePersist()
}

// ═══════════════════════════
// 备忘录 CRUD
// ═══════════════════════════

/**
 * 初始化本地库并恢复已保存的配置。
 *
 * ⚠️ App 启动时必须先 `await initEngine()` 再 `getApiConfig()`：
 * initDb 之前模块里的 _apiKey1 等还是空串，此时读配置会拿到空值，
 * 而把这个空值 setApiConfig / 同步给 Node 就会覆盖掉已保存的配置
 * （表现为"关掉 App 再打开，设置里的 Key 没了"）。
 */
export async function initEngine() {
  await initDb()
}

export async function fetchMemos(params?: Record<string, string>) {
  await initDb()
  try {
    let where = ' WHERE 1=1'
    const vals: any[] = []
    if (params?.status && params.status !== 'all') { where += ' AND status=?'; vals.push(params.status) }
    if (params?.location) { where += ' AND location LIKE ?'; vals.push('%'+params.location+'%') }
    if (params?.tag) { where += ' AND tags LIKE ?'; vals.push('%'+params.tag+'%') }
    if (params?.due_after) { where += ' AND due_date >= ?'; vals.push(params.due_after) }
    if (params?.due_before) { where += ' AND due_date <= ? AND due_date <> ?'; vals.push(params.due_before, '') }
    const limit = Number(params?.limit) || 50
    const items = queryAll(
      'SELECT * FROM memos' + where + ' ORDER BY created_at DESC LIMIT ?',
      [...vals, limit]
    )
    // total 用同一套筛选条件，避免"显示 20 条却说共 100 条"
    const total = queryOne('SELECT COUNT(*) as c FROM memos' + where, vals)?.c || 0
    return { items, total }
  } catch (e) {
    console.error('fetchMemos error:', e)
    return { items: [], total: 0 }
  }
}

/**
 * 全文搜索（FTS5 降级方案：JS 倒排索引）
 * 对 title + content 分词后做 OR 匹配，按命中数倒序
 */
export async function searchMemos(query: string, params?: Record<string, string>) {
  await initDb()
  const q = (query || '').trim().toLowerCase()
  if (!q) return { items: [], total: 0 }

  // 分词：中文按字符拆，英文按空格拆，统一小写
  const tokens = new Set<string>()
  for (const raw of q.split(/[\s,，。！？、]+/)) {
    if (!raw) continue
    if (/^[a-z0-9]+$/i.test(raw)) {
      tokens.add(raw.toLowerCase())
    } else {
      // 中文：拆成 2-gram
      for (let i = 0; i < raw.length - 1; i++) tokens.add(raw.substring(i, i + 2))
      tokens.add(raw)
    }
  }

  // 与 fetchMemos 保持一致：状态 / 地点 / 标签 都要参与筛选，
  // 否则搜索会绕过筛选条件（选了"已完成"却把活跃的也搜出来）
  let sql = 'SELECT * FROM memos WHERE 1=1'
  const vals: any[] = []
  if (params?.status && params.status !== 'all') { sql += ' AND status=?'; vals.push(params.status) }
  if (params?.location) { sql += ' AND location LIKE ?'; vals.push('%' + params.location + '%') }
  if (params?.tag) { sql += ' AND tags LIKE ?'; vals.push('%' + params.tag + '%') }
  const all = queryAll(sql, vals)

  const scored = all.map((m: any) => {
    const text = ((m.title || '') + ' ' + (m.content || '') + ' ' + (m.tags || '') + ' ' + (m.event || '')).toLowerCase()
    let score = 0
    tokens.forEach((t) => { if (text.includes(t)) score++ })
    return { m, score }
  }).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score)

  const limit = Number(params?.limit) || 50
  const items = scored.slice(0, limit).map((x: any) => x.m)
  return { items, total: scored.length }
}

export async function saveMemo(data: { title: string; content: string; tags?: string[]; location?: string; due_date?: string; event?: string }) {
  await initDb()
  const now = nowStr()
  exec('INSERT INTO memos (title,content,tags,event,location,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [data.title, data.content, (data.tags||[]).join(','), data.event||'', data.location||'', data.due_date||'', now, now])
  return { success: true }
}

export async function updateMemoStatus(id: number, status: string) {
  await initDb()
  const now = nowStr()
  exec('UPDATE memos SET status=?, updated_at=? WHERE id=?', [status, now, id])
  return { success: true }
}

export async function deleteMemo(id: number) {
  await initDb()
  exec('DELETE FROM memos WHERE id=?', [id])
  return { success: true }
}

// ═══════════════════════════
// 草稿管线（LLM + 术语词典纠错）
// ═══════════════════════════

export interface DraftResult {
  draft: {
    title: string; content: string
    event: string
    tags: string[]
    location: string; due_date: string
    /** 引擎根据历史推断，非用户明确提供 */
    inferred_location?: string
    inferred_due_date?: string
    /** 自定义 schema 可能带出的额外字段 */
    [key: string]: any
  }
  rawText: string        // 用户原始输入
  correctedText: string  // 词典 + 反馈学习纠错后的文本
  corrections: { from: string; to: string }[]
  /** LLM 是否真的参与了结构化（false = 降级为原文草稿） */
  llmUsed?: boolean
  /** 是否走了 response_format=json_object（排查网关兼容性用） */
  jsonMode?: boolean
  /** 降级原因，供 UI 提示与排查 */
  llmError?: string
  /** 三要素里仍然缺失的（如 ['时间','地点']） */
  missingKeyFields?: string[]
  /** 模型漏输出的字段名 */
  missingFields?: string[]
}

// 通用 fetch + 超时（AbortController），返回 {ok, status, data}
// 弱网下避免无限 loading
const LLM_TIMEOUT_MS = 30_000
const OCR_TIMEOUT_MS = 60_000  // 视觉模型较慢
// 智谱免费档并发约 1，429 很常见；指数退避 + 抖动能显著降低失败率
const LLM_MAX_RETRIES = 2

function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 带退避重试的 LLM 请求：仅对 429/408/5xx 重试，指数退避 + 随机抖动 */
async function fetchLLMWithRetry(
  url: string,
  options: RequestInit,
  attempt = 0
): Promise<Response> {
  const resp = await fetchWithTimeout(url, options, LLM_TIMEOUT_MS)
  if (!isRetriableStatus(resp.status) || attempt >= LLM_MAX_RETRIES) return resp
  const delay = Math.round(600 * 2 ** attempt * (0.5 + Math.random()))
  console.warn(`LLM ${resp.status}，${delay}ms 后重试（${attempt + 1}/${LLM_MAX_RETRIES}）`)
  await new Promise((r) => setTimeout(r, delay))
  return fetchLLMWithRetry(url, options, attempt + 1)
}

async function callLLM(systemPrompt: string, userText: string, jsonMode = false): Promise<any> {
  const key = _apiKey1 || _apiKey2
  if (!key) {
    console.warn('LLM call skipped: no API key configured')
    return null
  }
  try {
    const body: Record<string, any> = {
      model: _modelName,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }],
      temperature: 0,
    }
    // 强制结构化输出：智谱 v4 兼容 OpenAI 的 response_format
    if (jsonMode) body.response_format = { type: 'json_object' }
    const resp = await fetchLLMWithRetry(_apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      console.error('LLM API error:', resp.status, errText)
      // 把错误信息透传给调用方（App.vue 会 catch 并显示给用户）
      const err: any = new Error(`LLM API ${resp.status}: ${errText.slice(0, 200)}`)
      err.apiError = true
      throw err
    }
    const data = await resp.json()
    // 智谱 API 可能返回 error 字段（如模型限流）
    if (data?.error) {
      const errMsg = data.error.message || JSON.stringify(data.error)
      console.error('LLM API returned error:', errMsg)
      const err: any = new Error(`模型错误: ${errMsg}`)
      err.apiError = true
      throw err
    }
    const raw = data?.choices?.[0]?.message?.content || ''
    // 剥离 ```json``` / ``` 代码块包裹，再 trim
    const stripped = raw
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```\s*$/g, '')
      .trim()
    try { return JSON.parse(stripped) } catch {
      console.error('LLM response not JSON:', raw)
      return null
    }
  } catch (e: any) {
    if (e?.apiError) throw e  // 透传 API 错误
    if (e?.name === 'AbortError') {
      console.error('LLM call timeout after', LLM_TIMEOUT_MS, 'ms')
      throw new Error('LLM 请求超时（30s）')
    }
    console.error('LLM call failed:', e)
    throw new Error('网络错误: ' + (e?.message || String(e)))
  }
}

export async function createDraft(originalText: string): Promise<DraftResult> {
  await initDb()

  // 1. 取术语词典（长词优先，避免"G代码"的"G"先被替换）
  const glossary = queryAll('SELECT wrong_term, correct_term FROM glossary_terms ORDER BY LENGTH(wrong_term) DESC, count DESC')

  // 2. 在原文本上应用术语纠错，记录变更 + 计数自增
  let textAfterGlossary = originalText
  const glossaryFixes: { from: string; to: string }[] = []
  if (glossary.length) {
    glossary.forEach((g: any) => {
      if (g.wrong_term && textAfterGlossary.includes(g.wrong_term)) {
        textAfterGlossary = textAfterGlossary.split(g.wrong_term).join(g.correct_term)
        glossaryFixes.push({ from: g.wrong_term, to: g.correct_term })
        // 计数自增
        exec('UPDATE glossary_terms SET count = count + 1 WHERE wrong_term = ? AND correct_term = ?',
          [g.wrong_term, g.correct_term])
        // 写入 corrections 表（保留现场）
        exec(
          'INSERT INTO corrections (session_id, field_name, original_value, corrected_value, context_snippet, source) VALUES (?,?,?,?,?,?)',
          ['draft-' + Date.now(), 'text', g.wrong_term, g.correct_term, originalText.slice(0, 100), 'glossary']
        )
      }
    })
  }

  // 3. 反馈学习修正（基于用户历史修改记录）
  const { corrected: correctedText, fixes: feedbackFixes } = applyFeedback(textAfterGlossary)
  const corrections = [...glossaryFixes, ...feedbackFixes]

  // 4. 构造系统提示词，把词典作为额外约束告知 LLM
  let glossaryHint = ''
  if (glossary.length) {
    glossaryHint = '\n\n术语词典（后续输入请严格使用右侧正确词）：\n'
    glossary.forEach((g: any) => { glossaryHint += `- "${g.wrong_term}" → "${g.correct_term}"\n` })
  }

  // 注入 MEMORY.md / USER.md（持久记忆 + 用户画像）
  let memoryHint = ''
  const memMd = queryOne("SELECT value FROM settings WHERE key='memory_md'")?.value || ''
  const userMd = queryOne("SELECT value FROM settings WHERE key='user_md'")?.value || ''
  if (userMd.trim()) memoryHint += `\n\n[用户画像]\n${userMd.trim()}`
  if (memMd.trim()) memoryHint += `\n\n[持久记忆]\n${memMd.trim()}`

  // 当前时间：模型不知道"今天"是哪天，"明天/下周五"只能瞎猜，必须注入
  // （否则会照抄 prompt 里写死的示例日期，表现为时间永远不对）
  const nowDate = new Date()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const weekName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowDate.getDay()]
  const nowText = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())} ${weekName} ${pad2(nowDate.getHours())}:${pad2(nowDate.getMinutes())}`
  const tomorrow = new Date(nowDate)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrow15 = `${tomorrow.getFullYear()}-${pad2(tomorrow.getMonth() + 1)}-${pad2(tomorrow.getDate())} 15:00`

  const system = `你是备忘录草稿解析器。把用户的自然语言输入转成结构化 JSON。

当前时间：${nowText}
（务必以此为基准换算"明天""下周五"等相对时间，不要照抄示例里的日期）

## 输出字段
- title (字符串): 简短中文标题（≤20字）
- event (字符串): 任务/事件，动宾短语（开会 / 买牛奶 / 交报销 / 体检），不要写成整句
- due_date (字符串): 绝对时间 YYYY-MM-DD HH:mm；只有日期填 YYYY-MM-DD 00:00；无时间线索填 ""
- location (字符串): 地点（公司 / 302会议室 / 超市 / 医院），无线索填 ""
- content (字符串): 整理后的完整正文
- tags (字符串数组): 2-5 个中文标签

## 规则
1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。
2. 字段必须齐全：title、event、due_date、location、content、tags。无法确定的填 ""，数组填 []，禁止省略字段。
3. 不要编造输入中没有的时间、地点、人名。
4. 相对时间换算成绝对时间。

## 示例
输入：明天下午3点去公司302开会讨论预算
输出：{"title":"公司开会","event":"开会","due_date":"${tomorrow15}","location":"公司 302 会议室","content":"明天下午3点去公司302会议室开会，讨论下季度预算","tags":["工作","会议"]}
输入：记得买牛奶
输出：{"title":"买牛奶","event":"买牛奶","due_date":"","location":"","content":"记得买牛奶","tags":["购物"]}${glossaryHint}${memoryHint}`

  // 结构化输出：先强制 json_object，失败再退回普通模式（部分网关不支持 response_format）
  let rawDraft: any = null
  let llmError = ''
  if (!_apiKey1 && !_apiKey2) llmError = '未配置 API Key'
  else {
    for (const jsonMode of [true, false]) {
      try {
        rawDraft = await callLLM(system, `解析这段输入：\n${correctedText}`, jsonMode)
        if (rawDraft) break
        llmError = `${jsonMode ? 'json_object' : '普通'}模式返回无法解析为 JSON`
      } catch (e: any) {
        llmError = `${jsonMode ? 'json_object' : '普通'}模式调用失败: ${e?.message || String(e)}`
      }
    }
  }

  const llmUsed = !!rawDraft
  const draft: any = rawDraft || {
    title: correctedText.slice(0, 30),
    content: correctedText,
    event: correctedText.slice(0, 20),
    location: '',
    due_date: '',
    tags: [],
  }
  if (!draft.event) draft.event = draft.title || correctedText.slice(0, 20)
  if (!draft.location) draft.location = ''
  if (!draft.due_date) draft.due_date = ''
  if (!Array.isArray(draft.tags)) draft.tags = []

  // 5. 智能推断：从历史相似备忘补全缺省 location/due_date
  const enriched = inferContext(draft)

  const missingKeyFields: string[] = []
  if (!enriched.event) missingKeyFields.push('任务')
  if (!enriched.due_date) missingKeyFields.push('时间')
  if (!enriched.location) missingKeyFields.push('地点')

  return {
    draft: enriched,
    rawText: originalText,
    correctedText,
    corrections,
    llmUsed,
    llmError: llmUsed ? '' : llmError,
    missingKeyFields,
  }
}

export async function reviseDraft(originalText: string, newText: string): Promise<DraftResult> {
  // 记录用户修改对到 feedback-learner
  recordFeedback(originalText, newText)
  return createDraft(newText)
}

export async function confirmDraft(d: DraftResult) {
  await initDb()
  const now = nowStr()
  exec(
    'INSERT INTO memos (title,content,tags,event,location,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [
      d.draft.title,
      d.draft.content,
      (d.draft.tags || []).join(','),
      d.draft.event || '',
      d.draft.location || '',
      d.draft.due_date || '',
      now,
      now,
    ]
  )
  return { success: true }
}

// ═══════════════════════════
// OCR（智谱免费模型）
// ═══════════════════════════

export async function ocrRecognize(file: File): Promise<{ text: string; confidence: number }> {
  if (!_ocrKey) {
    throw new Error('未配置 OCR API Key，请到「设置」中填写')
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

  let resp: Response
  try {
    resp = await fetchWithTimeout('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _ocrKey },
      body: JSON.stringify({
        model: _ocrModel,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: '请识别图片中的所有文字，直接返回文字内容，不要加任何解释。' },
        ] }],
        max_tokens: 1024, temperature: 0,
      }),
    }, OCR_TIMEOUT_MS)
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('OCR 请求超时（60s），请检查网络或缩小图片')
    throw new Error('OCR 网络请求失败: ' + (e?.message || String(e)))
  }
  if (!resp.ok) {
    throw new Error('OCR API 返回 ' + resp.status)
  }
  const data = await resp.json()
  const text = data?.choices?.[0]?.message?.content?.trim() || ''
  return { text, confidence: 0.9 }
}

// ═══════════════════════════
// 语音转文字（ASR）
// ═══════════════════════════

/** Groq 免费语音转写模型（Whisper Large V3 Turbo，216x 实时速度，2000次/天免费） */
export const DEFAULT_ASR_MODEL = 'whisper-large-v3-turbo'
export const DEFAULT_ASR_BASE = 'https://api.groq.com/openai/v1'

const ASR_TIMEOUT_MS = 60_000

/**
 * 录音 Blob → 16kHz 单声道 16bit WAV。
 *
 * 为什么必须转码：MediaRecorder 在 Android WebView 上只会输出 webm/opus，
 * 而智谱 ASR 对这个容器返回 `400 1214 transcriptions不支持当前文件格式`。
 * 用 Web Audio 解码后重采样成标准 PCM WAV，服务端 100% 能认。
 */
async function blobToWav16k(blob: Blob): Promise<Blob> {
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!Ctx) throw new Error('当前环境不支持音频解码')

  const ctx = new Ctx()
  try {
    const raw = await blob.arrayBuffer()
    // 同时兼容 Promise 版和回调版 decodeAudioData
    const audio: AudioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const maybe = ctx.decodeAudioData(raw.slice(0), resolve, reject)
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject)
    })

    // 混成单声道
    const channels = audio.numberOfChannels
    const len = audio.length
    const mono = new Float32Array(len)
    for (let c = 0; c < channels; c++) {
      const data = audio.getChannelData(c)
      for (let i = 0; i < len; i++) mono[i] += data[i] / channels
    }

    // 线性插值重采样到 16k
    const targetRate = 16000
    const ratio = audio.sampleRate / targetRate
    const outLen = Math.max(1, Math.floor(len / ratio))
    const pcm = new Int16Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, len - 1)
      const frac = pos - i0
      const v = mono[i0] * (1 - frac) + mono[i1] * frac
      pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
    }

    return new Blob([wavHeader(pcm.byteLength, targetRate), pcm.buffer as ArrayBuffer], { type: 'audio/wav' })
  } finally {
    try { await ctx.close() } catch {}
  }
}

/** 44 字节标准 WAV 头 */
function wavHeader(dataBytes: number, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44)
  const v = new DataView(buf)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)      // fmt chunk 长度
  v.setUint16(20, 1, true)       // PCM
  v.setUint16(22, 1, true)       // 单声道
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)  // byteRate
  v.setUint16(32, 2, true)       // blockAlign
  v.setUint16(34, 16, true)      // 位深
  writeStr(36, 'data')
  v.setUint32(40, dataBytes, true)
  return buf
}

/**
 * 录音 Blob → 文字。
 *
 * 注意：Android WebView 里没有 webkitSpeechRecognition（那是 Chrome 浏览器
 * 独有的），所以语音必须走"WebView 录音 + 云端转写"。
 *
 * 准确率的关键不是换个更强的模型，而是官方支持但默认不生效的两个参数：
 *   hotwords  热词表（≤100 个）—— 专有名词、人名、业务词靠它
 *   prompt    上下文（<8000 字）—— 告诉模型"这是口语备忘，照原话转写"
 * 所以这里会把用户的术语词典 + 内置业务词一起塞进 hotwords。
 */

/** 内置业务热词：口语高频、通用模型容易写错/写别字的词 */
const BASE_ASR_HOTWORDS = [
  '仓库', '库房', '巡检', '值班', '交班', '报销', '采购', '盘点', '验收',
  '整改', '台账', '备件', '手套', '口罩', '工具', '会议室', '审批', '工单',
]

/**
 * 上下文提示。
 * 只给场景和风格约束，不给示例句子——给了示例模型可能把示例当成转录内容复读。
 */
const ASR_CONTEXT =
  '这是一段中文口语备忘，句中会出现时间、地点、任务、人名，也可能夹杂仓库、巡检、报销等业务词。'
  + '请按原话逐字转写，保留说话人的用词，不要改写、不要概括、不要补充标点以外的内容。'

export interface TranscribeOptions {
  /** 用户术语词典里的正确词，会排在内置词前面（越靠前权重越高） */
  hotwords?: string[]
}

/** 组装热词表：用户词优先，去重，最多 100 个 */
function buildAsrHotwords(extra?: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (w?: string) => {
    const v = (w || '').trim().replace(/[，,、\s]+/g, '')
    if (!v || v.length > 20) return
    if (seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  for (const w of extra || []) push(w)
  for (const w of BASE_ASR_HOTWORDS) push(w)
  return out.slice(0, 100)
}

export async function transcribeAudio(blob: Blob, opts: TranscribeOptions = {}): Promise<{ text: string }> {
  const key = _asrKey || _ocrKey || _apiKey1 || _apiKey2
  if (!key) {
    throw new Error('未配置 API Key，请到「设置」中填写')
  }
  if (!blob || !blob.size) {
    throw new Error('录音为空，请重试')
  }

  // 智谱 ASR 只认 .wav / .mp3，其余容器一律本地转码
  let upload = blob
  let ext = 'wav'
  const srcType = blob.type || ''
  if (!srcType.includes('wav')) {
    try {
      upload = await blobToWav16k(blob)
    } catch (e: any) {
      // mp3 可以直接传；webm/m4a/ogg 传上去必然 1214「不支持当前文件格式」，
      // 与其让用户看到一个看不懂的服务端报错，不如把真实原因说清楚
      if (srcType.includes('mpeg') || srcType.includes('mp3')) {
        upload = blob
        ext = 'mp3'
      } else {
        console.warn('[asr] 转 WAV 失败:', e?.message)
        throw new Error(
          '录音转码失败：当前 WebView 无法解码 ' + (srcType || '音频')
          + '。请更新系统「' + webViewEngineName() + '」后重试'
        )
      }
    }
  }

  const hotwords = buildAsrHotwords(opts.hotwords)

  // 官方文档把 hotwords 声明为 string[]，但 multipart 里数组的序列化方式没给示例：
  // 有的网关吃 JSON 字符串，有的要重复同名字段。按 json → repeat → 不带 逐级降级，
  // 只有前一种被服务端拒绝（400/422 且报的是参数问题）才会往下走。
  type HintMode = 'json' | 'repeat' | 'none'

  const attempt = async (mode: HintMode) => {
    const fd = new FormData()
    fd.append('model', DEFAULT_ASR_MODEL)
    fd.append('stream', 'false')
    fd.append('file', upload, `voice.${ext}`)
    if (mode === 'json') {
      if (hotwords.length) fd.append('hotwords', JSON.stringify(hotwords))
      fd.append('prompt', ASR_CONTEXT)
    } else if (mode === 'repeat') {
      hotwords.forEach((w) => fd.append('hotwords', w))
      fd.append('prompt', ASR_CONTEXT)
    }

    let resp: Response
    try {
      resp = await fetchWithTimeout(`${_asrBase}/audio/transcriptions`, {
        method: 'POST',
        // 不要手写 Content-Type：必须让浏览器自动带 multipart boundary
        headers: { Authorization: 'Bearer ' + key },
        body: fd,
      }, ASR_TIMEOUT_MS)
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('语音识别超时（60s），请重试')
      throw new Error('语音识别网络请求失败: ' + (e?.message || String(e)))
    }

    const detail = resp.ok ? '' : await resp.text().catch(() => '')
    return { resp, detail }
  }

  const looksLikeParamError = (s: string) =>
    /hotword|prompt|unknown field|unexpected field|invalid (param|field|argument)|参数/i.test(s)

  let { resp, detail } = await attempt('json')
  if (!resp.ok && (resp.status === 400 || resp.status === 422) && looksLikeParamError(detail)) {
    console.warn('[asr] hotwords 用 JSON 形式被拒，改重复字段重试:', detail.slice(0, 120))
    ;({ resp, detail } = await attempt('repeat'))
    if (!resp.ok && (resp.status === 400 || resp.status === 422) && looksLikeParamError(detail)) {
      console.warn('[asr] hotwords/prompt 均不被接受，去掉后重试:', detail.slice(0, 120))
      ;({ resp, detail } = await attempt('none'))
    }
  }

  if (!resp.ok) {
    const hint = resp.status === 401 ? '（API Key 无效或未实名认证）'
      : resp.status === 413 ? '（录音超过 25MB）'
      : resp.status === 429 ? '（免费额度限流，稍后重试）'
      : resp.status === 400 && detail.includes('1214') ? '（音频格式不被接受，已尝试转 WAV）'
      : ''
    throw new Error(`语音识别失败 ${resp.status}${hint}${detail ? '：' + detail.slice(0, 160) : ''}`)
  }

  const data = await resp.json().catch(() => null)
  const text = (data?.text || data?.result?.text || data?.data?.text || '').trim()
  return { text }
}

// ═══════════════════════════
// 术语词典
// ═══════════════════════════

export async function fetchGlossary() {
  await initDb()
  const terms = queryAll('SELECT * FROM glossary_terms ORDER BY count DESC')
  return { terms }
}

export async function addGlossary(wrong_term: string, correct_term: string) {
  await initDb()
  // 去重：已有则自增 count
  const existing = queryOne('SELECT id, count FROM glossary_terms WHERE wrong_term=? AND correct_term=?', [wrong_term, correct_term])
  if (existing) {
    exec('UPDATE glossary_terms SET count=? WHERE id=?', [existing.count + 1, existing.id])
  } else {
    exec('INSERT INTO glossary_terms (wrong_term,correct_term,count) VALUES (?,?,1)', [wrong_term, correct_term])
  }
  return { success: true }
}

export async function removeGlossary(id: number) {
  await initDb()
  exec('DELETE FROM glossary_terms WHERE id=?', [id])
  return { success: true }
}

// ═══════════════════════════
// Feedback Learner：用户修改文本 → 记录修正对 → 下次类似输入自动应用
// 时效衰减：最近 30 天权重大，>30 天的 term 仍生效但精确匹配优先级降低
// ═══════════════════════════

/** 应用反馈学习：先查精确原文匹配，再分词查高频错误术语 */
function applyFeedback(text: string): { corrected: string; fixes: { from: string; to: string }[] } {
  let result = text
  const fixes: { from: string; to: string }[] = []
  const now = nowStr()
  const cutoff30 = nowStr(new Date(Date.now() - 30 * 24 * 3600 * 1000))

  // 1. 精确匹配：原文 → 修正文本（最近 30 天优先）
  const exact = queryAll(
    `SELECT original, corrected FROM feedback_corrections
     WHERE original = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`,
    [text, cutoff30]
  )
  if (exact.length === 0) {
    // 30 天外仍可用，但优先级降低
    const exactOld = queryAll(
      'SELECT original, corrected FROM feedback_corrections WHERE original = ? ORDER BY created_at DESC LIMIT 1',
      [text]
    )
    if (exactOld.length && exactOld[0].original !== exactOld[0].corrected) {
      const c = exactOld[0].corrected
      if (c && c !== text) {
        fixes.push({ from: text, to: c })
        result = c
      }
    }
  } else if (exact[0].original !== exact[0].corrected) {
    const c = exact[0].corrected
    if (c && c !== text) {
      fixes.push({ from: text, to: c })
      result = c
    }
  }

  // 2. 分词匹配高频错误术语（最近 30 天 count>=2 才应用）
  const terms = queryAll(
    `SELECT wrong_term, correct_term FROM term_corrections
     WHERE last_used >= ? OR count >= 2
     ORDER BY count DESC`
    , [cutoff30]
  )
  for (const t of terms) {
    if (t.wrong_term && result.includes(t.wrong_term)) {
      result = result.split(t.wrong_term).join(t.correct_term)
      fixes.push({ from: t.wrong_term, to: t.correct_term })
      exec('UPDATE term_corrections SET count=count+1, last_used=? WHERE wrong_term=? AND correct_term=?',
        [now, t.wrong_term, t.correct_term])
    }
  }

  return { corrected: result, fixes }
}

/** 记录用户修改：原文 → 修正文本。同时拆分到 term_corrections 子表 */
function recordFeedback(original: string, corrected: string) {
  if (!original || !corrected || original === corrected) return
  const now = nowStr()
  exec('INSERT INTO feedback_corrections (original,corrected,source,created_at) VALUES (?,?,?,?)',
    [original, corrected, 'manual', now])

  // 把修正文本里的差异片段抽出来作为 term_corrections
  // 简化策略：原词若短（≤8），整段当 wrong_term；否则跳过
  if (original.length <= 8) {
    const existing = queryOne(
      'SELECT id, count FROM term_corrections WHERE wrong_term=? AND correct_term=?',
      [original, corrected]
    )
    if (existing) {
      exec('UPDATE term_corrections SET count=count+1, last_used=? WHERE id=?', [now, existing.id])
    } else {
      exec('INSERT INTO term_corrections (wrong_term,correct_term,count,last_used) VALUES (?,?,1,?)',
        [original, corrected, now])
    }
  }
}

// ═══════════════════════════
// 智能推断：从历史相似备忘中补全缺省字段（location / due_date）
// ═══════════════════════════

function inferContext(draft: any): any {
  const result = { ...draft }
  const text = ((draft.title || '') + ' ' + (draft.content || '') + ' ' + (draft.event || '')).toLowerCase()
  // 中文拆 2-gram
  const words: string[] = []
  for (const raw of text.split(/[\s,，。！？、]+/)) {
    if (!raw) continue
    if (raw.length >= 2) {
      for (let i = 0; i < raw.length - 1; i++) words.push(raw.substring(i, i + 2))
    }
  }
  if (words.length === 0) return result

  // 从最近 100 条历史里找相似
  const allPast = queryAll('SELECT * FROM memos ORDER BY created_at DESC LIMIT 100')
  if (allPast.length === 0) return result

  // 每个历史项算命中数
  const scored: any[] = []
  for (const m of allPast) {
    const mText = ((m.title || '') + ' ' + (m.content || '') + ' ' + (m.event || '')).toLowerCase()
    let hit = 0
    for (const w of words) if (mText.includes(w)) hit++
    if (hit > 0) scored.push({ m, hit })
  }
  if (scored.length === 0) return result

  // 取前 5 个最相似项统计
  scored.sort((a, b) => b.hit - a.hit)
  const top = scored.slice(0, 5)

  // 推断 location：出现 ≥2 次的最常见 location
  if (!result.location) {
    const locs = top.map((x: any) => x.m.location).filter(Boolean)
    if (locs.length >= 2) {
      const count: Record<string, number> = {}
      locs.forEach((l: string) => { count[l] = (count[l] || 0) + 1 })
      const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0]
      if (best[1] >= 2) result.inferred_location = best[0]
    }
  }

  // 推断 due_date：所有 Top 历史都相同时间才推断
  if (!result.due_date) {
    const times = top.map((x: any) => x.m.due_date).filter(Boolean)
    if (times.length >= 3 && times.every((t: string) => t === times[0])) {
      result.inferred_due_date = times[0]
    }
  }

  return result
}

// ═══════════════════════════
// Skill / Memory / User Profile 管理（轻量本地版）
// ═══════════════════════════

// settings 表里存 MEMORY.md / USER.md 内容
export async function getMemoryProfile() {
  await initDb()
  const memory = queryOne("SELECT value FROM settings WHERE key='memory_md'")?.value || ''
  const user = queryOne("SELECT value FROM settings WHERE key='user_md'")?.value || ''
  return { memory, user }
}

export async function setMemoryProfile(memory: string, user: string) {
  await initDb()
  exec("DELETE FROM settings WHERE key IN ('memory_md','user_md')")
  exec("INSERT INTO settings (key,value) VALUES ('memory_md',?)", [memory])
  exec("INSERT INTO settings (key,value) VALUES ('user_md',?)", [user])
  return { success: true }
}

// Skills 表：每个 skill 是一行 markdown
export async function listSkills() {
  await initDb()
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`)
  schedulePersist()
  return { skills: queryAll('SELECT * FROM skills ORDER BY updated_at DESC') }
}

export async function getSkill(name: string) {
  await initDb()
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`)
  schedulePersist()
  return queryOne('SELECT * FROM skills WHERE name=?', [name])
}

export async function saveSkill(name: string, content: string) {
  await initDb()
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`)
  const now = nowStr()
  const existing = queryOne('SELECT id FROM skills WHERE name=?', [name])
  if (existing) {
    exec('UPDATE skills SET content=?, updated_at=? WHERE id=?', [content, now, existing.id])
  } else {
    exec('INSERT INTO skills (name,content,created_at,updated_at) VALUES (?,?,?,?)', [name, content, now, now])
  }
  return { success: true }
}

export async function deleteSkill(name: string) {
  await initDb()
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`)
  schedulePersist()
  exec('DELETE FROM skills WHERE name=?', [name])
  return { success: true }
}

// ═══════════════════════════
// 导出
// ═══════════════════════════

/**
 * 导出备忘录 + 词典为 JSON 文件并触发浏览器下载。
 * @param scope       'all'（保留兼容，目前只有全部）
 * @param includeDone 是否包含 status='done' 的备忘录
 * @returns { success, count }
 */
export async function doExport(scope: 'all' = 'all', includeDone = true) {
  await initDb()
  let memos = queryAll('SELECT * FROM memos ORDER BY created_at DESC')
  if (!includeDone) memos = memos.filter((m: any) => m.status !== 'done')
  const glossary = queryAll('SELECT * FROM glossary_terms ORDER BY count DESC')
  const feedback = queryAll('SELECT * FROM feedback_corrections ORDER BY created_at DESC')
  const termCorrections = queryAll('SELECT * FROM term_corrections ORDER BY count DESC')
  const memory = queryOne("SELECT value FROM settings WHERE key='memory_md'")?.value || ''
  const user = queryOne("SELECT value FROM settings WHERE key='user_md'")?.value || ''
  // 确保 skills 表存在
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`)
  const skills = queryAll('SELECT * FROM skills ORDER BY updated_at DESC')
  const payload = {
    scope,
    include_done: includeDone,
    memos,
    glossary,
    feedback,
    term_corrections: termCorrections,
    memory_md: memory,
    user_md: user,
    skills,
    exported_at: new Date().toISOString(),
  }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  a.href = url
  a.download = `memo-export-${stamp}.json`
  a.click()
    URL.revokeObjectURL(url)
    return { success: true, count: memos.length }
  }

  /** 导出数据为 JSON（浏览器侧） */
  export async function exportData(opts: {
    memos?: boolean; includeDone?: boolean
    glossary?: boolean; skills?: boolean; knowledge?: boolean
    memory?: boolean; config?: boolean
  } = {}) {
    await initDb()
    const result: any = { exported_at: new Date().toISOString() }

    if (opts.memos !== false) {
      let memos = queryAll('SELECT * FROM memos ORDER BY created_at DESC')
      if (!opts.includeDone) memos = memos.filter((m: any) => m.status !== 'done')
      result.memos = memos
    }
    if (opts.glossary !== false) result.glossary = queryAll('SELECT * FROM glossary_terms ORDER BY count DESC')
    if (opts.knowledge !== false) result.knowledge = (await fetchKnowledge())
    if (opts.skills !== false) result.skills = queryAll('SELECT * FROM skills ORDER BY updated_at DESC')
    if (opts.memory !== false) {
      result.memory_md = queryOne("SELECT value FROM settings WHERE key='memory_md'")?.value || ''
      result.user_md = queryOne("SELECT value FROM settings WHERE key='user_md'")?.value || ''
    }
    if (opts.config !== false) {
      result.config = { model: _modelName, baseURL: _apiBase }
    }
    return result
  }

  /** 导入 JSON 数据（浏览器侧） */
  export async function importData(json: any) {
    await initDb()
    let imported = 0, skipped = 0
    if (json.memos?.length) {
      for (const m of json.memos) {
        try { saveMemoInner(m); imported++ } catch { skipped++ }
      }
    }
    if (json.glossary?.length) {
      for (const g of json.glossary) {
        try { addGlossaryInner(g.wrong_term || g.wrong, g.correct_term || g.correct) } catch {}
      }
    }
    if (json.memory_md || json.user_md) {
      exec("INSERT OR REPLACE INTO settings (key,value) VALUES ('memory_md',?)", [json.memory_md || ''])
      exec("INSERT OR REPLACE INTO settings (key,value) VALUES ('user_md',?)", [json.user_md || ''])
      schedulePersist()
    }
    if (json.skills?.length) {
      exec('CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)')
      for (const s of json.skills) {
        try { exec("INSERT OR REPLACE INTO skills (name,content,created_at,updated_at) VALUES (?,?,?,?)", [s.name, s.content, nowStr(), nowStr()]) } catch {}
      }
    }
    if (json.config) {
      if (json.config.model) exec("INSERT OR REPLACE INTO settings (key,value) VALUES ('modelName',?)", [json.config.model])
      if (json.config.baseURL) exec("INSERT OR REPLACE INTO settings (key,value) VALUES ('apiBase',?)", [json.config.baseURL])
    }
    return { imported, skipped }
  }

  function saveMemoInner(data: any) {
    const id = uuid()
    const now = nowStr()
    exec(
      'INSERT INTO memos (id, title, content, tags, event, location, due_date, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, data.title, data.content || '', (data.tags || []).join(','), data.event || '', data.location || '', data.due_date || '', data.status || 'active', data.created_at || now, now]
    )
  }

  function addGlossaryInner(wrong: string, correct: string) {
    if (!wrong || !correct) return
    const now = nowStr()
    exec("INSERT OR REPLACE INTO glossary_terms (wrong_term,correct_term,count,source,created_at,updated_at) VALUES (?,?,1,'imported',?,?)", [wrong, correct, now, now])
  }

  function uuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
  }

  // ═══════════════════════════
  // 知识库 CRUD（浏览器侧）
  // ═══════════════════════════

  export async function fetchKnowledge(): Promise<any[]> {
    await initDb()
    const rows = queryAll('SELECT * FROM knowledge ORDER BY updated_at DESC')
    return rows.map((r: any) => ({
      ...r, tags: r.tags ? r.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
    }))
  }

  export async function searchKnowledge(query: string): Promise<any[]> {
    await initDb()
    const q = '%' + query + '%'
    const rows = queryAll(
      'SELECT * FROM knowledge WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 50',
      [q, q, q]
    )
    return rows.map((r: any) => ({
      ...r, tags: r.tags ? r.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
    }))
  }

  export async function saveKnowledge(data: {
    id?: number; title: string; content: string
    tags?: string[]; linked_memo_id?: number | null
  }) {
    await initDb()
    const now = nowStr()
    const tags = (data.tags || []).join(',')
    if (data.id) {
      exec('UPDATE knowledge SET title=?, content=?, tags=?, linked_memo_id=?, updated_at=? WHERE id=?',
        [data.title, data.content, tags, data.linked_memo_id || null, now, data.id])
      schedulePersist()
      return { id: data.id }
    }
    const id = uuid()
    exec('INSERT INTO knowledge (id, title, content, tags, linked_memo_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [id, data.title, data.content, tags, data.linked_memo_id || null, now, now])
    schedulePersist()
    return { id }
  }

  export async function deleteKnowledge(id: number) {
    await initDb()
    exec('DELETE FROM knowledge WHERE id=?', [id])
    schedulePersist()
    return { ok: true }
  }