const { getDataDir, getSkillsDir, getExportsDir } = require('./paths.js')
/**
 * Agent 工厂
 *
 * createHermesAgent: 核心基座，可注入额外 System Prompt + 工具
 * createMemoAgent: 备忘录 Agent = 基座 + 领域工具
 *
 * 使用 deepagents（完整版，不是 browser 版），可以用 FilesystemBackend。
 * skills 是真实文件存在 data/skills/*.md。
 * 第三方依赖已打包到 vendor.bundle.js（避免散文件 node_modules）
 */

const path = require('path');
const { SKILLS_GUIDANCE } = require('./prompts/skills-guidance.js');
const { loadMemory, loadUserProfile } = require('./memory/profile.js');
const { createHermesMiddleware } = require('./middleware/context.js');

// 从预打包的 vendor.bundle.js 加载第三方依赖（deepagents/langchain/zod）
const vendor = require('./vendor.bundle.js');
const { createDeepAgent, FilesystemBackend, MemorySaver } = vendor;

// ── 核心基座：可注入额外 System Prompt + 工具 ──
async function createHermesAgent(opts = {}) {
  // 获取模型（config.js 缓存）
  const { getModel, resetModel } = require('./config.js');
  const model = await getModel();

  // ── 诊断日志：定位 model.invoke is not a function ──
  console.log('[agent] model type:', typeof model);
  console.log('[agent] model ctor:', model && model.constructor && model.constructor.name);
  console.log('[agent] model.invoke:', typeof (model && model.invoke));
  console.log('[agent] model.stream:', typeof (model && model.stream));
  console.log('[agent] "invoke" in model:', 'invoke' in (model || {}));
  console.log('[agent] "_modelType" in model:', '_modelType' in (model || {}));
  console.log('[agent] instanceof ChatOpenAI:', model instanceof vendor.ChatOpenAI);
  console.log('[agent] getName:', typeof model.getName === 'function' ? model.getName() : 'N/A');

  const userProfile = loadUserProfile();
  const memory = loadMemory();
  const checkpointer = new MemorySaver();

  const backend = new FilesystemBackend({ rootDir: getDataDir() });

  const parts = [];
  if (userProfile) { parts.push(userProfile); parts.push('---'); }
  if (memory) { parts.push(memory); parts.push('---'); }
  if (opts.extraSystemPrompt) { parts.push(opts.extraSystemPrompt); parts.push('---'); }
  parts.push(SKILLS_GUIDANCE);
  parts.push('---');
  parts.push('You are a helpful assistant.');

  // 获取技能工具
  const { getSkillManage } = require('./tools/skill-manage.js');
  const { getSkillsTools } = require('./tools/skills-discovery.js');
  const skillManage = await getSkillManage();
  const { skillsList, skillView } = await getSkillsTools();

  const baseTools = [skillManage, skillsList, skillView];
  const tools = opts.extraTools
    ? [...baseTools, ...opts.extraTools]
    : baseTools;

  // 获取中间件
  const hermesMiddleware = await createHermesMiddleware();

  return createDeepAgent({
    model,
    systemPrompt: parts.join('\n\n'),
    tools,
    middleware: [hermesMiddleware],
    skills: [getSkillsDir()],
    backend,
    checkpointer,
  });
}

// ── 备忘录 Agent：基座 + 领域工具 ──
async function createMemoAgent() {
  const { getMemoTools } = require('./tools/memo.js');
  const { getGlossaryTools } = require('./modules/glossary.js');
  const { getExportTools } = require('./modules/export.js');

  const { memoSave, memoSearch, memoList, memoDelete, memoUpdateStatus } = await getMemoTools();
  const { glossaryAdd, glossaryList, glossaryRemove } = await getGlossaryTools();
  const { exportGlossary, exportSkills, exportAll, importGlossary } = await getExportTools();

  // 知识库搜索工具
  const { tool } = vendor;
  const knowledgeSearch = tool(
    async ({ query }) => {
      const db = require('./db/index.js');
      const path = require('path');
      const DATA_DIR = require('./paths.js').getDataDir();
      const kdb = db.openDb(path.join(DATA_DIR, 'knowledge.db'), { readonly: true });
      kdb.exec('CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT DEFAULT "", linked_memo_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
      const rows = kdb.prepare("SELECT id, title, content, tags, linked_memo_id FROM knowledge WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 5")
        .all('%'+query+'%', '%'+query+'%', '%'+query+'%');
      kdb.close();
      if (!rows.length) return '知识库中没有找到相关内容。';
      return rows.map((r, i) => `${i+1}. [${r.title}] ${r.content.slice(0, 200)}`).join('\n\n');
    },
    {
      name: 'knowledge_search',
      description: '搜索知识库：查找用户保存的操作流程、注意事项、经验。当任务涉及复杂流程或用户提到"之前怎么做的"时使用。',
      schema: vendor.z.object({ query: vendor.z.string().describe('搜索关键词') }),
    }
  );

  return createHermesAgent({
    extraSystemPrompt: [
      '## 备忘录功能',
      '你是智能备忘录助手。可用工具：',
      'memo: save/search/list/delete/update_status',
      'glossary: add/list/remove（术语修正词典）',
      'export: glossary/skills/memos/all（导出）+ import_glossary/import_memos（导入）',
            'knowledge: search（搜索知识库中的操作流程、注意事项）',
            '当用户提到记东西、备忘、笔记、任务、术语修正、导出导入、知识库等关键词时主动使用。当任务复杂时先搜索知识库看有没有相关经验。',
          ].join('\\n'),
          extraTools: [
            memoSave, memoSearch, memoList, memoDelete, memoUpdateStatus,
            glossaryAdd, glossaryList, glossaryRemove,
            exportGlossary, exportSkills, exportAll, importGlossary,
            knowledgeSearch,
          ],
  });
}

module.exports = { createHermesAgent, createMemoAgent };