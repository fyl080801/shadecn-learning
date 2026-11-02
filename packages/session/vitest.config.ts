import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * session 的测试 project —— Node 环境，SQLite 临时文件；设了 `PLATFORM_TEST_DATABASE_URL` 才连 PostgreSQL。
 * swc 转译的原因同 @learning/web。@learning/data-access、@learning/config 指向源码，跑测试不用先构建它们（`/testing` 必须排在主入口前面）。
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@learning/data-access': path.resolve(import.meta.dirname, '../data-access/src/index.ts'),
      '@learning/session/testing': path.resolve(import.meta.dirname, 'src/testing.ts'),
      '@learning/config/testing': path.resolve(import.meta.dirname, '../config/src/testing.ts'),
      '@learning/config': path.resolve(import.meta.dirname, '../config/src/index.ts'),
    },
  },
  test: {
    name: 'session',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
})
