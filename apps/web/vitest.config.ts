import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const webDir = import.meta.dirname

/**
 * 前端测试 project（name: client）—— jsdom 环境，测 src/ 下的代码（apps/web/src/test/**）。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：
 * 在根目录 `pnpm test:client`（= vitest run --project=client）单独跑。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': path.join(webDir, 'src') },
  },
  test: {
    name: 'client',
    root: webDir,
    environment: 'jsdom',
    include: ['src/test/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
})
