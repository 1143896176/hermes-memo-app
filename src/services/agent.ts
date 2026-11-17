/**
 * Hermes Memo Agent — 浏览器内运行的 DeepAgents 架构
 *
 * 这是项目的"灵魂"——从 hermes-ts 移植过来的 Agent 框架。
 * 全部跑在 WebView 内：
 * - deepagents/browser（StateBackend，无文件系统依赖）
 * - @langchain/openai（ChatOpenAI，baseURL 用用户配置的 API）
 * - @langchain/langgraph（MemorySaver，会话内记忆）
 * - 工具：skill 管理 + 备忘录 CRUD + glossary + 导出
 *
 * 与 hermes-ts 的差异：
 * - FilesystemBackend → StateBackend（浏览器无 fs）
 * - FTS5 → JS 倒排索引（sql.js 不含 FTS5）
 * - 多 .db 文件 → 单 sql.js 库（持久化到 IndexedDB）
 * - skills 从磁盘 .md 文件 → SQLite skills 表
 */

import { createDeepAgent, StateBackend, type DeepAgent } from 'deepagents/browser'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { getApiConfig, getMemoryProfile, listSkills, saveSkill, getSkill, deleteSkill } from './engine'

// ═══════════════════════════
// Skills Guidance（移植自 hermes-ts）
// ═══════════════════════════

export const SKILLS_GUIDANCE = `
## Skills
Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of loading — it is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific commands, and proven workflows that outperform general-purpose approaches.

## Agent-Managed Skills (skill_manage tool)
The agent can create, update, and delete its own skills via the skill_manage tool. This is the agent's procedural memory — when it figures out a non-trivial workflow, it saves the approach as a skill for future reuse.

### Actions
| Action | Use for | Key params |
|---|---|---|
| create | New skill from scratch | name, content |
| patch | Targeted fixes (preferred) | name, old_string, new_string |
| edit | Major structural rewrites | name, content |
| delete | Remove a skill entirely | name |

### Progressive Disclosure
- Level 0: skills_list() → [{name, content}]
- Level 1: skill_view(name) → Full content
`.trim()

// ═══════════════════════════
// Skill 管理工具
// ═══════════════════════════

const skillsListTool = tool(
  async () => {
    const { skills } = await listSkills()
    return JSON.stringify(skills.map((s: any) => ({ name: s.name, content: s.content.slice(0, 80) })))
  },
  {
    name: 'skills_list',
    description: '列出所有已保存的技能（渐进式披露 Level 0）',
    schema: z.object({}),
  }
)

const skillViewTool = tool(
  async ({ name }) => {
    const s = await getSkill(name)
    if (!s) return JSON.stringify({ error: 'skill not found' })
    return JSON.stringify(s)
  },
  {
    name: 'skill_view',
    description: '查看指定技能的完整内容（渐进式披露 Level 1）',
    schema: z.object({ name: z.string().describe('技能名称') }),
  }
)

const skillManageTool = tool(
  async ({ action, name, content, old_string, new_string }) => {
    switch (action) {
      case 'create':
      case 'edit':
        if (!content) return JSON.stringify({ error: 'content required for create/edit' })
        await saveSkill(name, content)
        return JSON.stringify({ success: true, action, name })
      case 'delete':
        await deleteSkill(name)
        return JSON.stringify({ success: true, action, name })
      case 'patch': {
        if (!old_string || !new_string) return JSON.stringify({ error: 'old_string and new_string required for patch' })
        const s = await getSkill(name)
        if (!s) return JSON.stringify({ error: 'skill not found' })
        const newContent = (s.content || '').replace(old_string, new_string)
        await saveSkill(name, newContent)
        return JSON.stringify({ success: true, action, name })
      }
      default:
        return JSON.stringify({ error: 'unknown action: ' + action })
    }
  },
  {
    name: 'skill_manage',
    description: '管理技能：create/edit/delete/patch',
    schema: z.object({
      action: z.enum(['create', 'edit', 'delete', 'patch']).describe('操作类型'),
      name: z.string().describe('技能名称'),
      content: z.string().optional().describe('完整内容（create/edit 必填）'),
      old_string: z.string().optional().describe('待替换文本（patch 必填）'),
      new_string: z.string().optional().describe('替换为的文本（patch 必填）'),
    }),
  }
)

