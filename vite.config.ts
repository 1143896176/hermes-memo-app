import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 剔除 public/nodejs 里的构建期文件。
 *
 * public/ 会被原样拷进 dist，而这些文件只在开发机上有意义：
 *   vendor.bundle.mjs  —— build-bundle.js 顺带产出的 ESM 版本，运行时
 *                         只 require('./vendor.bundle.js')，这个 5.9MB 是纯冗余
 *   build-bundle.js    —— 打包脚本本身
 *   package-lock.json  —— vendor 依赖的锁文件
 *
 * 三者都会被 cap sync 原样塞进 APK/IPA。iOS 的包体直接计入 App 体积和
 * 下载时间，白扔 5.9MB 不合适；顺手也让原生工程里少一个引用 child_process
 * 的脚本文件。
 */
function pruneNodeRuntime(): Plugin {
  const DEAD_FILES = [
    'nodejs/vendor.bundle.mjs',
    'nodejs/build-bundle.js',
    'nodejs/package-lock.json',
  ]
  return {
    name: 'hermes:prune-node-runtime',
    apply: 'build',
    async closeBundle() {
      for (const rel of DEAD_FILES) {
        await rm(join('dist', rel), { force: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({
      include: ['process', 'buffer', 'util', 'crypto', 'stream', 'events', 'path', 'url'],
      globals: { process: true, Buffer: true, global: true },
    }),
    pruneNodeRuntime(),
  ],
  base: './',
  build: { outDir: 'dist' },
  resolve: {
    alias: {
      // LangChain 引用 node:async_hooks，浏览器无此模块，用本地 polyfill
      'node:async_hooks': fileURLToPath(new URL('./src/polyfills/async-hooks.ts', import.meta.url)),
    },
  },
})
