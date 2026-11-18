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
    // android / darwin 是两套分别编译的 nodejs-mobile 二进制，
    // iOS 上若这个内建模块没编进去，只有在第一次开库时才会暴露。
    // 把平台和"这不是数据丢了"写清楚，避免用户以为备忘全没了。
    const platform = process.platform === 'darwin' ? 'iOS' : process.platform;
    throw new Error(
      `本机 Node 运行时（${platform}）没有 sqlite 支持：` +
      (e && e.message || String(e)) +
      '；已有数据仍在磁盘上，请更新 App 版本'
    );
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