// ═══════════════════════════
// 备忘录工具（直接复用 engine 函数）
// ═══════════════════════════

// 延迟导入避免循环依赖
async function loadEngine() {
  return await import('./engine')
}

const memoSaveTool = tool(
  async ({ title, content, tags, location, due_date, event }) => {
    const eng = await loadEngine()
    const r = await eng.saveMemo({ title, content, tags: tags || [], location, due_date, event })
    return JSON.stringify(r)
  },
  {
    name: 'memo_save',
    description: '保存一条备忘录。必填 title 和 content。',
    schema: z.object({
      title: z.string().describe('标题'),
      content: z.string().describe('内容'),
      tags: z.array(z.string()).optional().describe('标签数组'),
      location: z.string().optional().describe('地点'),
      due_date: z.string().optional().describe('截止时间 YYYY-MM-DD HH:mm'),
      event: z.string().optional().describe('事件名'),
    }),
  }
)

const memoListTool = tool(
  async ({ status, location, tag, limit }) => {
    const eng = await loadEngine()
    const params: Record<string, string> = {}
    if (status) params.status = status
    if (location) params.location = location
    if (tag) params.tag = tag
    if (limit) params.limit = String(limit)
    const r = await eng.fetchMemos(params)
    return JSON.stringify(r)
  },
  {
    name: 'memo_list',
    description: '列出备忘录，支持按状态/地点/标签过滤',
    schema: z.object({
      status: z.string().optional().describe('active/done/all'),
      location: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().optional().default(50),
    }),
  }
)

const memoSearchTool = tool(
  async ({ query, status }) => {
    const eng = await loadEngine()
    const r = await eng.searchMemos(query, status ? { status } : {})
    return JSON.stringify(r)
  },
  {
    name: 'memo_search',
    description: '全文搜索备忘录（标题/内容/标签/事件）',
    schema: z.object({
      query: z.string().describe('搜索关键词'),
      status: z.string().optional().describe('可选状态过滤'),
    }),
  }
)

const memoUpdateStatusTool = tool(
  async ({ id, status }) => {
    const eng = await loadEngine()
    const r = await eng.updateMemoStatus(id, status)
    return JSON.stringify(r)
  },
  {
    name: 'memo_update_status',
    description: '更新备忘录状态',
    schema: z.object({
      id: z.number(),
      status: z.string().describe('active 或 done'),
    }),
  }
)

const memoDeleteTool = tool(
  async ({ id }) => {
    const eng = await loadEngine()
    const r = await eng.deleteMemo(id)
    return JSON.stringify(r)
  },
  {
    name: 'memo_delete',
    description: '删除一条备忘录',
    schema: z.object({ id: z.number() }),
  }
)

// ═══════════════════════════
// Glossary 工具
// ═══════════════════════════

const glossaryListTool = tool(
  async () => {
    const eng = await loadEngine()
    const r = await eng.fetchGlossary()
    return JSON.stringify(r)
  },
  {
    name: 'glossary_list',
    description: '列出所有术语词典条目',
    schema: z.object({}),
  }
)

const glossaryAddTool = tool(
  async ({ wrong_term, correct_term }) => {
    const eng = await loadEngine()
    const r = await eng.addGlossary(wrong_term, correct_term)
    return JSON.stringify(r)
  },
  {
    name: 'glossary_add',
    description: '添加术语修正对（错词→正词）',
    schema: z.object({
      wrong_term: z.string(),
      correct_term: z.string(),
    }),
  }
)

const glossaryRemoveTool = tool(
  async ({ id }) => {
    const eng = await loadEngine()
    const r = await eng.removeGlossary(id)
    return JSON.stringify(r)
  },
  {
    name: 'glossary_remove',
    description: '删除一条术语词典',
    schema: z.object({ id: z.number() }),
  }
)

// ═══════════════════════════
// 知识库搜索工具
// ═══════════════════════════

const knowledgeSearchTool = tool(
  async ({ query }) => {
    const eng = await loadEngine()
    const items = await eng.searchKnowledge(query)
    if (!items.length) return '知识库中没有找到相关内容。'
    return items.map((r: any, i: number) => `${i+1}. [${r.title}] ${r.content.slice(0, 200)}`).join('\n\n')
  },
  {
    name: 'knowledge_search',
    description: '搜索知识库：查找用户保存的操作流程、注意事项、经验',
    schema: z.object({ query: z.string().describe('搜索关键词') }),
  }
)

