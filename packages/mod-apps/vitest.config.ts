import { defineConfig } from 'vitest/config'

/**
 * mod-apps 的测试 project —— Node 环境：应用表解析、参数校验、各驱动对上游的请求形状（上游用注入的 fetch 脚本化）。
 * 接上 HTTP 管线之后的样子由 apps/server 的集成测试守着。
 */
export default defineConfig({
  test: {
    name: 'mod-apps',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
