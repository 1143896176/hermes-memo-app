/**
 * 数据库适配层（移动端版）
 *
 * 目标环境：Node.js for Mobile Apps v24.5.0（Android 内嵌）
 * 使用 node:sqlite（Node 24 内置实验性 API，已验证支持 FTS5）
 *
 * node:sqlite API:
 *   const { DatabaseSync } = require('node:sqlite');
 *   const db = new DatabaseSync(path);
 *   db.exec(sql);
 *   db.prepare(sql).get()/all()/run()
 *
 * 注意：node:sqlite 没有 db.pragma() 方法，用 db.exec('PRAGMA ...') 替代。
 *
 * 用法：
 *   const { openDb, isMobile } = require('./db/index.js');
 *   const db = openDb(filePath);
 *   db.exec('PRAGMA journal_mode = WAL');
 */

const path = require('path');
const fs = require('fs');

const isMobile =
  !!process.env.CAPACITOR_NODEJS ||
  !!process.env.NODEJS_MOBILE ||
  !!(globalThis).capacitorNodejs;

// ════════════════════════════════════
// node:sqlite 适配
// ════════════════════════════════════

let _DatabaseSync = null;

function getDatabaseSync() {
  if (_DatabaseSync) return _DatabaseSync;
  try {
    _DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    // Fallback：某些 Node 版本需要 --experimental-sqlite 标志
    // nodejs-mobile v24.5 已默认启用，这里做兼容
    throw new Error('node:sqlite 不可用: ' + (e && e.message || String(e)));
  }
  return _DatabaseSync;
}

/**
 * 打开数据库连接
 * @param {string} filePath 数据库文件路径
 * @param {object} [opts] 选项 { readonly?: boolean }
 * @returns {DBConnection}
 */
function openDb(filePath, opts) {
  const DatabaseSync = getDatabaseSync();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const dbOpts = {};
  if (opts && opts.readonly) dbOpts.readonly = true;

  const db = new DatabaseSync(filePath, dbOpts);

  // 包装为统一接口（兼容 better-sqlite3 调用风格）
  const wrapper = {
    /**
     * node:sqlite 没有 pragma()，通过 exec 执行
     * @param {string} sql e.g. "journal_mode = WAL"
     */
    pragma(sql) {
      db.exec('PRAGMA ' + sql);
    },
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run(...params) {
          return stmt.run(...params);
        },
        get(...params) {
          return stmt.get(...params);
        },
        all(...params) {
          return stmt.all(...params);
        },
      };
    },
    close() {
      db.close();
    },
    transaction(fn) {
      // node:sqlite 没有内置 transaction() 包装，手动实现
      return (...args) => {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      };
    },
  };

  return wrapper;
}

module.exports = { openDb, isMobile, getDatabaseSync };
