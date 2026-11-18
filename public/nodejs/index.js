/**
 * Node.js Mobile 入口 —— 在 Android 进程内运行的 Node runtime
 *
 * 这是 hermes-ts 的"灵魂"在 Android 上的载体：
 * - 完整 Node.js 24 runtime（含 node:sqlite 原生 FTS5）
 * - 通过内置 bridge 模块与 WebView 双向通信
 * - Agent 架构 + FTS5 + 多.db + fs + 完整 skill_manage 6 action
 *
 * 通信协议（bridge 模块）：
 *   WebView → Node:  Nodejs.send({ eventName: 'rpc', args: [{ id, method, params }] })
 *   Node → WebView:  channel.post('rpc', { id, result }) 或 { id, error }
 *   Node 就绪:       channel.post('ready', { node })
 */

// ── 内置 bridge 模块（nodejs-mobile 提供，不是 npm 包） ──
let channel, app
try {
  const bridge = require('bridge')
  channel = bridge.channel
  app = bridge.app
} catch (e) {
  // 非 nodejs-mobile 环境（桌面调试）—— 用 mock channel
  console.warn('[hermes-node] bridge module not found, using mock (desktop debug mode)')
  const pathMock = require('path')
  channel = {
    on() {},
    post(name, data) { console.log('[mock channel.post]', name, typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : data) }
  }
  app = { datadir: () => pathMock.resolve('data') }
}

// ════════════════════════════════════
// iOS 子进程护栏
// ════════════════════════════════════
//
// nodejs-mobile 的 iOS 二进制没有子进程实现。第三方代码（Agent 的 grep 工具会
// spawn rg）在 iOS 上调用时，可能不是抛一个可捕获的异常，而是让整个 Node 进程
// 直接退出——进程一死，数据库、bridge、UI 全挂，且日志上看不出是谁干的。
//
// 所以在加载任何业务模块之前，把 child_process 的入口替换成"明确抛出"，
// 让调用方走它自己的 catch/error 分支，代价是那一次工具调用失败，而不是 App 崩溃。
// 只在 iOS 上装，Android / 桌面照常。
if (process.platform === 'ios') {
  try {
    const cp = require('child_process')
    const deny = (name) => function () {
      throw new Error('child_process.' + name + ' 在 iOS 上不可用（nodejs-mobile 无子进程支持）')
    }
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      if (typeof cp[name] === 'function') cp[name] = deny(name)
    }
  } catch (e) {
    console.warn('[hermes-node] 安装 child_process 护栏失败:', (e && e.message) || String(e))
  }
}

// ── 启动日志 ──
console.log('[hermes-node] Node.js runtime started', {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
})

// ════════════════════════════════════
// 能力自检
// ════════════════════════════════════
//
// nodejs-mobile 的 Android / iOS 两个二进制是分别编译的，能力不一定完全一致
// （例如 node:sqlite 是否编进内核、有没有 ripgrep 可执行文件）。
// 首次在 iOS 上跑如果数据库打不开，光看 "SQLITE_ERROR" 猜不出来是哪一层，
// 所以启动时把关键能力打一遍，问题一眼可见。
const capabilities = (() => {
  const caps = { sqlite: false, sqliteError: null, ripgrep: false }
  try {
    require('node:sqlite')
    caps.sqlite = true
  } catch (e) {
    caps.sqliteError = (e && e.message) || String(e)
  }
  // iOS 的 nodejs-mobile 不实现子进程：spawn 不是抛异常，而是可能让进程直接退出。
  // 为了一个"有没有 rg"的诊断去冒启动闪退的风险不值得，iOS 上一律按不可用处理。
  if (process.platform === 'ios') {
    caps.ripgrep = false
  } else {
    try {
      const { execFileSync } = require('child_process')
      execFileSync('which', ['rg'], { stdio: 'ignore', timeout: 1500 })
      caps.ripgrep = true
    } catch {
      caps.ripgrep = false
    }
  }
  return caps
})()
console.log('[hermes-node] capabilities:', capabilities)
if (!capabilities.sqlite) {
  console.error('[hermes-node] node:sqlite 不可用，数据库相关功能将全部失败:', capabilities.sqliteError)
}

