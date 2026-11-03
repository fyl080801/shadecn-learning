import { defineConfig } from 'vitest/config'

/**
 * llm 的测试 project —— Node 环境，不碰数据库和网络。没有 Nest、没有装饰器，不需要 swc；包内测试用相对路径引源码。
 */
export default defineConfig({
  test: {
    name: 'llm',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
