import { defineConfig } from 'vitest/config'

/**
 * mod-auth 的测试 project —— Node 环境、不碰数据库的部分；接上数据库和 HTTP 之后的样子由 apps/server 的集成测试守着（它装配整个平台）。
 */
export default defineConfig({
  test: {
    name: 'mod-auth',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
