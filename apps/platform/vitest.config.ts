import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * platform 的测试 project —— Node 环境。
 * 根 vitest 用的 vite 7 走 esbuild，不输出 emitDecoratorMetadata，Nest 的依赖注入会拿到 undefined，
 * 所以这里用 swc 转译。@learning/* 指向源码，跑测试不用先构建它们（`@learning/config/testing` 必须排在主入口前面，否则被当成它的子路径）。
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@learning/config/testing': path.resolve(import.meta.dirname, '../../packages/config/src/testing.ts'),
      '@learning/config': path.resolve(import.meta.dirname, '../../packages/config/src/index.ts'),
      '@learning/foundation': path.resolve(import.meta.dirname, '../../packages/foundation/src/index.ts'),
      '@learning/web': path.resolve(import.meta.dirname, '../../packages/web/src/index.ts'),
      '@learning/data-access': path.resolve(import.meta.dirname, '../../packages/data-access/src/index.ts'),
      '@learning/session/testing': path.resolve(import.meta.dirname, '../../packages/session/src/testing.ts'),
      '@learning/session': path.resolve(import.meta.dirname, '../../packages/session/src/index.ts'),
    },
  },
  test: {
    name: 'platform',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