// ── 确保数据目录存在（用 app.datadir() 获取 App 私有可写目录） ──
const fs = require('fs')
const path = require('path')
const { getDataDir, getSkillsDir, getExportsDir } = require('./paths.js')
// app.datadir() 返回 /data/data/com.hermes.memo/files/ （App 私有目录，可写）
// 文档强调：Node 项目目录可能在更新时被覆盖，持久数据必须存 app.datadir()
const DATA_DIR = getDataDir()
console.log('[hermes-node] DATA_DIR:', DATA_DIR)
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(getSkillsDir(), { recursive: true })
fs.mkdirSync(getExportsDir(), { recursive: true })

// ════════════════════════════════════
// 懒加载模块（避免启动时全量 import ESM）
// ════════════════════════════════════

let _memoAgent = null;
async function getMemoAgent() {
  if (!_memoAgent) {
    const { createMemoAgent } = require('./agent.js');
    _memoAgent = await createMemoAgent();
  }
  return _memoAgent;
}

// ── 方法路由表 ──
const handlers = {};

// ════════════════════════════════════
// 系统
// ════════════════════════════════════

handlers['ping'] = async () => ({
  pong: true,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  uptime: process.uptime(),
  cwd: process.cwd(),
});

handlers['config.set'] = async (params) => {
  const { setConfig, resetModel, getConfig, getConfigFile } = require('./config.js');
  setConfig(params);
  resetModel(); // 配置变更后重置缓存的模型
  // 如果 Agent 已创建，也需要重建
  _memoAgent = null;
  // 回执只说明"有没有 Key / 用的哪个模型"，不回传任何 Key 明文
  const cfg = getConfig();
  return {
    ok: true,
    hasApiKey: !!cfg.apiKey,
    model: cfg.model,
    baseURL: cfg.baseURL,
    configFile: getConfigFile(),
  };
};

// ════════════════════════════════════
// Agent 对话
// ════════════════════════════════════

handlers['agent.chat'] = async (params) => {
  const message = params.message || params.text;
  if (!message) throw new Error('message required');

  const threadId = params.threadId || ('t-' + Date.now().toString(36));

  try {
    const agent = await getMemoAgent();
    const result = await agent.invoke({
      messages: [{ role: 'user', content: message }],
    }, {
      configurable: { thread_id: threadId },
    });

    const msgs = (result && result.messages) || [];
    const lastAi = [...msgs].reverse().find((m) => m._getType && m._getType() === 'ai');
    const content = lastAi
      ? (typeof lastAi.content === 'string' ? lastAi.content : JSON.stringify(lastAi.content))
      : '';

    return { reply: content, threadId };
  } catch (e) {
    // 带上模型名方便排查
    const { getConfig } = require('./config.js');
    const cfg = getConfig();
    const modelTag = cfg.model ? ' [model=' + cfg.model + ']' : '';
    throw new Error('agent.chat' + modelTag + ': ' + (e?.message || String(e)));
  }
};

// ════════════════════════════════════
// 备忘录 CRUD（UI 直调，不走 Agent）
// ════════════════════════════════════

handlers['memo.list'] = async (params) => {
  const { memoQuery, memoCount } = require('./tools/memo.js');
  const items = memoQuery(params);
  // total 必须是"筛选后的条数"，原来取全表 COUNT，和列表内容对不上
  return { items, total: memoCount(params) };
};

handlers['memo.save'] = async (params) => {
  const { getMemoTools } = require('./tools/memo.js');
  const { memoSave } = await getMemoTools();
  const result = await memoSave.invoke(params);
  return JSON.parse(result);
};

