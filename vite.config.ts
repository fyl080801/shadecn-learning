import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    /**
     * Yjs 全进程只能有一份。
     *
     * 我们的代码和 `@hocuspocus/provider` 各自 `import * as Y from 'yjs'`，
     * 而 Vite 的依赖预打包会把 yjs 一起打进 provider 的产物里 —— 于是浏览器里
     * 出现两个副本，控制台会喊 "Yjs was already imported"
     * （https://github.com/yjs/yjs/issues/438）。
     *
     * 这不只是告警：两份副本意味着两套类之间的 `instanceof` **永远为 false**，
     * 而 `src/lib/flow-doc.ts` 通篇靠 `value instanceof Y.Map` 判断节点结构 ——
     * 静默失效的话，画布会变成一张空图。
     * y-protocols 同理（awareness 也做 instanceof 检查）。
     */
    dedupe: ['yjs', 'y-protocols'],
  },
  build: {
    // 前端产物直接落进后端的静态资源目录：output/ 里就是一份完整可跑的东西
    outDir: path.resolve(__dirname, 'output/public'),
    emptyOutDir: true,
  },
})

// 注意：dev 时不再由 vite 自己起服务，而是被 server/frontend/dev.ts 以中间件模式挂到
// Node 后端上（`pnpm dev`），所以这里不需要 proxy —— /api、/ws 本来就同源同端口。
// 这份配置只剩两个用途：被 `vite build` 读取，以及被中间件模式的 createServer 读取。
