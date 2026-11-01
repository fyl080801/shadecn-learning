import { defineConfig } from 'vitest/config'

/**
 * server-core 的测试 project —— Node 环境、不碰数据库的部分；接上数据库和 HTTP 之后的样子由 apps/server 的集成测试守着（它装配整个平台）。
 */
export default defineConfig({
  test: {
    name: 'server-core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // SERVER_CONFIG 空串 = 不读开发者自己的 server.config.*（底座 import 时就读配置）
    env: { NODE_ENV: 'test', SERVER_CONFIG: '', LOG_LEVEL: 'error' },
  },
})