handlers['memo.update_status'] = async (params) => {
  const { getMemoTools } = require('./tools/memo.js');
  const { memoUpdateStatus } = await getMemoTools();
  const result = await memoUpdateStatus.invoke(params);
  return JSON.parse(result);
};

handlers['memo.delete'] = async (params) => {
  const { getMemoTools } = require('./tools/memo.js');
  const { memoDelete } = await getMemoTools();
  const result = await memoDelete.invoke(params);
  return JSON.parse(result);
};

handlers['memo.search'] = async (params) => {
  // UI 的搜索走这里，返回结构必须和 memo.list 完全一致（{ items, total }）。
  // 早期版本复用 Agent 的 memo_search 工具，返回的是 { results, snippet }：
  // 前端读 data.items 得到 undefined，卡片也没有 status/event/location 字段，
  // 表现为"一搜索列表就空了/和筛选条件对不上"。
  // FTS5 对中文分词不友好（unicode61 切不开中文词），这里用 LIKE 更可靠，
  // 数据量在几百条级别，性能没问题。
  const { memoQuery, memoCount } = require('./tools/memo.js');
  const keyword = String(params.query || params.keyword || '').trim();
  if (!keyword) return { items: [], total: 0, query: '' };
  const p = { ...params, keyword };
  return { items: memoQuery(p), total: memoCount(p), query: keyword };
};

// ════════════════════════════════════
// 术语词典
// ════════════════════════════════════

handlers['glossary.list'] = async () => {
  const { glossaryDb } = require('./modules/glossary.js');
  const terms = glossaryDb
    .prepare('SELECT * FROM glossary_terms ORDER BY count DESC')
    .all();
  return { terms };
};

handlers['glossary.add'] = async (params) => {
  const { getGlossaryTools } = require('./modules/glossary.js');
  const { glossaryAdd } = await getGlossaryTools();
  const result = await glossaryAdd.invoke(params);
  return JSON.parse(result);
};

handlers['glossary.remove'] = async (params) => {
  const { getGlossaryTools } = require('./modules/glossary.js');
  const { glossaryRemove } = await getGlossaryTools();
  const result = await glossaryRemove.invoke(params);
  return JSON.parse(result);
};

// ════════════════════════════════════
// 技能管理
// ════════════════════════════════════

handlers['skill.list'] = async () => {
  const { walkSkills } = require('./tools/skills-discovery.js');
  const skills = walkSkills();
  return {
    skills: skills.map((s, i) => ({
      id: s.meta.name ? s.meta.name.replace(/[^a-z0-9-]/g, '-') : 'skill-' + i,
      name: s.meta.name,
      description: s.meta.description || '',
      content: s.meta.content || '',
      category: s.meta.category || null,
    })),
    count: skills.length,
  };
};

handlers['skill.view'] = async (params) => {
  const { findSkill } = require('./tools/skills-discovery.js');
  const { name, file_path } = params;
  const skill = findSkill(name);
  if (!skill) {
    return { error: `技能 '${name}' 未找到` };
  }

  if (file_path) {
    const skillDir = path.dirname(skill.filePath);
    const targetPath = path.join(skillDir, file_path);
    if (!targetPath.startsWith(path.resolve(skillDir))) {
      return { error: '文件路径不得超出技能目录范围' };
    }
    if (!fs.existsSync(targetPath)) {
      return { error: `附属文件不存在: ${name}/${file_path}` };
    }
    const content = fs.readFileSync(targetPath, 'utf-8');
    return { name, file_path, content };
  }

  const content = fs.readFileSync(skill.filePath, 'utf-8');
  const skillDir = path.dirname(skill.filePath);

  // 列出附属文件
  const linkedFiles = [];
  if (fs.existsSync(skillDir)) {
    for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subDir = path.join(skillDir, entry.name);
        for (const subEntry of fs.readdirSync(subDir)) {
          linkedFiles.push(`${entry.name}/${subEntry}`);
        }
      }
    }
  }

  return {
    name,
    content,
    linked_files: linkedFiles.length > 0 ? linkedFiles : undefined,
  };
};

