/**
 * Memo Pipeline — 语音/图片 → 备忘录 完整管线
 *
 * 4阶段管线：glossary → feedback → parseDraft → inferContext
 *
 * 流程：
 *   语音/图片 → STT/OCR → 反馈修正 → Agent 解析草稿
 *   → 返回草稿给 UI → 用户确认/修改
 *   ├─ 确认 → 存库 + 记录修正学习
 *   └─ 修改 → 记录修正 → 重新生成草稿
 *
 * 与 UI 层的约定：
 *   每次调用返回 DraftResult，UI 根据 needsConfirmation 决定下一步
 */

const { transcribe } = require('./stt.js');
const { recognize } = require('./ocr.js');
const { applyCorrections, recordCorrection } = require('./feedback-learner.js');
const { applyGlossary } = require('./glossary.js');
const { getModel } = require('../config.js');
const {
  loadFields, buildSystemPrompt, extractJson, normalizeDraft, missingKeyFields,
} = require('./draft-schema.js');
const fs = require('fs');

// ── 草稿解析 ──
// 结构化输出不再靠"写死 prompt + 正则抠 JSON"，而是：
//   字段定义（draft-schema.js）→ 生成 prompt → response_format=json_object → 校验归一化
// 字段可自定义（DATA_DIR/draft-schema.json），默认含备忘录三要素 event/due_date/location

/** 从原文启发式提取标签（LLM 不可用时的 fallback） */
function extractTags(text) {
  const dict = {
    '库房': '库房', '仓库': '仓库', '手套': '手套', '口罩': '口罩',
    '工具': '工具', '会议': '会议', '报告': '报告', '采购': '采购',
    '维修': '维修', '巡检': '巡检', '值班': '值班', '通知': '通知',
    '任务': '任务', '项目': '项目', '审批': '审批', '报销': '报销',
  };
  const tags = [];
  for (const [key, tag] of Object.entries(dict)) {
    if (text.includes(key)) tags.push(tag);
  }
  return tags.slice(0, 5);
}

/** 从原文启发式猜"任务/事件"（LLM 不可用时的 fallback） */
function guessEvent(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const verbs = [
    '开会', '买', '采购', '交', '缴', '取', '还', '送', '修', '体检',
    '预约', '报名', '提交', '整理', '联系', '确认', '巡检', '值班',
    '培训', '面试', '报销', '审批', '复盘', '盘点', '回访',
  ];
  for (const v of verbs) {
    const i = t.indexOf(v);
    if (i >= 0) {
      return t.slice(i).replace(/[。，,；;！!？?].*$/, '').slice(0, 16);
    }
  }
  return t
    .replace(/^(今天|明天|后天|大后天|本周|下周|这周)[一二三四五六日天]?/, '')
    .replace(/^(上午|下午|中午|晚上|早上)/, '')
    .slice(0, 16);
}

/**
 * 是否值得重试：限流 / 超时 / 网关 5xx / 网络瞬断
 * 智谱免费档只有约 1 并发，撞上就是 429，不重试会直接降级成原文草稿，
 * 表现和"模型不会结构化"一模一样。
 */
