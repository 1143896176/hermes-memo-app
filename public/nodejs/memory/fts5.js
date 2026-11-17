/**
 * FTS5Store — 跨会话记忆
 *
 * 使用 node:sqlite（通过 db/index.js 适配层）。
 * 存储所有对话消息并提供 FTS5 全文搜索。
 *
 * node:sqlite 已验证支持 FTS5 virtual table + triggers。
 */

const { openDb } = require('../db/index.js');
const path = require('path');
const { getDataDir } = require('../paths.js');

const DB_PATH = path.join(getDataDir(), 'hermes.db');

class FTS5Store {
  constructor() {
    this.db = openDb(DB_PATH);
    // node:sqlite 没有 pragma()，用 exec
    this.db.exec('PRAGMA journal_mode = WAL');
    this.init();
    this.migrate();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        tool_calls TEXT,
        timestamp REAL NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);
  }

  migrate() {
    const cols = this.db
      .prepare("PRAGMA table_info('messages')")
      .all();
    const colNames = new Set(cols.map((c) => c.name));

    if (colNames.has('created_at')) {
      this.db.exec('ALTER TABLE messages RENAME COLUMN created_at TO timestamp');
    }

    if (!colNames.has('tool_name')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN tool_name TEXT');
    }

    if (!colNames.has('tool_calls')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
    }

    this.db.exec('DROP TRIGGER IF EXISTS messages_ai');
    this.db.exec('DROP TRIGGER IF EXISTS messages_ad');
    this.db.exec('DROP TRIGGER IF EXISTS messages_fts_insert');
    this.db.exec('DROP TRIGGER IF EXISTS messages_fts_delete');
    this.db.exec('DROP TABLE IF EXISTS messages_fts');

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        tool_name,
        tool_calls,
        content=messages,
        content_rowid=id
      )
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
      WHEN (new.content IS NOT NULL)
      BEGIN
        INSERT INTO messages_fts(rowid, content, tool_name, tool_calls) VALUES (
          new.id,
          CASE WHEN new.role = 'tool'
            THEN substr(COALESCE(new.content, ''), 1, 8192)
            ELSE new.content END,
          new.tool_name,
          new.tool_calls
        );
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
        VALUES ('delete', old.id, old.content, old.tool_name, old.tool_calls);
      END
    `);

    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }

  createSession(sessionId) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (id, started_at, updated_at) VALUES (?, ?, ?)'
      )
      .run(sessionId, now, now);
  }

  saveMessage(sessionId, role, content, toolName, toolCalls) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(sessionId, role, content, toolName ?? null, toolCalls ?? null, now);
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(now, sessionId);
  }

  search(query, limit = 10) {
    // 提取 FTS5 安全的关键词（字母数字+中文，去特殊字符）
    const tokens = query
      .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 5);
    if (tokens.length === 0) return [];

    // 构造安全的 FTS5 MATCH 查询
    const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');
    try {
      const stmt = this.db.prepare(`
        SELECT
          m.role,
          m.content,
          m.tool_name,
          snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      return stmt.all(ftsQuery, limit);
    } catch {
      return [];
    }
  }

  close() {
    this.db.close();
  }

  clearAll() {
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM sessions');
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }
}

const fts5Store = new FTS5Store();

module.exports = { FTS5Store, fts5Store };
