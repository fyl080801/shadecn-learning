import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * foundation 的测试 project —— Node 环境，起真实的 Fastify。swc 转译的原因同 @learning/web。
 * @learning/config 指向源码，跑测试不用先构建它（`/testing` 必须排在主入口前面）。
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
    name: 'foundation',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
