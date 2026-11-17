/**
 * 中间件：hermesMiddleware
 *
 * beforeModel: 搜索 FTS5，暂存结果
 * wrapModelCall: 注入 FTS5 上下文
 * afterModel: 保存到 FTS5
 *
 * 在 CommonJS 中，langchain 的 createMiddleware / SystemMessage 通过动态 import 获取。
 */

const { fts5Store } = require('../memory/fts5.js');

let lastFts5Context = null;

/**
 * 创建 hermesMiddleware
 * 通过动态 import 获取 langchain 组件
 */
async function createHermesMiddleware() {
  const vendor = require('../vendor.bundle.js'); const { createMiddleware, SystemMessage } = vendor;

  const hermesMiddleware = createMiddleware({
    name: 'HermesMiddleware',

    // ── beforeModel: 搜索 FTS5，暂存结果 ──
    beforeModel: (state) => {
      const messages = state.messages;
      if (!messages || messages.length === 0) return;

      const lastUserMsg = [...messages]
        .reverse()
        .find((m) => typeof m.content === 'string' && m._getType() === 'human');
      if (!lastUserMsg || typeof lastUserMsg.content !== 'string') return;

      try {
        const results = fts5Store.search(lastUserMsg.content.trim(), 5);
        if (results.length > 0) {
          lastFts5Context = results
            .map((r) => `[历史 ${r.role}]: ${r.snippet}`)
            .join('\n');
        } else {
          lastFts5Context = null;
        }
      } catch {
        lastFts5Context = null;
      }
      return;
    },

    // ── wrapModelCall: 注入 FTS5 上下文 ──
    wrapModelCall: (request, handler) => {
      if (lastFts5Context) {
        const ctx =
          '[以下是从跨会话历史中检索的相关上下文。如果与当前问题相关请参考，不相关请忽略。]\n' +
          lastFts5Context +
          '\n[上下文结束]';
        lastFts5Context = null;
        // 注入到 messages 开头
        const ctxMsg = new SystemMessage(ctx);
        return handler({
          ...request,
          messages: [ctxMsg, ...request.messages],
        });
      }
      return handler(request);
    },

    // ── afterModel: 保存到 FTS5 ──
    afterModel: (state) => {
      const msgs = state.messages;
      if (!msgs || msgs.length < 2) return;

      const rev = [...msgs].reverse();
      const ai = rev.find((m) => m._getType() === 'ai');
      const user = rev.find(
        (m) => typeof m.content === 'string' && m._getType() === 'human'
      );
      if (!user || !ai || typeof user.content !== 'string' || typeof ai.content !== 'string') return;

      try {
        const sid = 's-' + Date.now().toString(36);
        fts5Store.createSession(sid);
        fts5Store.saveMessage(sid, 'user', user.content);
        fts5Store.saveMessage(sid, 'assistant', ai.content);
      } catch {}
      return;
    },
  });

  return hermesMiddleware;
}

module.exports = { createHermesMiddleware, fts5Store };