import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * config 的测试 project —— Node 环境。
 * 根 vitest 用的 vite 7 走 esbuild，不输出 emitDecoratorMetadata，所以和其他 Nest 包一样用 swc 转译。
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    name: 'config',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