handlers['skill.manage'] = async (params) => {
  const { getSkillManage } = require('./tools/skill-manage.js');
  const skillManage = await getSkillManage();
  const result = await skillManage.invoke(params);
  return { result };
};

handlers['skill.write_file'] = async (params) => {
  const { getSkillManage } = require('./tools/skill-manage.js');
  const skillManage = await getSkillManage();
  const result = await skillManage.invoke({ ...params, action: 'write_file' });
  return { result };
};

handlers['skill.remove_file'] = async (params) => {
  const { getSkillManage } = require('./tools/skill-manage.js');
  const skillManage = await getSkillManage();
  const result = await skillManage.invoke({ ...params, action: 'remove_file' });
  return { result };
};

// ════════════════════════════════════
// 跨会话记忆
// ════════════════════════════════════

handlers['memory.get'] = async () => {
  const { loadMemory, loadUserProfile } = require('./memory/profile.js');
  return {
    memory: loadMemory(),
    user: loadUserProfile(),
  };
};

handlers['memory.set'] = async (params) => {
  // WebView 传 { memory, user }，兼容旧版 { type, content }
  const DATA_DIR = getDataDir();
  if (params.memory !== undefined) {
    fs.writeFileSync(path.join(DATA_DIR, 'MEMORY.md'), params.memory || '', 'utf-8');
  }
  if (params.user !== undefined) {
    fs.writeFileSync(path.join(DATA_DIR, 'USER.md'), params.user || '', 'utf-8');
  }
  if (params.type && params.content !== undefined) {
    const filePath = params.type === 'user'
      ? path.join(DATA_DIR, 'USER.md')
      : path.join(DATA_DIR, 'MEMORY.md');
    fs.writeFileSync(filePath, params.content || '', 'utf-8');
  }
  return { ok: true };
};

// ════════════════════════════════════
// FTS5 搜索
// ════════════════════════════════════

handlers['fts5.search'] = async (params) => {
  const { fts5Store } = require('./memory/fts5.js');
  const { query, limit } = params;
  const results = fts5Store.search(query, limit || 10);
  return { results, count: results.length };
};

// ════════════════════════════════════
// 导出
// ════════════════════════════════════

handlers['export.all'] = async (params) => {
  const { getExportTools } = require('./modules/export.js');
  const { exportAll } = await getExportTools();
  const result = await exportAll.invoke(params || {});
  return JSON.parse(result);
};

handlers['export.memos'] = async (params) => {
  const { getExportTools } = require('./modules/export.js');
  const { exportMemos } = await getExportTools();
  const result = await exportMemos.invoke(params || {});
  return JSON.parse(result);
};

