import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * data-access 的测试 project —— Node 环境，SQLite 临时文件；设了 `PLATFORM_TEST_DATABASE_URL` 才连 PostgreSQL（专用库，表会被重置）。
 * 根 vitest 用的 vite 7 走 esbuild，不输出 emitDecoratorMetadata，测试里的消费者类靠构造函数类型注入，所以用 swc 转译（同 @learning/web）。
 * 同一个 PG 库不能被两个文件同时重置，所以文件串行。
 * @learning/config 指向源码，跑测试不用先构建它（`/testing` 必须排在前面，否则被当成主入口的子路径）。test/dist.test.ts 要测产物，自己另外加载。
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@learning/config/testing': path.resolve(import.meta.dirname, '../config/src/testing.ts'),
      '@learning/config': path.resolve(import.meta.dirname, '../config/src/index.ts'),
    },
  },
  test: {
    name: 'data-access',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
})