// ═══════════════════════════
// 导出工具
// ═══════════════════════════

const exportTool = tool(
  async ({ include_done }) => {
    const eng = await loadEngine()
    const r = await eng.doExport('all', include_done)
    return JSON.stringify({ success: true, count: r.count, message: '已触发浏览器下载 JSON' })
  },
  {
    name: 'export_all',
    description: '导出全部数据（备忘录+词典+技能+记忆）为 JSON 文件并下载',
    schema: z.object({
      include_done: z.boolean().optional().default(true).describe('是否包含已完成的备忘录'),
    }),
  }
)

// ═══════════════════════════
// Agent 工厂
// ═══════════════════════════

let _agent: DeepAgent | null = null
let _agentKey = ''  // 用 Key+baseURL+model 做缓存键，配置变更时重建

export async function getMemoAgent(): Promise<DeepAgent> {
  const cfg = getApiConfig()
  const key = cfg.apiKey1 || cfg.apiKey2
  if (!key) {
    throw new Error('未配置 LLM API Key，请到 ⚙️ 设置中填写')
  }

  const cacheKey = `${key}|${cfg.apiBase}|${cfg.modelName}`
  if (_agent && cacheKey === _agentKey) return _agent

  // 加载 MEMORY.md / USER.md
  const profile = await getMemoryProfile()
  const parts: string[] = []
  if (profile.user.trim()) { parts.push('[用户画像]\n' + profile.user.trim()); parts.push('---') }
  if (profile.memory.trim()) { parts.push('[持久记忆]\n' + profile.memory.trim()); parts.push('---') }
  parts.push(SKILLS_GUIDANCE)
  parts.push('---')
  parts.push([
    '## 备忘录功能',
    '你是智能备忘录助手。可用工具：',
    '- memo: save/list/search/delete/update_status',
    '- glossary: add/list/remove（术语修正词典）',
    '- export_all: 导出全部数据',
    '- skill_manage / skills_list / skill_view: 技能管理',
    '当用户提到记东西、备忘、笔记、任务、术语修正、导出等关键词时主动使用工具。',
    '对于"明天下午3点去公司开会"这类输入，先用 memo_save 保存，必要时调用 glossary_add 记录术语。',
  ].join('\n'))

  const model = new ChatOpenAI({
    model: cfg.modelName,
    temperature: 0,
    configuration: {
      baseURL: cfg.apiBase,
      apiKey: key,
    },
  })

  const checkpointer = new MemorySaver()
  const backend = new StateBackend()

  const agent = createDeepAgent({
    model,
    systemPrompt: parts.join('\n\n'),
    tools: [
      skillsListTool, skillViewTool, skillManageTool,
      memoSaveTool, memoListTool, memoSearchTool, memoUpdateStatusTool, memoDeleteTool,
      glossaryListTool, glossaryAddTool, glossaryRemoveTool,
      knowledgeSearchTool, exportTool,
    ],
    backend,
    checkpointer,
  })

  _agent = agent
  _agentKey = cacheKey
  return agent
}

/** 配置变更时清缓存（SettingsPanel 保存后调用） */
export function invalidateAgent() {
  _agent = null
  _agentKey = ''
}

// ═══════════════════════════
// 对话入口（Agent 模式）
// ═══════════════════════════

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Agent 对话：用户文本 → Agent 自主决策调用哪些工具 → 最终回复
 * 这是与 hermes-ts 对齐的"灵魂"——Agent 框架自主决策，而非手工管线
 */
export async function chatWithAgent(
  text: string,
  threadId = 'memo-thread-default'
): Promise<string> {
  const agent = await getMemoAgent()
  const result = await agent.invoke(
    { messages: [{ role: 'user', content: text }] },
    { configurable: { thread_id: threadId } }
  )
  // 取最后一条 AI 消息
  const msgs = (result as any)?.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const t = m?._getType?.() || m?.type || ''
    if (t === 'ai' || t === 'assistant') {
      return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }
  }
  return '(Agent 无回复)'
}