const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * 术语词典模块（数据库版）
 *
 * 存储用户自定义术语修正对，管线自动加载。
 * 支持 Agent 工具管理（增删查），高频修正自动晋升。
 *
 * 独立 glossary.db，长词优先+计数自增+自动晋升。
 */

const path = require('path');
const fs = require('fs');
const { z } = require('../vendor.bundle.js');
const { openDb } = require('../db/index.js');

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'glossary.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS glossary_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wrong_term TEXT NOT NULL,
    correct_term TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    source TEXT DEFAULT 'manual',
    created_at TEXT NOT NULL,
    UNIQUE(wrong_term, correct_term)
  );
`);

function nowISO() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ════════════════════════════════════
// 核心：应用术语修正
// ════════════════════════════════════
function applyGlossary(text) {
  let result = text;
  const fixes = [];

  // 按词长降序（长词优先匹配，避免"G代码"的"G"先被替换）
  const terms = db
    .prepare('SELECT wrong_term, correct_term FROM glossary_terms ORDER BY LENGTH(wrong_term) DESC')
    .all();

  for (const t of terms) {
    if (result.includes(t.wrong_term)) {
      result = result.replace(new RegExp(escapeRegex(t.wrong_term), 'g'), t.correct_term);
      fixes.push({ from: t.wrong_term, to: t.correct_term });
      // 递增使用计数
      db.prepare('UPDATE glossary_terms SET count = count + 1 WHERE wrong_term = ? AND correct_term = ?')
        .run(t.wrong_term, t.correct_term);
    }
  }

  return { corrected: result, fixes };
}

// ════════════════════════════════════
// 从反馈学习晋升（高频修正 → 自动加入术语库）
// ════════════════════════════════════
function promoteFromFeedback(wrong, correct, count) {
  if (count < 3) return false; // 至少 3 次才晋升

  const existing = db
    .prepare('SELECT id FROM glossary_terms WHERE wrong_term = ? AND correct_term = ?')
    .get(wrong, correct);

  if (existing) {
    db.prepare('UPDATE glossary_terms SET count = count + ? WHERE id = ?')
      .run(count, existing.id);
  } else {
    db.prepare(
      "INSERT OR IGNORE INTO glossary_terms (wrong_term, correct_term, count, source, created_at) VALUES (?, ?, ?, 'auto', ?)"
    ).run(wrong, correct, count, nowISO());
  }
  return true;
}

// ════════════════════════════════════
// Agent 工具
// ════════════════════════════════════

async function makeGlossaryTools() {
  const vendor = require('../vendor.bundle.js'); const { tool } = vendor;

  const glossaryAdd = tool(
    async ({ wrong_term, correct_term }) => {
      db.prepare(
        "INSERT OR REPLACE INTO glossary_terms (wrong_term, correct_term, count, source, created_at) VALUES (?, ?, 1, 'manual', ?)"
      ).run(wrong_term, correct_term, nowISO());

      return JSON.stringify({
        action: 'added',
        term: `${wrong_term} → ${correct_term}`,
        message: `已添加术语: "${wrong_term}" → "${correct_term}"`,
      });
    },
    {
      name: 'glossary_add',
      description: "添加术语修正：错误词→正确词。如语音识别常把'G代码'识别成'记代码'。",
      schema: z.object({
        wrong_term: z.string().describe('错误/常见识别错误的词'),
        correct_term: z.string().describe('正确词'),
      }),
    }
  );

  const glossaryList = tool(
    async () => {
      const terms = db
        .prepare('SELECT wrong_term, correct_term, count, source FROM glossary_terms ORDER BY count DESC LIMIT 50')
        .all();

      return JSON.stringify({
        terms: terms.map((t) => ({
          wrong: t.wrong_term,
          correct: t.correct_term,
          used: t.count,
          source: t.source,
        })),
        total: terms.length,
      });
    },
    {
      name: 'glossary_list',
      description: "列出所有术语修正对。用户问'有哪些术语'、'语音识别改了哪些词'时使用。",
      schema: z.object({}),
    }
  );

  const glossaryRemove = tool(
    async ({ wrong_term }) => {
      const result = db.prepare('DELETE FROM glossary_terms WHERE wrong_term = ?').run(wrong_term);
      return JSON.stringify({
        deleted: result.changes,
        message: result.changes > 0 ? `已删除术语: "${wrong_term}"` : `术语 "${wrong_term}" 不存在`,
      });
    },
    {
      name: 'glossary_remove',
      description: "删除术语修正。用户说'这个词不用改了'时使用。",
      schema: z.object({
        wrong_term: z.string().describe('要删除的错误词'),
      }),
    }
  );

  return { glossaryAdd, glossaryList, glossaryRemove };
}

// 延迟初始化
let _cache = null;
async function getGlossaryTools() {
  if (!_cache) _cache = await makeGlossaryTools();
  return _cache;
}

module.exports = { getGlossaryTools, applyGlossary, promoteFromFeedback, glossaryDb: db };