// 返回 JSON 数据供 WebView 下载（不写文件）
handlers['export.data'] = async (params) => {
  const db = require('./db/index.js');
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = require('./paths.js').getDataDir();
  const SKILLS_DIR = require('./paths.js').getSkillsDir();

  const result = { exported_at: new Date().toISOString() };

  // 备忘录
  if (params.memos !== false) {
    try {
      const memoDb = db.openDb(path.join(DATA_DIR, 'memos.db'), { readonly: true });
      let sql = 'SELECT * FROM memos';
      if (!params.includeDone) sql += " WHERE status != 'done'";
      sql += ' ORDER BY updated_at DESC';
      const rows = memoDb.prepare(sql).all();
      memoDb.close();
      result.memos = rows.map(r => ({
        title: r.title, content: r.content, tags: r.tags, event: r.event,
        location: r.location, due_date: r.due_date, status: r.status,
        created_at: r.created_at, updated_at: r.updated_at,
      }));
    } catch {}
  }

  // 术语词典
  if (params.glossary !== false) {
    try {
      const gdb = db.openDb(path.join(DATA_DIR, 'glossary.db'), { readonly: true });
      result.glossary = gdb.prepare('SELECT wrong_term, correct_term, count, source FROM glossary_terms ORDER BY count DESC').all();
      gdb.close();
    } catch {}
  }

  // 技能
  if (params.skills !== false) {
    try {
      result.skills = {};
      const walk = (dir, prefix = '') => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          const rel = prefix ? prefix + '/' + entry : entry;
          if (fs.statSync(full).isDirectory()) { walk(full, rel); }
          else if (entry.endsWith('.md')) { result.skills[rel] = fs.readFileSync(full, 'utf-8'); }
        }
      };
      walk(SKILLS_DIR);
    } catch {}
  }

  // 知识库
  if (params.knowledge !== false) {
    try {
      const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'), { readonly: true });
      kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
      result.knowledge = kdb.prepare('SELECT * FROM knowledge ORDER BY updated_at DESC').all()
        .map(r => ({ ...r, tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [] }));
      kdb.close();
    } catch {}
  }
  if (params.memory !== false) {
    try {
      const memPath = path.join(DATA_DIR, 'memory.md');
      const userPath = path.join(DATA_DIR, 'user.md');
      if (fs.existsSync(memPath)) result.memory_md = fs.readFileSync(memPath, 'utf-8');
      if (fs.existsSync(userPath)) result.user_md = fs.readFileSync(userPath, 'utf-8');
    } catch {}
  }

  // 配置（不含 Key）
  if (params.config !== false) {
    try {
      const cfgPath = path.join(DATA_DIR, 'llm-config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        result.config = { model: cfg.model, baseURL: cfg.baseURL, temperature: cfg.temperature };
      }
    } catch {}
  }

  return result;
};

// 导出到本地文件（Download 目录）
handlers['export.file'] = async (params) => {
  const data = await handlers['export.data'](params);
  const json = JSON.stringify(data, null, 2);
  const fs = require('fs');
  const path = require('path');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const filename = `memo-backup-${stamp}.json`;
  // 尝试写入 Download 目录，不行则写 data 目录
  const dirs = ['/sdcard/Download', '/storage/emulated/0/Download'];
  let filePath = '';
  let written = false;
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      filePath = path.join(d, filename);
      fs.writeFileSync(filePath, json, 'utf-8');
      written = true;
      break;
    } catch {}
  }
  if (!written) {
    const DATA_DIR = require('./paths.js').getDataDir();
    filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, json, 'utf-8');
  }
  return { file: filePath, written };
};

