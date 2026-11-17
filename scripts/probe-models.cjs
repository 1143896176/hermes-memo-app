#!/usr/bin/env node
/**
 * 智谱 BigModel 模型连通性探测
 *
 * 用途：一次跑完所有候选 model id，直接告诉你哪个"通"、哪个 404、哪个 429。
 * 比看文档猜 model id 靠谱——以你账号的实际权限为准。
 *
 * 用法：
 *   node scripts/probe-models.cjs sk-你的key
 *   ZHIPU_API_KEY=sk-你的key node scripts/probe-models.cjs
 *
 * 说明：
 *   - 免费档需要实名认证，未实名会 401/403
 *   - 免费档并发约 1，连续探测会 429（说明模型是通的，只是要排队）
 *   - 请求体带 max_tokens=8，一次探测消耗可忽略
 */

const BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'

// 2026-11 智谱免费档候选（输入输出 0 元）
const CANDIDATES = [
  // 文本
  'glm-4.7-flash',
  'glm-4.5-flash',
  'glm-4-flash',
  'glm-4-flash-250414',
  'glm-4-air',
  'glm-4',
  // 视觉
  'glm-4.6v-flash',
  'glm-4.1v-thinking-flash',
  'glm-4v-flash',
]

const apiKey = process.argv[2] || process.env.ZHIPU_API_KEY || ''
if (!apiKey) {
  console.error('缺少 API Key。用法：node scripts/probe-models.cjs sk-你的key')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(model) {
  const startedAt = Date.now()
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    })
    const ms = Date.now() - startedAt
    const text = await resp.text().catch(() => '')
    let detail = text.slice(0, 160).replace(/\s+/g, ' ')
    if (resp.ok) {
      let reply = ''
      try {
        const j = JSON.parse(text)
        reply = j?.choices?.[0]?.message?.content ?? ''
      } catch {}
      return { model, status: 'OK', code: resp.status, ms, note: `回复: ${String(reply).slice(0, 30)}` }
    }
    // 智谱业务错误码常在 body 的 error.code
    let bizCode = ''
    try {
      const j = JSON.parse(text)
      bizCode = j?.error?.code ?? ''
      if (j?.error?.message) detail = String(j.error.message).slice(0, 160)
    } catch {}

    if (resp.status === 429 || bizCode === 1302 || bizCode === 1305) {
      return { model, status: 'LIMITED', code: resp.status, ms, note: `限流/并发超限（模型存在）: ${detail}` }
    }
    if (resp.status === 401 || resp.status === 403) {
      return { model, status: 'AUTH', code: resp.status, ms, note: `Key 无效或未实名: ${detail}` }
    }
    if (resp.status === 404 || bizCode === 1211 || bizCode === 1213) {
      return { model, status: 'GONE', code: resp.status, ms, note: `模型不存在/无权限: ${detail}` }
    }
    if (resp.status === 400) {
      return { model, status: 'BAD', code: resp.status, ms, note: detail }
    }
    return { model, status: 'FAIL', code: resp.status, ms, note: detail }
  } catch (e) {
    return { model, status: 'ERROR', code: '-', ms: Date.now() - startedAt, note: e?.message || String(e) }
  }
}

const ICON = {
  OK: '✅ 通',
  LIMITED: '⏳ 通(限流)',
  AUTH: '🔑 Key 问题',
  GONE: '❌ 不存在',
  BAD: '⚠️ 参数/权限',
  FAIL: '❌ 失败',
  ERROR: '💥 网络',
}

;(async () => {
  console.log(`探测 ${CANDIDATES.length} 个模型 @ ${BASE_URL}\n`)
  const results = []
  for (const model of CANDIDATES) {
    const r = await probe(model)
    results.push(r)
    console.log(`${ICON[r.status] || r.status}\t${model.padEnd(24)} ${String(r.code).padEnd(4)} ${String(r.ms + 'ms').padEnd(7)} ${r.note}`)
    // 免费档并发 1，逐个之间留间隔，避免自己把自己限流
    await sleep(1200)
  }

  const ok = results.filter((r) => r.status === 'OK')
  const limited = results.filter((r) => r.status === 'LIMITED')
  console.log('\n──────── 结论 ────────')
  if (ok.length) {
    console.log('可用（200）:', ok.map((r) => r.model).join(', '))
  } else {
    console.log('没有模型返回 200。')
  }
  if (limited.length) {
    console.log('存在但被限流:', limited.map((r) => r.model).join(', '), '（稍后重试即可）')
  }
  if (!ok.length && !limited.length) {
    const auth = results.find((r) => r.status === 'AUTH')
    if (auth) {
      console.log('全部鉴权失败 → 先确认 Key 正确、且账号已实名认证（免费档强制实名）。')
    } else {
      console.log('全部不可用 → 检查网络能否访问 open.bigmodel.cn，以及 base url 是否为 /api/paas/v4。')
    }
  }
})()
