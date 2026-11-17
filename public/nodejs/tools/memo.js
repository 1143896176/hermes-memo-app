const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * 备忘录工具：memo_save / memo_search / memo_list / memo_delete / memo_update_status
 * + memoQuery（UI 直调，不走 Agent）
 *
 * 每个备忘录存在 memos.db，带 FTS5 全文索引。
 */

const path = require('path');
const fs = require('fs');
const { z } = require('../vendor.bundle.js');
const { openDb } = require('../db/index.js');

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'memos.db');

// ── 初始化 ──
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',
    event TEXT DEFAULT '',
    location TEXT DEFAULT '',
    due_date TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
    title,
    content,
    tags,
    location,
    content=memos,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS memos_fts_insert AFTER INSERT ON memos
  BEGIN
    INSERT INTO memos_fts(rowid, title, content, tags, location)
    VALUES (new.id, new.title, new.content, new.tags, new.location);
  END;

  CREATE TRIGGER IF NOT EXISTS memos_fts_update AFTER UPDATE ON memos
  BEGIN
    UPDATE memos_fts SET
      title = new.title, content = new.content,
      tags = new.tags, location = new.location
    WHERE rowid = new.id;
  END;

  CREATE TRIGGER IF NOT EXISTS memos_fts_delete AFTER DELETE ON memos
  BEGIN
    DELETE FROM memos_fts WHERE rowid = old.id;
  END;
`);

// ── 旧库迁移：早期版本没有 event 列（三要素里的"任务"存不进库） ──
try {
  const cols = db.prepare('PRAGMA table_info(memos)').all().map((c) => c.name);
  if (!cols.includes('event')) {
    db.exec("ALTER TABLE memos ADD COLUMN event TEXT DEFAULT ''");
    console.log('[memo] 迁移：memos 表新增 event 列');
  }
} catch (e) {
  console.warn('[memo] event 列迁移失败:', e && e.message);
}

// ── 旧库迁移：历史 created_at / updated_at 存的是 UTC（早期用 toISOString），
//    比本地时间早 8 小时。一次性平移到设备本地时区，只跑一次（app_meta 打标记）。
try {
  db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)');
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'tz_local_fixed'").get();
  if (!done) {
    const offsetMin = -new Date().getTimezoneOffset(); // 东八区 = 480
    const count = db.prepare('SELECT COUNT(*) AS c FROM memos').get().c;
    const pat = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
    if (count > 0 && offsetMin !== 0) {
      const shift = `${offsetMin > 0 ? '+' : '-'}${Math.abs(offsetMin)} minutes`;
      db.prepare(
        `UPDATE memos SET
           created_at = CASE WHEN created_at GLOB ? THEN datetime(created_at, ?) ELSE created_at END,
           updated_at = CASE WHEN updated_at GLOB ? THEN datetime(updated_at, ?) ELSE updated_at END`
      ).run(pat, shift, pat, shift);
      console.log(`[memo] 迁移：${count} 条历史时间从 UTC 平移 ${offsetMin} 分钟到本地时区`);
    }
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('tz_local_fixed', ?)")
      .run(nowISO());
  }
} catch (e) {
  console.warn('[memo] 时区迁移失败:', e && e.message);
}

// ── 辅助 ──
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 本地时间：YYYY-MM-DD HH:mm:ss（精确到秒，展示时取到分）
 *
 * 原来用的是 new Date().toISOString()，那是 UTC —— 中国用户看到的
 * "创建时间"会比实际早 8 小时。这里改成设备本地时间。
 */
function nowISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatMemo(row) {
  const tags = row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  return {
    id: row.id,
    title: row.title,
    content: row.content.slice(0, 500),
    tags,
    event: row.event || '',
    location: row.location || '',
    due_date: row.due_date || '',
    status: row.status || 'active',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ════════════════════════════════════
// memoQuery（UI 层直接调用，不走 Agent）
// ════════════════════════════════════

/**
 * 构造筛选条件。
 * 注意 status='all' 必须视为"不筛选"：前端 filter 的默认值就是 'all'，
 * 如果当成字面值去 AND status='all'，会一条都查不到 —— 这正是
 * "列表和筛选条件对不上"的典型成因。
 */
function buildWhere(params = {}) {
  let where = ' WHERE 1=1';
  const args = [];

  if (params.status && params.status !== 'all') {
    where += ' AND status = ?';
    args.push(params.status);
  }
  if (params.location) {
    where += ' AND location LIKE ?';
    args.push(`%${params.location}%`);
  }
  if (params.tag) {
    where += ' AND tags LIKE ?';
    args.push(`%${params.tag}%`);
  }
  if (params.due_after) {
    where += ' AND due_date >= ?';
    args.push(params.due_after);
  }
  if (params.due_before) {
    where += " AND due_date <= ? AND due_date <> ''";
    args.push(params.due_before);
  }

  // 关键词：标题/正文/标签/事件/地点 任一命中
  const keyword = String(params.keyword || params.query || '').trim();
  if (keyword) {
    where +=
      " AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR IFNULL(event,'') LIKE ? OR IFNULL(location,'') LIKE ?)";
    const like = `%${keyword}%`;
    args.push(like, like, like, like, like);
  }

  return { where, args };
}

function memoQuery(params = {}) {
  const { where, args } = buildWhere(params);
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 500);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const sql = `SELECT * FROM memos${where} ORDER BY due_date ASC, updated_at DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, limit, offset);
  return rows.map(formatMemo);
}

