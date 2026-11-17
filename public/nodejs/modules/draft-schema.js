/**
 * 草稿结构 Schema —— 让「输出什么字段」成为可配置数据，而不是写死在 prompt 里
 *
 * 设计目标：
 *   1. 默认给出备忘录三要素（event 任务 / due_date 时间 / location 地点）
 *   2. 允许用户用 DATA_DIR/draft-schema.json 自定义任意字段
 *   3. 用同一份字段定义同时生成 prompt 和做结果校验，避免"prompt 说要 6 个字段、
 *      代码只认 5 个"这类两边漂移的问题
 *
 * 字段定义（每项）：
 *   { key, type: 'string'|'array', desc, example, required }
 *   required=true 表示"字段必须出现"（值可以是 ""/[]），不是"必须有值"
 */

const path = require('path');
const fs = require('fs');
const { getDataDir } = require('../paths.js');

/** 默认字段：备忘录三要素 + 标题正文标签 */
const DEFAULT_FIELDS = [
  {
    key: 'title',
    type: 'string',
    required: true,
    desc: '简短中文标题（≤20 字）',
    example: '公司开会',
  },
  {
    key: 'event',
    type: 'string',
    required: true,
    desc: '任务/事件，动宾短语（开会 / 买牛奶 / 交报销 / 体检），不要写成整句',
    example: '开会',
  },
  {
    key: 'due_date',
    type: 'string',
    required: true,
    desc: '时间，绝对时间 YYYY-MM-DD HH:mm；只有日期填 YYYY-MM-DD 00:00；无时间线索填 ""',
    example: '2026-11-17 15:00',
  },
  {
    key: 'location',
    type: 'string',
    required: true,
    desc: '地点（公司 / 302 会议室 / 超市 / 医院），无地点线索填 ""',
    example: '公司 302 会议室',
  },
  {
    key: 'content',
    type: 'string',
    required: true,
    desc: '整理后的完整正文，保留原意与细节',
    example: '明天下午 3 点去公司 302 会议室开会，讨论下季度预算',
  },
  {
    key: 'tags',
    type: 'array',
    required: true,
    desc: '2-5 个中文标签',
    example: ['工作', '会议'],
  },
];

// ════════════════════════════════════
// 自定义 schema 存取
// ════════════════════════════════════

function schemaPath() {
  return path.join(getDataDir(), 'draft-schema.json');
}

/** 校验一份自定义字段定义是否可用 */
function validateFieldDefs(defs) {
  if (!Array.isArray(defs) || defs.length === 0) {
    return { ok: false, error: 'fields 必须是非空数组' };
  }
  const keys = new Set();
  for (const f of defs) {
    if (!f || typeof f !== 'object') return { ok: false, error: '每个字段必须是对象' };
    if (!f.key || typeof f.key !== 'string') return { ok: false, error: '字段缺少 key' };
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.key)) {
      return { ok: false, error: `字段 key 只能是字母数字下划线: ${f.key}` };
    }
    if (keys.has(f.key)) return { ok: false, error: `字段 key 重复: ${f.key}` };
    keys.add(f.key);
    if (f.type && f.type !== 'string' && f.type !== 'array') {
      return { ok: false, error: `字段 ${f.key} 的 type 只支持 string / array` };
    }
  }
  if (!keys.has('title')) return { ok: false, error: '必须包含 title 字段' };
  if (!keys.has('content')) return { ok: false, error: '必须包含 content 字段' };
  return { ok: true };
}

/** 读取字段定义：优先用户自定义，失败回退默认 */
function loadFields() {
  try {
    const p = schemaPath();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const defs = Array.isArray(parsed) ? parsed : parsed && parsed.fields;
      const check = validateFieldDefs(defs);
      if (check.ok) {
        return defs.map((f) => ({
          key: f.key,
          type: f.type === 'array' ? 'array' : 'string',
          required: f.required !== false,
          desc: f.desc || f.description || f.key,
          example: f.example,
        }));
      }
      console.warn('[draft-schema] 自定义 schema 无效，回退默认:', check.error);
    }
  } catch (e) {
    console.warn('[draft-schema] 读取 draft-schema.json 失败，回退默认:', e && e.message);
  }
  return DEFAULT_FIELDS;
}

/** 保存自定义 schema（传 null/[] 表示恢复默认） */
function saveFields(defs) {
  const p = schemaPath();
  if (!defs || (Array.isArray(defs) && defs.length === 0)) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    return { ok: true, fields: DEFAULT_FIELDS, reset: true };
  }
  const check = validateFieldDefs(defs);
  if (!check.ok) return { ok: false, error: check.error };
  fs.writeFileSync(p, JSON.stringify({ fields: defs }, null, 2), 'utf-8');
  return { ok: true, fields: loadFields() };
}