function isRetryableError(e) {
  if (!e) return false;
  const status = e.status || e.statusCode || e.code ||
    (e.response && (e.response.status || e.response.statusCode));
  if (status === 429 || status === 408) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = String(e.message || '');
  return /(429|rate.?limit|too many requests|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|50[234])/i.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 调用一次模型；jsonMode 时要求返回纯 JSON 对象。失败按指数退避重试。 */
async function callModel(model, system, userText, jsonMode) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `解析这段输入：\n${userText}` },
  ];
  const runnable = jsonMode && typeof model.bind === 'function'
    ? model.bind({ response_format: { type: 'json_object' } })
    : model;

  const maxAttempts = 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await runnable.invoke(messages);
      return (resp && typeof resp.content === 'string') ? resp.content : '';
    } catch (e) {
      lastErr = e;
      if (i === maxAttempts - 1 || !isRetryableError(e)) throw e;
      // 600ms → 1200ms，加抖动避免多请求同时重试
      const wait = 600 * Math.pow(2, i) + Math.random() * 300;
      console.warn(
        `[memo-pipeline] ${jsonMode ? 'json_object' : '普通'}模式失败（${e && e.message}），` +
        `${Math.round(wait)}ms 后第 ${i + 1} 次重试`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * 解析草稿
 * @returns {{ draft: object, meta: { llm: boolean, jsonMode?: boolean, missing?: string[], error?: string } }}
 */
async function parseDraft(rawText) {
  const fields = loadFields();
  const emptyDraft = () => {
    const d = {};
    for (const f of fields) d[f.key] = f.type === 'array' ? [] : '';
    return d;
  };
  const fallbackDraft = () => {
    const d = emptyDraft();
    d.title = rawText.slice(0, 30);
    d.content = rawText;
    if ('event' in d) d.event = guessEvent(rawText);
    if ('location' in d) d.location = '';
    if ('due_date' in d) d.due_date = '';
    if ('tags' in d) d.tags = extractTags(rawText);
    return d;
  };

  const errors = [];
  let model;
  try {
    model = await getModel();
  } catch (e) {
    const msg = (e && e.message) || '未知错误';
    // 未配置 Key 是最常见情况，直接把这句话给用户看，不要加技术前缀
    const hint = /API Key/i.test(msg) ? msg : '模型初始化失败: ' + msg;
    return { draft: fallbackDraft(), meta: { llm: false, error: hint } };
  }

  // 第一次强制 JSON；失败再退回普通模式（部分网关不支持 response_format）
  for (const jsonMode of [true, false]) {
    try {
      const text = await callModel(model, buildSystemPrompt(fields), rawText, jsonMode);
      const obj = extractJson(text);
      if (obj) {
        const { data, missing } = normalizeDraft(obj, fields);
        if (missing.length) {
          console.warn('[memo-pipeline] 模型漏了字段:', missing.join(','));
        }
        return { draft: data, meta: { llm: true, jsonMode, missing } };
      }
      errors.push(`${jsonMode ? 'json_object' : '普通'}模式返回无法解析为 JSON`);
      console.warn('[memo-pipeline] 无法解析 JSON，原始回复:', String(text).slice(0, 200));
    } catch (e) {
      errors.push(`${jsonMode ? 'json_object' : '普通'}模式调用失败: ${e && e.message}`);
      console.warn('[memo-pipeline] 调用失败:', e && e.message);
    }
  }

  // 两次都失败才降级：宁可给原文草稿，也不要让"新建备忘录"整体失败
  return { draft: fallbackDraft(), meta: { llm: false, error: errors.join(' | ') } };
}

// ── 推断：搜历史相似备忘，补全缺省字段 ──
async function inferContext(draft) {
  const result = { ...draft };

  // 从内容和标题提取关键词
  const text = (draft.title + ' ' + draft.content).toLowerCase();
  const words = text
    .replace(/[，。！？、\s\d]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2)
    .slice(0, 5);

  if (words.length === 0) return result;

  try {
    const { memoQuery } = require('../tools/memo.js');

    // 用每个关键词去搜历史
    const allPast = [];
    for (const w of words.slice(0, 3)) {
      const found = memoQuery({ limit: 5 });
      allPast.push(...found.filter((m) => m.content.includes(w) || m.title.includes(w)));
    }

    if (allPast.length === 0) return result;

    // 找最常见的地点
    if (!result.location) {
      const locs = allPast.filter((m) => m.location).map((m) => m.location);
      if (locs.length > 0) {
        const count = {};
        locs.forEach((l) => { count[l] = (count[l] || 0) + 1; });
        const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
        if (best[1] >= 2) result.inferred_location = best[0];
        else if (best[1] === 1 && locs.every((l) => l === best[0])) result.inferred_location = best[0];
      }
    }

    // 时间推断
    if (!result.due_date) {
      const times = allPast.filter((m) => m.due_date).map((m) => m.due_date);
      if (times.length >= 3) {
        const first = times[0];
        if (times.every((t) => t === first)) result.inferred_due_date = first;
      }
    }
  } catch {}

  return result;
}

// ════════════════════════════════════
// 公开 API
// ════════════════════════════════════

/** 语音输入 → 草稿 */
async function voiceToDraft(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const sttResult = await transcribe(audioPath);
  return toDraft(sttResult.text, 'voice', sttResult.confidence);
}

/** 图片输入 → 草稿 */
async function imageToDraft(imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const ocrResult = await recognize(imagePath);
  return toDraft(ocrResult.text, 'image', ocrResult.confidence);
}

/** 文本输入 → 草稿（纯文本也走管线，保持一致性） */
async function textToDraft(text) {
  return toDraft(text, 'text', 1.0);
}

/** 用户确认 → 存库 + 学习 */
async function confirmDraft(draft, rawText, correctedText) {
  const { getMemoTools } = require('../tools/memo.js');
  const { memoSave } = await getMemoTools();
  const result = await memoSave.invoke({
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
    event: draft.event || '',
    location: draft.location || draft.inferred_location || '',
    due_date: draft.due_date || draft.inferred_due_date || '',
  });

  const saved = JSON.parse(result);

  // 记录修正学习
  if (rawText !== correctedText) {
    recordCorrection(rawText, correctedText);
  }

  return {
    action: saved.action,
    saved: {
      title: saved.title || draft.title,
      content: draft.content,
      event: draft.event || '',
      tags: draft.tags,
    },
    location: draft.location,
    learnedTerms: 1,
  };
}

/** 用户修改文本 → 重新生成草稿 + 记录修正 */
async function reviseDraft(originalRawText, newText) {
  // 记录本次修正
  recordCorrection(originalRawText, newText);

  // 重新走管线
  return toDraft(newText, 'text', 1.0);
}

// ════════════════════════════════════
// 内部
// ════════════════════════════════════
async function toDraft(rawText, source, confidence) {
  // 1. 术语词典修正（优先，处理已知错别字）
  const { corrected: glossaryText, fixes: glossaryFixes } = applyGlossary(rawText.trim());

  // 2. 反馈学习修正（处理个性化错误模式）
  const { corrected, fixes } = applyCorrections(glossaryText);

  // 3. Agent 解析草稿（结构化输出 + 校验）
  const { draft, meta } = await parseDraft(corrected);

  // 4. 智能推断：从历史备忘补全缺省字段
  const enriched = await inferContext(draft);

  return {
    draft: enriched,
    rawText: rawText.trim(),
    correctedText: corrected,
    corrections: [...glossaryFixes, ...fixes],
    source,
    confidence,
    needsConfirmation: true,
    /** LLM 是否真的参与了结构化（false 表示已降级为原文草稿） */
    llmUsed: !!meta.llm,
    /** 走的是否为 response_format=json_object 模式（便于排查网关兼容性） */
    jsonMode: meta.jsonMode,
    /** 降级原因 / 被模型漏掉的字段，供 UI 提示与排查 */
    llmError: meta.error || '',
    missingFields: meta.missing || [],
    missingKeyFields: missingKeyFields(enriched),
  };
}

module.exports = { voiceToDraft, imageToDraft, textToDraft, confirmDraft, reviseDraft };