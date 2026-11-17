const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * skill_manage 工具 — 完整 6 action
 *
 * create / patch / edit / delete / write_file / remove_file
 *
 * 技能是保存在 data/skills/ 目录下的 .md 文件（SKILL.md 格式），
 * 用于记录经过验证的工作流程以便未来复用。
 */

const fs = require('fs');
const path = require('path');
const { z } = require('../vendor.bundle.js');

const SKILLS_DIR = getSkillsDir();

/**
 * 创建 langchain tool（兼容 CommonJS 动态 import）
 */
async function makeTool() {
  const vendor = require('../vendor.bundle.js'); const { tool } = vendor;

  const skillManage = tool(
    async ({ action, name, content, old_string, new_string, category, file_path, file_content }) => {
      const dir = category
        ? path.join(SKILLS_DIR, category)
        : SKILLS_DIR;
      const filePath = path.join(dir, `${name}.md`);

      switch (action) {
        case 'create': {
          if (!content) {
            return '错误: create 操作需要提供 content 参数';
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, content, 'utf-8');
          const location = category ? `data/skills/${category}/${name}.md` : `data/skills/${name}.md`;
          return `技能已创建: ${location}`;
        }

        case 'patch': {
          if (old_string === undefined || new_string === undefined) {
            return '错误: patch 操作需要提供 old_string 和 new_string 参数';
          }
          if (!fs.existsSync(filePath)) {
            return `错误: 技能文件不存在: ${name}`;
          }
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const index = fileContent.indexOf(old_string);
          if (index === -1) {
            return `错误: 在技能文件中未找到指定的原文片段: ${name}`;
          }
          const updatedContent = fileContent.replace(old_string, new_string);
          fs.writeFileSync(filePath, updatedContent, 'utf-8');
          return `技能已更新: ${name}`;
        }

        case 'edit': {
          if (!content) {
            return '错误: edit 操作需要提供 content 参数';
          }
          if (!fs.existsSync(filePath)) {
            return `错误: 技能文件不存在: ${name}`;
          }
          fs.writeFileSync(filePath, content, 'utf-8');
          return `技能已完整重写: ${name}`;
        }

        case 'delete': {
          // 用 findSkill 定位文件（可能在子目录）
          const { findSkill } = require('./skills-discovery.js');
          const found = findSkill(name);
          if (!found) return `错误: 技能不存在: ${name}`;
          fs.unlinkSync(found.filePath);
          // 如果技能目录为空，一起删掉
          try {
            const dir = path.dirname(found.filePath);
            if (dir !== SKILLS_DIR && fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch {}
          return `技能已删除: ${name}`;
        }

        case 'write_file': {
          if (!file_path || file_content === undefined) {
            return '错误: write_file 操作需要提供 file_path 和 file_content 参数';
          }
          const skillDir = path.join(dir, name);
          const targetPath = path.join(skillDir, file_path);
          if (!targetPath.startsWith(path.resolve(skillDir))) {
            return '错误: 文件路径不得超出技能目录范围';
          }
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, file_content, 'utf-8');
          return `附属文件已写入: data/skills/${category ? category + '/' : ''}${name}/${file_path}`;
        }

        case 'remove_file': {
          if (!file_path) {
            return '错误: remove_file 操作需要提供 file_path 参数';
          }
          const skillDir = path.join(dir, name);
          const targetPath = path.join(skillDir, file_path);
          if (!targetPath.startsWith(path.resolve(skillDir))) {
            return '错误: 文件路径不得超出技能目录范围';
          }
          if (!fs.existsSync(targetPath)) {
            return `错误: 附属文件不存在: ${name}/${file_path}`;
          }
          fs.unlinkSync(targetPath);
          return `附属文件已删除: data/skills/${category ? category + '/' : ''}${name}/${file_path}`;
        }

        default:
          return `错误: 未知操作 ${action}`;
      }
    },
    {
      name: 'skill_manage',
      description:
        '创建、修补或删除技能。技能是保存在 data/skills/ 目录下的 SKILL.md 文件，用于记录经过验证的工作流程以便未来复用。',
      schema: z.object({
        action: z.enum(['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file']).describe('操作类型'),
        name: z.string().describe("技能名称（kebab-case，如 'my-workflow'）"),
        content: z.string().optional().describe('完整 SKILL.md 内容（create/edit 时必填）'),
        old_string: z.string().optional().describe('要替换的原文片段（patch 时必填）'),
        new_string: z.string().optional().describe('替换后的新文本（patch 时必填，空字符串表示删除）'),
        category: z.string().optional().describe("可选分类子目录（如 'memo'），技能将存入 data/skills/{category}/{name}.md"),
        file_path: z.string().optional().describe('附属文件相对路径（write_file/remove_file 时必填）'),
        file_content: z.string().optional().describe('附属文件内容（write_file 时必填）'),
      }),
    }
  );

  return skillManage;
}

// 延迟初始化
let _skillManage = null;
async function getSkillManage() {
  if (!_skillManage) _skillManage = await makeTool();
  return _skillManage;
}

module.exports = { getSkillManage, SKILLS_DIR };