/** 筛选后的总条数（原先前端拿的是全表 COUNT，和列表内容对不上） */
function memoCount(params = {}) {
  const { where, args } = buildWhere(params);
  const row = db.prepare(`SELECT COUNT(*) as c FROM memos${where}`).get(...args);
  return row ? row.c : 0;
}

// ════════════════════════════════════
// 工具定义
// ════════════════════════════════════

async function makeMemoTools() {
  const vendor = require('../vendor.bundle.js'); const { tool } = vendor;

  const memoSave = tool(
    async ({ id, title, content, tags, event, location, due_date }) => {
      const now = nowISO();
      const tagStr = (tags || []).join(', ');

      // 显式 id 更新
      if (id != null) {
        const byId = db.prepare('SELECT id, title FROM memos WHERE id = ?').get(id);
        if (byId) {
          db.prepare(
            'UPDATE memos SET title=?, content=?, tags=?, event=?, location=?, due_date=?, updated_at=? WHERE id=?'
          ).run(title, content, tagStr, event || '', location || '', due_date || '', now, id);
          return JSON.stringify({
            action: 'updated', id, title,
            old_title: byId.title,
            message: `已更新 #${id}: "${byId.title}" → "${title}"`,
          });
        }
      }

      // 标题匹配更新
      const existing = db.prepare('SELECT id FROM memos WHERE title = ?').get(title);
      if (existing) {
        db.prepare(
          'UPDATE memos SET content=?, tags=?, event=?, location=?, due_date=?, updated_at=? WHERE id=?'
        ).run(content, tagStr, event || '', location || '', due_date || '', now, existing.id);
        return JSON.stringify({
          action: 'updated', id: existing.id, title,
          message: `已更新笔记 "${title}"`,
        });
      }

      // 新建
      const result = db.prepare(
        "INSERT INTO memos (title, content, tags, event, location, due_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"
      ).run(title, content, tagStr, event || '', location || '', due_date || '', now, now);

      return JSON.stringify({
        action: 'created', id: result.lastInsertRowid, title,
        message: `已保存笔记 "${title}"`,
      });
    },
    {
      name: 'memo_save',
      description:
        '保存或更新笔记。传 id 按ID更新（允许改标题），不传id按标题匹配。支持任务/事件、地点、截止时间。',
      schema: z.object({
        id: z.number().optional().describe('笔记ID（更新时传入）'),
        title: z.string().describe('笔记标题'),
        content: z.string().describe('笔记正文'),
        tags: z.array(z.string()).optional().describe('标签列表'),
        event: z.string().optional().describe("任务/事件，动宾短语（如'开会'、'买牛奶'）"),
        location: z.string().optional().describe("地点（如'301会议室'）"),
        due_date: z.string().optional().describe("截止时间（如'2026-11-20 15:00'）"),
      }),
    }
  );

  const memoSearch = tool(
    async ({ query, limit = 10 }) => {
      const q = String(query || '').trim();
      if (!q) {
        return JSON.stringify({ results: [], query: '', message: '请提供搜索关键词' });
      }

      let rows = [];
      // FTS5 默认 unicode61 分词器切不开中文（整句当一个词），中文查询经常命中 0 条，
      // 甚至因特殊字符直接语法报错 → 失败或无结果时用 LIKE 兜底
      try {
        rows = db
          .prepare(
            `SELECT m.id, m.title, m.content, m.tags, m.created_at, m.updated_at,
                    snippet(memos_fts, 1, '<mark>', '</mark>', '…', 40) AS snippet
             FROM memos_fts f
             JOIN memos m ON m.id = f.rowid
             WHERE memos_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(q, limit);
      } catch (e) {
        console.warn('[memo] FTS 查询失败，改用 LIKE:', e && e.message);
      }

      if (!rows.length) {
        const like = `%${q}%`;
        rows = db
          .prepare(
            `SELECT id, title, content, tags, created_at, updated_at
             FROM memos
             WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
                OR IFNULL(event,'') LIKE ? OR IFNULL(location,'') LIKE ?
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(like, like, like, like, like, limit);
      }

      const results = rows.map((row) => ({
        id: row.id,
        title: row.title,
        snippet: row.snippet || String(row.content || '').slice(0, 60),
        tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        created_at: row.created_at,
      }));

      return JSON.stringify({
        results,
        count: results.length,
        query: q,
      });
    },
    {
      name: 'memo_search',
      description:
        "全文搜索备忘录。支持关键词检索，返回匹配的笔记摘要（高亮匹配片段）。适用场景：用户问'之前关于XXX的笔记'、'帮我找XXX相关的内容'。",
      schema: z.object({
        query: z.string().describe('搜索关键词，支持多词（空格分隔）'),
        limit: z.number().optional().default(10).describe('返回结果数量上限'),
      }),
    }
  );

  const memoList = tool(
    async ({ tag, status, limit = 20 }) => {
      let sql = 'SELECT * FROM memos WHERE 1=1';
      const params = [];
      if (tag) { sql += ' AND tags LIKE ?'; params.push(`%${tag}%`); }
      if (status) { sql += ' AND status = ?'; params.push(status); }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      const items = rows.map(formatMemo);
      return JSON.stringify({
        items, count: items.length,
        tag: tag || null, status: status || null,
        total: db.prepare('SELECT COUNT(*) as c FROM memos').get().c,
      });
    },
    {
      name: 'memo_list',
      description: '列出备忘录。可按标签、状态过滤。按更新时间倒序。',
      schema: z.object({
        tag: z.string().optional().describe('按标签筛选'),
        status: z.enum(['active', 'done', 'cancelled']).optional().describe('按状态筛选'),
        limit: z.number().optional().default(20).describe('返回数量'),
      }),
    }
  );

  const memoDelete = tool(
    async ({ id }) => {
      const existing = db.prepare('SELECT id, title FROM memos WHERE id = ?').get(id);
      if (!existing) {
        return JSON.stringify({ error: `笔记 #${id} 不存在` });
      }
      db.prepare('DELETE FROM memos WHERE id = ?').run(id);
      return JSON.stringify({
        action: 'deleted',
        id,
        title: existing.title,
        message: `已删除笔记 #${id}: "${existing.title}"`,
      });
    },
    {
      name: 'memo_delete',
      description: "按 ID 删除笔记。适用场景：清理过期残留、删除重复内容、用户说'删掉那条'。",
      schema: z.object({
        id: z.number().describe('要删除的笔记 ID'),
      }),
    }
  );

  const memoUpdateStatus = tool(
    async ({ id, status }) => {
      const existing = db.prepare('SELECT id, title FROM memos WHERE id = ?').get(id);
      if (!existing) return JSON.stringify({ error: `笔记 #${id} 不存在` });
      db.prepare('UPDATE memos SET status=?, updated_at=? WHERE id=?')
        .run(status, nowISO(), id);
      return JSON.stringify({
        id, title: existing.title, status,
        message: `#${id} "${existing.title}" → ${status}`,
      });
    },
    {
      name: 'memo_update_status',
      description: "修改笔记状态：active/done/cancelled。用户说'做完了'、'取消这个'时使用。",
      schema: z.object({
        id: z.number().describe('笔记 ID'),
        status: z.enum(['active', 'done', 'cancelled']).describe('新状态'),
      }),
    }
  );

  return { memoSave, memoSearch, memoList, memoDelete, memoUpdateStatus };
}

// 延迟初始化
let _cache = null;
async function getMemoTools() {
  if (!_cache) _cache = await makeMemoTools();
  return _cache;
}

module.exports = { getMemoTools, memoQuery, memoCount, memoDb: db };