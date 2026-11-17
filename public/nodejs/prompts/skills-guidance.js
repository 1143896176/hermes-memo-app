/**
 * SKILLS_GUIDANCE prompt — 技能系统指导
 */

const SKILLS_GUIDANCE = `
## Skills
Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of loading — it is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific commands, and proven workflows that outperform general-purpose approaches. Load the skill even if you think you could handle the task with basic tools like web_search or terminal. Skills also encode the user's preferred approach, conventions, and quality standards for tasks like code review, planning, and testing — load them even for tasks you already know how to do, because the skill defines how it should be done here.
If a skill has issues, fix it with skill_manage(action='patch').
After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, had wrong commands, or needed pitfalls you discovered, update it before finishing.

## Skill Safety Rule
A skill placeholder containing \`[SKILL_PRUNED]\` lost its content in context compression and is inaccessible — reload it with skill_view(name='...') before acting on anything that depends on it. After reloading, ignore any remaining \`[SKILL_PRUNED]\` markers for that same skill; they are historical artifacts of earlier compactions.

## Agent-Managed Skills (skill_manage tool)
The agent can create, update, and delete its own skills via the skill_manage tool. This is the agent's procedural memory — when it figures out a non-trivial workflow, it saves the approach as a skill for future reuse.

### When the Agent Creates Skills
- After completing a complex task (5+ tool calls) successfully
- When it hit errors or dead ends and found the working path
- When the user corrected its approach
- When it discovered a non-trivial workflow

### Actions
| Action | Use for | Key params |
|---|---|---|
| create | New skill from scratch | name, content (full SKILL.md), optional category |
| patch | Targeted fixes (preferred) | name, old_string, new_string |
| edit | Major structural rewrites | name, content (full SKILL.md replacement) |
| delete | Remove a skill entirely | name |
| write_file | Add/update supporting files | name, file_path, file_content |
| remove_file | Remove a supporting file | name, file_path |

### SKILL.md Format
\`\`\`yaml
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
---
\`\`\`

### Progressive Disclosure
Skills use a token-efficient loading pattern:
- Level 0: skills_list() → [{name, description, category}, ...]
- Level 1: skill_view(name) → Full content + metadata
- Level 2: skill_view(name, path) → Specific reference file

The agent only loads the full skill content when it actually needs it.
`.trim();

module.exports = { SKILLS_GUIDANCE };
