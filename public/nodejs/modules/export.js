const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * 导出模块
 *
 * 7个导出/导入工具：
 *   export_glossary / export_skills / export_feedback / export_memos / export_all
 *   import_glossary / import_memos
 *
 * 将术语词典、技能、修正记录、备忘录等导出为可分享的 JSON 格式。
 */

const fs = require('fs');
const path = require('path');
const { z } = require('../vendor.bundle.js');
const { openDb } = require('../db/index.js');

const DATA_DIR = getDataDir();
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const SKILLS_DIR = getSkillsDir();

// ════════════════════════════════════
// 导出术语词典
// ════════════════════════════════════
async function makeExportTools() {
  const vendor = require('../vendor.bundle.js'); const { tool } = vendor;

  const exportGlossary = tool(
    async () => {
      const glossaryDb = openDb(path.join(DATA_DIR, 'glossary.db'), { readonly: true });
      const terms = glossaryDb
        .prepare('SELECT wrong_term, correct_term, count, source FROM glossary_terms ORDER BY count DESC')
        .all();
      glossaryDb.close();

      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const filePath = path.join(EXPORT_DIR, 'glossary.json');

      const output = {
        exported_at: new Date().toISOString(),
        type: 'glossary',
        version: '1.0',
        terms: terms.map((t) => ({
          wrong: t.wrong_term,
          correct: t.correct_term,
          usage_count: t.count,
          source: t.source,
        })),
      };

      fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');
      return JSON.stringify({
        file: 'data/exports/glossary.json',
        term_count: output.terms.length,
        message: `已导出 ${output.terms.length} 条术语到 data/exports/glossary.json`,
      });
    },
    {
      name: 'export_glossary',
      description: '导出术语词典为 JSON。可分享给其他人导入使用。',
      schema: z.object({}),
    }
  );

  // ════════════════════════════════════
  // 导出技能包
  // ════════════════════════════════════
  const exportSkills = tool(
    async () => {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const skillsExportDir = path.join(EXPORT_DIR, 'skills');
      fs.rmSync(skillsExportDir, { recursive: true, force: true });
      fs.mkdirSync(skillsExportDir, { recursive: true });

      const files = [];
      if (fs.existsSync(SKILLS_DIR)) {
        const walk = (dir, prefix = '') => {
          for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            const rel = prefix ? `${prefix}/${entry}` : entry;
            if (fs.statSync(full).isDirectory()) {
              walk(full, rel);
            } else if (entry.endsWith('.md') || entry.endsWith('.yaml') || entry.endsWith('.json')) {
              const dest = path.join(skillsExportDir, rel);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.copyFileSync(full, dest);
              files.push(rel);
            }
          }
        };
        walk(SKILLS_DIR);
      }

      const index = files.filter((f) => f.endsWith('.md')).map((f) => ({
        file: f,
        name: f.replace(/\.md$/, '').replace(/\//g, '/'),
      }));

      fs.writeFileSync(
        path.join(skillsExportDir, 'index.json'),
        JSON.stringify({ exported_at: new Date().toISOString(), skills: index }, null, 2)
      );

      return JSON.stringify({
        dir: 'data/exports/skills/',
        skill_count: index.length,
        files,
        message: `已导出 ${index.length} 个技能到 data/exports/skills/`,
        usage: '复制 data/exports/skills/ 目录到目标项目的 data/skills/ 即可使用',
      });
    },
    {
      name: 'export_skills',
      description: '导出所有技能文件。生成 index.json 索引供其他人参考。',
      schema: z.object({}),
    }
  );

  // ════════════════════════════════════
  // 导出修正记录
  // ════════════════════════════════════
  const exportFeedback = tool(
    async () => {
      const feedbackDb = openDb(path.join(DATA_DIR, 'feedback.db'), { readonly: true });
      const corrections = feedbackDb
        .prepare(
          `SELECT c.original, c.corrected, c.created_at,
                  tc.wrong_term, tc.correct_term, tc.count
           FROM corrections c
           LEFT JOIN term_corrections tc ON 1=0
           ORDER BY c.created_at DESC LIMIT 200`
        )
        .all();
      feedbackDb.close();

      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const filePath = path.join(EXPORT_DIR, 'feedback-corrections.json');

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            exported_at: new Date().toISOString(),
            type: 'feedback',
            corrections: corrections.map((c) => ({
              original: c.original,
              corrected: c.corrected,
              when: c.created_at,
            })),
          },
          null,
          2
        ),
        'utf-8'
      );

      return JSON.stringify({
        file: 'data/exports/feedback-corrections.json',
        count: corrections.length,
        message: `已导出 ${corrections.length} 条修正记录`,
      });
    },
    {
      name: 'export_feedback',
      description: '导出修正学习记录。可用于分析或分享给同领域用户。',
      schema: z.object({}),
    }
  );

  // ════════════════════════════════════
  // 导出备忘录
  // ════════════════════════════════════
  const exportMemos = tool(
    async ({ include_done = true }) => {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      let sql = 'SELECT * FROM memos WHERE 1=1';
      if (!include_done) sql += " AND status != 'done'";
      sql += ' ORDER BY updated_at DESC';

      let rows = [];
      try {
        const memoDb = openDb(path.join(DATA_DIR, 'memos.db'), { readonly: true });
        rows = memoDb.prepare(sql).all();
        memoDb.close();
      } catch {
        return JSON.stringify({ message: '没有备忘录数据可导出（memos.db 不存在或为空）' });
      }

      const items = rows.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        tags: r.tags ? r.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        location: r.location || '',
        due_date: r.due_date || '',
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      const filePath = path.join(EXPORT_DIR, 'memos.json');
      fs.writeFileSync(filePath, JSON.stringify({
        exported_at: new Date().toISOString(),
        type: 'memos',
        include_done,
        items,
        count: items.length,
      }, null, 2), 'utf-8');

      return JSON.stringify({
        file: 'data/exports/memos.json',
        count: items.length,
        include_done,
        message: `已导出 ${items.length} 条备忘录${include_done ? '（含已完成）' : '（仅活跃）'}`,
      });
    },
    {
      name: 'export_memos',
      description: '导出备忘录笔记。默认包含已完成的任务，可设置只导出活跃任务。',
      schema: z.object({
        include_done: z.boolean().optional().default(true).describe('是否包含已完成任务'),
      }),
    }
  );

  // ════════════════════════════════════
  // 一键全量导出
  // ════════════════════════════════════
  const exportAll = tool(
    async ({ glossary = true, skills = true, feedback = true, memos = true, memo_include_done = true }) => {
      const results = [];
      const contents = [];

      if (glossary) {
        try {
          const r1 = await exportGlossary.invoke({});
          results.push(JSON.parse(r1).message);
          contents.push('glossary.json');
        } catch (e) { results.push(`术语导出失败: ${e.message}`); }
      }

      if (skills) {
        try {
          const r2 = await exportSkills.invoke({});
          results.push(JSON.parse(r2).message);
          contents.push('skills/');
        } catch (e) { results.push(`技能导出失败: ${e.message}`); }
      }

      if (feedback) {
        try {
          const r3 = await exportFeedback.invoke({});
          results.push(JSON.parse(r3).message);
          contents.push('feedback-corrections.json');
        } catch (e) { results.push(`修正导出失败: ${e.message}`); }
      }

      if (memos) {
        try {
          const r4 = await exportMemos.invoke({ include_done: memo_include_done });
          results.push(JSON.parse(r4).message);
          contents.push('memos.json');
        } catch (e) { results.push(`备忘录导出失败: ${e.message}`); }
      }

      const manifest = {
        exported_at: new Date().toISOString(),
        contents,
        install: '复制 data/exports/ 下的文件到目标项目的 data/ 目录，重启。术语用 import_glossary 导入，备忘录用 import_memos 导入。',
      };
      fs.writeFileSync(path.join(EXPORT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

      return JSON.stringify({ dir: 'data/exports/', results, manifest: 'data/exports/manifest.json' });
    },
    {
      name: 'export_all',
      description: '一键导出。可选：glossary/skills/feedback/memos（默认全选）。memo_include_done 控制是否含已完成笔记。',
      schema: z.object({
        glossary: z.boolean().optional().default(true),
        skills: z.boolean().optional().default(true),
        feedback: z.boolean().optional().default(true),
        memos: z.boolean().optional().default(true),
        memo_include_done: z.boolean().optional().default(true),
      }),
    }
  );

  // ════════════════════════════════════
  // 导入术语词典
  // ════════════════════════════════════
  const importGlossary = tool(
    async ({ file_path }) => {
      const fullPath = path.resolve(file_path);
      if (!fs.existsSync(fullPath)) {
        return JSON.stringify({ error: `文件不存在: ${file_path}` });
      }

      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);

      if (!data.terms || !Array.isArray(data.terms)) {
        return JSON.stringify({ error: '格式错误：需要 { terms: [...] } 结构' });
      }

      const glossaryDb = openDb(path.join(DATA_DIR, 'glossary.db'));
      let added = 0;
      for (const t of data.terms) {
        if (t.wrong && t.correct) {
          glossaryDb
            .prepare(
              "INSERT OR IGNORE INTO glossary_terms (wrong_term, correct_term, count, source, created_at) VALUES (?, ?, ?, 'imported', ?)"
            )
            .run(t.wrong, t.correct, t.usage_count || 1, new Date().toISOString().replace('T', ' ').slice(0, 19));
          added++;
        }
      }
      glossaryDb.close();

      return JSON.stringify({
        imported: added,
        skipped: data.terms.length - added,
        message: `已导入 ${added} 条术语`,
      });
    },
    {
      name: 'import_glossary',
      description: '从 JSON 文件导入术语词典。接收其他人分享的 data/exports/glossary.json。',
      schema: z.object({
        file_path: z.string().describe('术语词典 JSON 文件路径'),
      }),
    }
  );

  // ════════════════════════════════════
  // 导入备忘录
  // ════════════════════════════════════
  const importMemos = tool(
    async ({ file_path }) => {
      const fullPath = path.resolve(file_path);
      if (!fs.existsSync(fullPath)) {
        return JSON.stringify({ error: `文件不存在: ${file_path}` });
      }
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.items || !Array.isArray(data.items)) {
        return JSON.stringify({ error: '格式错误：需要 { items: [...] } 结构' });
      }

      const { getMemoTools } = require('../tools/memo.js');
      const { memoSave } = await getMemoTools();
      let imported = 0, skipped = 0;
      for (const item of data.items) {
        if (!item.title || !item.content) { skipped++; continue; }
        try {
          await memoSave.invoke({
            title: item.title, content: item.content,
            tags: item.tags || [], location: item.location || '',
            due_date: item.due_date || '',
          });
          imported++;
        } catch { skipped++; }
      }
      return JSON.stringify({ imported, skipped, message: `已导入 ${imported} 条（跳过 ${skipped} 条）` });
    },
    {
      name: 'import_memos',
      description: '从 JSON 文件导入备忘录。接收 data/exports/memos.json。',
      schema: z.object({
        file_path: z.string().describe('备忘录 JSON 文件路径'),
      }),
    }
  );

  return { exportGlossary, exportSkills, exportFeedback, exportMemos, exportAll, importGlossary, importMemos };
}

// 延迟初始化
let _cache = null;
async function getExportTools() {
  if (!_cache) _cache = await makeExportTools();
  return _cache;
}

module.exports = { getExportTools };