// 导入 JSON 数据（Node 侧）
handlers['import.data'] = async (params) => {
  const json = params.json;
  if (!json) throw new Error('json required');
  let imported = 0, skipped = 0;

  if (json.memos?.length) {
    const { getMemoTools } = require('./tools/memo.js');
    const { memoSave } = await getMemoTools();
    for (const m of json.memos) {
      try {
        await memoSave.invoke({
          title: m.title, content: m.content,
          tags: typeof m.tags === 'string' ? m.tags.split(',') : (m.tags || []),
          location: m.location || '', due_date: m.due_date || '',
          event: m.event || '', status: m.status || 'active',
        });
        imported++;
      } catch { skipped++; }
    }
  }

  if (json.glossary?.length) {
    const db = require('./db/index.js');
    const path = require('path');
    const DATA_DIR = require('./paths.js').getDataDir();
    const gdb = db.openDb(path.join(DATA_DIR, 'glossary.db'));
    for (const g of json.glossary) {
      try {
        gdb.prepare("INSERT OR IGNORE INTO glossary_terms (wrong_term,correct_term,count,source,created_at) VALUES (?,?,?,?,?)")
          .run(g.wrong_term || g.wrong, g.correct_term || g.correct, g.count || 1, 'imported', new Date().toISOString().replace('T',' ').slice(0,19));
      } catch {}
    }
    gdb.close();
  }

  if (json.skills && typeof json.skills === 'object') {
    const fs = require('fs');
    const path = require('path');
    const SKILLS_DIR = require('./paths.js').getSkillsDir();
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    for (const [name, content] of Object.entries(json.skills)) {
      try {
        const filePath = path.join(SKILLS_DIR, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(content), 'utf-8');
      } catch {}
    }
  }

  if (json.memory_md || json.user_md) {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = require('./paths.js').getDataDir();
    if (json.memory_md) fs.writeFileSync(path.join(DATA_DIR, 'memory.md'), json.memory_md, 'utf-8');
    if (json.user_md) fs.writeFileSync(path.join(DATA_DIR, 'user.md'), json.user_md, 'utf-8');
  }

  if (json.knowledge?.length) {
    const db = require('./db/index.js');
    const path = require('path');
    const DATA_DIR = require('./paths.js').getDataDir();
    const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'));
    kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const k of json.knowledge) {
      try {
        const tags = Array.isArray(k.tags) ? k.tags.join(',') : (k.tags || '');
        kdb.prepare('INSERT INTO knowledge (title, content, tags, linked_memo_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(k.title, k.content, tags, k.linked_memo_id || null, k.created_at || new Date().toISOString().replace('T',' ').slice(0,19), new Date().toISOString().replace('T',' ').slice(0,19));
      } catch {}
    }
    kdb.close();
  }

  if (json.config) {
    const cfg = require('./config.js');
    if (json.config.model) cfg.setConfig({ model: json.config.model });
    if (json.config.baseURL) cfg.setConfig({ baseURL: json.config.baseURL });
  }

  return { imported, skipped };
};

// ════════════════════════════════════
// 知识库
// ════════════════════════════════════

handlers['knowledge.list'] = async (params) => {
  const db = require('./db/index.js');
  const path = require('path');
  const DATA_DIR = require('./paths.js').getDataDir();
  const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'), { readonly: true });
  kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const rows = kdb.prepare('SELECT * FROM knowledge ORDER BY updated_at DESC').all();
  kdb.close();
  return rows.map(r => ({ ...r, tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [] }));
};

handlers['knowledge.search'] = async (params) => {
  const q = params.query || '';
  const db = require('./db/index.js');
  const path = require('path');
  const DATA_DIR = require('./paths.js').getDataDir();
  const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'), { readonly: true });
  kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const rows = kdb.prepare("SELECT * FROM knowledge WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 50")
    .all('%'+q+'%', '%'+q+'%', '%'+q+'%');
  kdb.close();
  return rows.map(r => ({ ...r, tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [] }));
};

