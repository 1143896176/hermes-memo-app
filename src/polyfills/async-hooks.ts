// node:async_hooks 浏览器 polyfill
// LangChain 在浏览器环境引用了 AsyncLocalStorage，但浏览器没有原生的 node:async_hooks
// 这个 polyfill 提供一个最小可用的 AsyncLocalStorage（无异步上下文追踪，但不会崩溃）

export class AsyncLocalStorage {
  constructor() {
    this._store = undefined
  }
  enterWith(store) { this._store = store }
  exit(callback) {
    const old = this._store
    this._store = undefined
    try { return callback() } finally { this._store = old }
  }
  run(store, callback, ...args) {
    const old = this._store
    this._store = store
    try { return callback(...args) } finally { this._store = old }
  }
  getStore() { return this._store }
  disable() { this._store = undefined }
}

export function createHook() {
  return { enable() {}, disable() {} }
}

export function executionAsyncId() { return 0 }
export function executionAsyncResource() { return {} }
export function triggerAsyncId() { return 0 }

export default { AsyncLocalStorage, createHook, executionAsyncId, executionAsyncResource, triggerAsyncId }
