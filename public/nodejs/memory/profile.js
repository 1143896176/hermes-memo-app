const { getDataDir, getSkillsDir, getExportsDir } = require('../paths.js')
/**
 * 记忆 / 用户档案加载
 *
 * 从 data/MEMORY.md 和 data/USER.md 加载文本。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = getDataDir();

function loadMemory() {
  const memoryPath = path.join(DATA_DIR, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return '';
  return fs.readFileSync(memoryPath, 'utf-8').trim();
}

function loadUserProfile() {
  const profilePath = path.join(DATA_DIR, 'USER.md');
  if (!fs.existsSync(profilePath)) return '';
  return fs.readFileSync(profilePath, 'utf-8').trim();
}

module.exports = { loadMemory, loadUserProfile };