// ════════════════════════════════════
// Prompt 生成
// ════════════════════════════════════

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 当前时间上下文：模型不知道今天几号，必须告诉它，否则"明天/下周五"全靠编 */
function nowContext(date) {
  const d = date || new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function typeLabel(f) {
  return f.type === 'array' ? '字符串数组' : '字符串';
}

function exampleObject(fields, values) {
  const obj = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(values, f.key)) {
      obj[f.key] = values[f.key];
    } else if (f.example !== undefined) {
      // 自定义字段没给示例值时，退回字段自带 example，避免示例里全是空串（模型会学着留空）
      obj[f.key] = f.example;
    } else {
      obj[f.key] = f.type === 'array' ? [] : '';
    }
  }
  return obj;
}

/** 明天 15:00，用于 few-shot，避免示例里写死会过期的日期 */
function tomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:00`;
}

/**
 * 由字段定义生成 system prompt
 * @param {Array} fields 字段定义
 * @param {Date} [now] 当前时间（测试时可注入）
 */
function buildSystemPrompt(fields, now) {
  const lines = [];
  lines.push('你是备忘录草稿解析器。把用户的自然语言输入转成结构化 JSON。');
  lines.push('');
  lines.push(`当前时间：${nowContext(now)}`);
  lines.push('（务必以此为基准换算"明天""后天""下周五""月底"等相对时间，不要照抄示例里的日期）');
  lines.push('');
  lines.push('## 输出字段');
  for (const f of fields) {
    const req = f.required === false ? '（可选）' : '';
    lines.push(`- ${f.key} (${typeLabel(f)}${req}): ${f.desc}`);
  }
  lines.push('');
  lines.push('## 规则');
  lines.push('1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。');
  lines.push(`2. 字段必须齐全：${fields.map((f) => f.key).join('、')}。无法确定的字符串填 ""，数组填 []，禁止省略字段。`);
  lines.push('3. 不要编造输入中没有的时间、地点、人名；没提到就留空。');
  lines.push('4. 相对时间要换算成绝对时间，格式 YYYY-MM-DD HH:mm。');

  const hasEvent = fields.some((f) => f.key === 'event');
  if (hasEvent) {
    lines.push('5. event 是"要做什么"的动宾短语（开会 / 买牛奶 / 交报销），不是整句，不要把时间地点塞进 event。');
  }

  // few-shot：按实际字段动态拼，保证示例永远覆盖全部字段
  const ex1 = exampleObject(fields, {
    title: '公司开会',
    event: '开会',
    due_date: tomorrowAt(15),
    location: '公司 302 会议室',
    content: '明天下午 3 点去公司 302 会议室开会，讨论下季度预算',
    tags: ['工作', '会议'],
  });
  const ex2 = exampleObject(fields, {
    title: '买牛奶',
    event: '买牛奶',
    due_date: '',
    location: '',
    content: '记得买牛奶',
    tags: ['购物'],
  });

  lines.push('');
  lines.push('## 示例');
  lines.push('输入：明天下午3点去公司302开会讨论预算');
  lines.push('输出：' + JSON.stringify(ex1));
  lines.push('输入：记得买牛奶');
  lines.push('输出：' + JSON.stringify(ex2));

  return lines.join('\n');
}

// ════════════════════════════════════
// 结果解析与校验
// ════════════════════════════════════

/**
 * 从模型回复里抠出 JSON
 * 覆盖：纯 JSON / ```json 围栏 / 前后带解释 / 嵌套大括号
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();

  // 1. 去掉 markdown 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 2. 直接解析
  try {
    const direct = JSON.parse(s);
    if (direct && typeof direct === 'object') return direct;
  } catch {}

  // 3. 平衡括号扫描，取第一个完整对象（跳过硬核括号内的字符串）
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          if (obj && typeof obj === 'object') return obj;
        } catch {}
        return null;
      }
    }
  }
  return null;
}

function coerceValue(value, field) {
  if (field.type === 'array') {
    if (Array.isArray(value)) {
      return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      // 模型有时返回 "工作,会议" 或 "工作、会议"
      return value.split(/[,，、;；\s]+/).map((v) => v.trim()).filter(Boolean);
    }
    return [];
  }
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join('');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 按字段定义归一化模型输出
 * @returns {{ data: object, missing: string[], extra: string[] }}
 */
function normalizeDraft(raw, fields) {
  const data = {};
  const missing = [];
  const known = new Set(fields.map((f) => f.key));

  for (const f of fields) {
    const has = raw && Object.prototype.hasOwnProperty.call(raw, f.key);
    if (!has) {
      missing.push(f.key);
      data[f.key] = f.type === 'array' ? [] : '';
      continue;
    }
    data[f.key] = coerceValue(raw[f.key], f);
  }

  const extra = raw ? Object.keys(raw).filter((k) => !known.has(k)) : [];
  return { data, missing, extra };
}

/** 三要素里哪些还是空的（用于 UI 提示与二次追问） */
function missingKeyFields(data) {
  const checks = [
    ['event', '任务'],
    ['due_date', '时间'],
    ['location', '地点'],
  ];
  return checks.filter(([k]) => Object.prototype.hasOwnProperty.call(data, k) && !data[k]).map(([, label]) => label);
}

module.exports = {
  DEFAULT_FIELDS,
  loadFields,
  saveFields,
  validateFieldDefs,
  buildSystemPrompt,
  extractJson,
  normalizeDraft,
  missingKeyFields,
  nowContext,
  schemaPath,
};
