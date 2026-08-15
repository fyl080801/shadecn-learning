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
