// 前端 Service 层 — 统一入口
// 原生环境（Android APK）：走 Node.js runtime（完整 hermes-ts：deepagents + FTS5 + 多.db + fs）
// 浏览器开发预览：走 engine.ts（sql.js + deepagents/browser 降级版）
// UI 组件只 import 这里，不直接 import engine 或 agent
export * from './node-bridge'