handlers['knowledge.save'] = async (params) => {
  const db = require('./db/index.js');
  const path = require('path');
  const DATA_DIR = require('./paths.js').getDataDir();
  const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'));
  kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tags = Array.isArray(params.tags) ? params.tags.join(',') : (params.tags || '');
  if (params.id) {
    kdb.prepare('UPDATE knowledge SET title=?, content=?, tags=?, linked_memo_id=?, updated_at=? WHERE id=?')
      .run(params.title, params.content, tags, params.linked_memo_id || null, now, params.id);
    kdb.close();
    return { id: params.id };
  } else {
    const r = kdb.prepare('INSERT INTO knowledge (title, content, tags, linked_memo_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(params.title, params.content, tags, params.linked_memo_id || null, now, now);
    kdb.close();
    return { id: r.lastInsertRowid };
  }
};

handlers['knowledge.delete'] = async (params) => {
  const db = require('./db/index.js');
  const path = require('path');
  const DATA_DIR = require('./paths.js').getDataDir();
  const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'));
  kdb.prepare('DELETE FROM knowledge WHERE id=?').run(params.id);
  kdb.close();
  return { ok: true };
};

// ════════════════════════════════════
// 草稿管线
// ════════════════════════════════════

handlers['draft.text'] = async (params) => {
  const { textToDraft } = require('./modules/memo-pipeline.js');
  return await textToDraft(params.text);
};

handlers['draft.voice'] = async (params) => {
  const { voiceToDraft } = require('./modules/memo-pipeline.js');
  return await voiceToDraft(params.audioPath);
};

handlers['draft.image'] = async (params) => {
  const { imageToDraft } = require('./modules/memo-pipeline.js');
  return await imageToDraft(params.imagePath);
};

handlers['draft.confirm'] = async (params = {}) => {
  const { confirmDraft } = require('./modules/memo-pipeline.js');
  // 兼容三种入参形态：
  //   1. { draft: DraftResult }   ← 前端实际传的
  //   2. DraftResult              ← 旧调用
  //   3. { draft: {title, content, ...} } ← 直接给草稿字段
  const wrapper = params.draft || params;
  const d = (wrapper && wrapper.draft) ? wrapper.draft : wrapper;
  if (!d || (!d.title && !d.content)) throw new Error('draft 缺少 title/content');
  const rawText = wrapper.rawText || d.content || '';
  const correctedText = wrapper.correctedText || d.content || '';
  return await confirmDraft(d, rawText, correctedText);
};

handlers['draft.revise'] = async (params) => {
  const { reviseDraft } = require('./modules/memo-pipeline.js');
  const { originalText, newText } = params;
  return await reviseDraft(originalText || '', newText);
};

// 草稿字段 Schema：让"输出什么字段"可配置（默认 title/event/due_date/location/content/tags）
handlers['draft.schema.get'] = async () => {
  const { loadFields, DEFAULT_FIELDS, schemaPath } = require('./modules/draft-schema.js');
  return {
    fields: loadFields(),
    defaultFields: DEFAULT_FIELDS,
    path: schemaPath(),
    isCustom: JSON.stringify(loadFields()) !== JSON.stringify(DEFAULT_FIELDS),
  };
};

handlers['draft.schema.set'] = async (params) => {
  const { saveFields } = require('./modules/draft-schema.js');
  // params.fields 传 null 或 [] 表示恢复默认
  return saveFields(params && params.fields);
};

// ════════════════════════════════════
// OCR
// ════════════════════════════════════

handlers['ocr.recognize'] = async (params) => {
  const { recognizeBase64 } = require('./modules/ocr.js');
  const { image, apiKey, model, language } = params;
  if (!image) throw new Error('image (base64) required');
  if (!apiKey) throw new Error('apiKey required');
  // model 留空时由 ocr.js 决定默认（当前免费视觉档 glm-4.6v-flash）
  return await recognizeBase64(image, apiKey, model || undefined, language);
};

// ════════════════════════════════════
// bridge 监听（内置 bridge 模块的 channel API）
// ════════════════════════════════════

channel.on('rpc', async (...args) => {
  // WebView 侧 Nodejs.send({ eventName: 'rpc', args: [{ id, method, params }] })
  // 收到的 args 是数组，第一个元素是 RPC 对象
  let rpc = args[0]
  if (typeof rpc === 'string') {
    try { rpc = JSON.parse(rpc) } catch { rpc = { id: null, method: rpc } }
  }
  const id = rpc && rpc.id
  const method = rpc && rpc.method
  const params = (rpc && rpc.params) || {}
  try {
    const handler = handlers[method]
    if (!handler) {
      channel.post('rpc', { id, error: 'unknown method: ' + method })
      return
    }
    const result = await handler(params)
    channel.post('rpc', { id, result })
  } catch (e) {
    console.error(`[rpc] ${method} FAILED — ${(e && e.message) || String(e)}`)
    console.error(`[rpc] ${method} STACK:`, (e && e.stack) || 'no stack')
    channel.post('rpc', { id, error: `${method}: ${(e && e.message) || String(e)}` })
  }
})

// ── 就绪通知 WebView ──
channel.post('ready', { node: process.version, platform: process.platform, arch: process.arch })