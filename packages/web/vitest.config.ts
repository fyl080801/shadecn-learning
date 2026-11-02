import path from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * learning-web 的测试 project —— Node 环境。
 * 根 vitest 用的 vite 7 走 esbuild，不输出 emitDecoratorMetadata，Nest 的依赖注入会拿到 undefined，
 * 所以这里用 swc 转译。@learning/config 指向源码，跑测试不用先构建它（`/testing` 必须排在主入口前面）。
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
    name: 'learning-web',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
