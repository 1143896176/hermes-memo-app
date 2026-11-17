import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({
      include: ['process', 'buffer', 'util', 'crypto', 'stream', 'events', 'path', 'url'],
      globals: { process: true, Buffer: true, global: true },
    }),
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