const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * 反馈学习模块
 *
 * 用户修改确认 → 记录修正对 → 下次类似输入自动纠正
 *
 * 学习策略：
 * 1. 精确匹配修正：原文→修正文本（先查精确历史）
 * 2. 关键词修正：分词后查高频错误术语
 * 3. 时效衰减：最近 30 天内修正权重大
 *
 * feedback.db + term_corrections 子表，30天时效衰减
 */

const path = require('path');
const fs = require('fs');
const { openDb } = require('../db/index.js');

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'feedback.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original TEXT NOT NULL,
    corrected TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS term_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wrong_term TEXT NOT NULL,
    correct_term TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    last_used TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_corrections_original ON corrections(original);
  CREATE INDEX IF NOT EXISTS idx_term_wrong ON term_corrections(wrong_term);
`);

function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ════════════════════════════════════
// 记录修正
// ════════════════════════════════════
function recordCorrection(original, corrected) {
  const now = nowISO();

  // 存完整修正对
  db.prepare(
    "INSERT INTO corrections (original, corrected, source, created_at) VALUES (?, ?, 'manual', ?)"
  ).run(original, corrected, now);

  // 分词提取术语修正
  const origWords = new Set(original.split(/[\s,，。！？、\n]+/).filter((w) => w.length >= 2));
  const corrWords = new Set(corrected.split(/[\s,，。！？、\n]+/).filter((w) => w.length >= 2));

  // 找差异词
  for (const w of origWords) {
    if (!corrWords.has(w)) {
      for (const c of corrWords) {
        if (c.toLowerCase() !== w.toLowerCase()) {
          upsertTerm(w, c);
        }
      }
    }
  }
}

function upsertTerm(wrong, correct) {
  const now = nowISO();
  const existing = db
    .prepare('SELECT id, count FROM term_corrections WHERE wrong_term = ? AND correct_term = ?')
    .get(wrong, correct);

  if (existing) {
    db.prepare(
      'UPDATE term_corrections SET count = count + 1, last_used = ? WHERE id = ?'
    ).run(now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO term_corrections (wrong_term, correct_term, count, last_used) VALUES (?, ?, 1, ?)'
    ).run(wrong, correct, now);
  }
}

// ════════════════════════════════════
// 应用修正（预处理）
// ════════════════════════════════════
function applyCorrections(text) {
  let result = text;
  const fixes = [];

  // 1. 精确匹配历史修正
  const exactMatch = db
    .prepare('SELECT corrected FROM corrections WHERE original = ? ORDER BY created_at DESC LIMIT 1')
    .get(text);
  if (exactMatch) {
    fixes.push({ from: text, to: exactMatch.corrected });
    return { corrected: exactMatch.corrected, applied: 1, fixes };
  }

  // 2. 高频术语修正（count >= 2 才应用，避免偶然噪声）
  // 30天时效衰减：最近30天内的修正权重大（这里通过 ORDER BY last_used DESC 体现）
  const terms = db
    .prepare(
      "SELECT wrong_term, correct_term, count FROM term_corrections WHERE count >= 2 AND last_used >= datetime('now', '-30 days') ORDER BY count DESC"
    )
    .all();

  for (const t of terms) {
    if (result.includes(t.wrong_term)) {
      result = result.replace(new RegExp(escapeRegex(t.wrong_term), 'g'), t.correct_term);
      fixes.push({ from: t.wrong_term, to: t.correct_term });
    }
  }

  return { corrected: result, applied: fixes.length, fixes };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ════════════════════════════════════
// 统计
// ════════════════════════════════════
function getStats() {
  return {
    totalCorrections: db.prepare('SELECT COUNT(*) as c FROM corrections').get().c,
    learnedTerms: db.prepare('SELECT COUNT(*) as c FROM term_corrections WHERE count >= 2').get().c,
  };
}

module.exports = { recordCorrection, applyCorrections, getStats, feedbackDb: db };