import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * 协同副本的测试 project —— Node 环境。swc 转译的原因同 apps/platform；@learning/* 指向源码，跑测试不用先构建它们（`/testing` 必须排在主入口前面）。
 * 设了 `PLATFORM_TEST_REDIS_URL` 才真的启动：这个服务不接受 `single`。
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@learning/config/testing': path.resolve(import.meta.dirname, '../../packages/config/src/testing.ts'),
      '@learning/config': path.resolve(import.meta.dirname, '../../packages/config/src/index.ts'),
      '@learning/canvas': path.resolve(import.meta.dirname, '../../packages/canvas/src/index.ts'),
      '@learning/collab': path.resolve(import.meta.dirname, '../../packages/collab/src/index.ts'),
      '@learning/contracts': path.resolve(import.meta.dirname, '../../packages/contracts/src'),
      '@learning/cluster': path.resolve(import.meta.dirname, '../../packages/cluster/src/index.ts'),
      '@learning/foundation': path.resolve(import.meta.dirname, '../../packages/foundation/src/index.ts'),
      '@learning/data-access': path.resolve(import.meta.dirname, '../../packages/data-access/src/index.ts'),
      '@learning/session': path.resolve(import.meta.dirname, '../../packages/session/src/index.ts'),
    },
  },
  test: {
    name: 'collab-service',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
