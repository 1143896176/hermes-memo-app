const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * skills_list / skill_view 工具 — 技能发现与加载
 *
 * 渐进式披露：
 *   Level 0: skills_list() → [{name, description, category}, ...]
 *   Level 1: skill_view(name) → 完整内容 + metadata
 *   Level 2: skill_view(name, file_path) → 附属文件内容
 */

const fs = require('fs');
const path = require('path');
const { z } = require('../vendor.bundle.js');

const SKILLS_DIR = getSkillsDir();

// ── YAML frontmatter 解析（轻量，不引入 yaml 依赖）──
function parseFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
    if (!match) return null;
    const yamlText = match[1];
    const body = (match[2] || '').trim();
    const meta = {};
    for (const line of yamlText.split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        meta[m[1]] = val;
      }
    }
    if (!meta.name) return null;
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      content: body,
    };
  } catch {
    return null;
  }
}

// ── 递归扫描 skills 目录 ──
function walkSkills() {
  const results = [];
  if (!fs.existsSync(SKILLS_DIR)) return results;

  const walk = (dir, relativeDir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, relativeDir ? `${relativeDir}/${entry}` : entry);
      } else if (entry.endsWith('.md') && entry !== 'SKILL.md') {
        const meta = parseFrontmatter(full);
        if (meta) {
          meta.category = relativeDir || undefined;
          results.push({ meta, filePath: full, relativeDir });
        }
      }
    }
  };

  // Level 0: 根目录下的 .md 文件是技能
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const full = path.join(SKILLS_DIR, entry);
    if (entry === '.gitkeep') continue;
    if (fs.statSync(full).isDirectory()) {
      walk(full, entry);
    } else if (entry.endsWith('.md')) {
      const meta = parseFrontmatter(full);
      if (meta) {
        results.push({ meta, filePath: full, relativeDir: '' });
      }
    }
  }

  return results;
}

// ── 按名称查找技能文件 ──
function findSkill(name) {
  const skills = walkSkills();
  const match = skills.find((s) => s.meta.name === name);
  if (match) {
    return { filePath: match.filePath, category: match.relativeDir };
  }
  // 回退：按文件名查找
  const directPath = path.join(SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(directPath)) {
    return { filePath: directPath, category: '' };
  }
  // 回退：在所有目录查找
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walkDir(full);
        if (found) return found;
      } else if (entry.name === `${name}.md`) {
        return full;
      }
    }
    return null;
  };
  const found = walkDir(SKILLS_DIR);
  if (found) {
    return { filePath: found, category: path.relative(SKILLS_DIR, path.dirname(found)) };
  }
  return null;
}

// ════════════════════════════════════
// 工具定义
// ════════════════════════════════════

async function makeTools() {
  const vendor = require('../vendor.bundle.js'); const { tool } = vendor;

  const skillsList = tool(
    async () => {
      const skills = walkSkills();
      if (skills.length === 0) {
        return JSON.stringify({ skills: [], count: 0 });
      }
      const list = skills.map((s) => ({
        name: s.meta.name,
        description: s.meta.description || '',
        category: s.meta.category || null,
      }));
      return JSON.stringify({ skills: list, count: list.length });
    },
    {
      name: 'skills_list',
      description:
        '列出所有可用技能，返回技能名、描述和分类。用于渐进式披露——先列清单，再按需加载具体技能内容。',
      schema: z.object({}),
    }
  );

  const skillView = tool(
    async ({ name, file_path }) => {
      const skill = findSkill(name);
      if (!skill) {
        return JSON.stringify({
          error: `技能 '${name}' 未找到。可用 skills_list 查看所有技能。`,
        });
      }

      if (file_path) {
        // Level 2: 获取技能附属文件
        const skillDir = path.dirname(skill.filePath);
        const targetPath = path.join(skillDir, file_path);
        if (!targetPath.startsWith(path.resolve(skillDir))) {
          return JSON.stringify({ error: '文件路径不得超出技能目录范围' });
        }
        if (!fs.existsSync(targetPath)) {
          return JSON.stringify({
            error: `附属文件不存在: ${name}/${file_path}`,
          });
        }
        const content = fs.readFileSync(targetPath, 'utf-8');
        return JSON.stringify({
          name,
          file_path,
          content,
        });
      }

      // Level 1: 返回完整内容 + linked_files 列表
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const skillDir = path.dirname(skill.filePath);

      // 列出附属文件（references/, templates/, scripts/, assets/）
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

      return JSON.stringify({
        name,
        content,
        linked_files: linkedFiles.length > 0 ? linkedFiles : undefined,
      });
    },
    {
      name: 'skill_view',
      description:
        '加载技能完整内容。不加 file_path 返回 SKILL.md 全文及附属文件列表；加 file_path 返回指定附属文件内容（references/templates/scripts/assets）。支持渐进式披露：先用 skills_list 发现技能，再用 skill_view 按需加载。',
      schema: z.object({
        name: z.string().describe("技能名称（如 'hello-world'）"),
        file_path: z
          .string()
          .optional()
          .describe(
            "可选：附属文件相对路径（如 'references/api.md'），不传则返回 SKILL.md 正文"
          ),
      }),
    }
  );

  return { skillsList, skillView };
}

// 延迟初始化
let _cache = null;
async function getSkillsTools() {
  if (!_cache) _cache = await makeTools();
  return _cache;
}

module.exports = { getSkillsTools, walkSkills, findSkill, SKILLS_DIR };