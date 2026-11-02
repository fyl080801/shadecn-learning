import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * cluster 的测试 project —— Node 环境。内存实现必跑；设了 `PLATFORM_TEST_REDIS_URL` 时 Redis 实现跑同一套契约（键都带测试专用前缀，跑完清掉）。
 * swc 转译的原因同 @learning/web。@learning/config 指向源码（`/testing` 必须排在主入口前面）。
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
    name: 'cluster',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
