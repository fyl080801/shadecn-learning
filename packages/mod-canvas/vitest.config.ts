import { defineConfig } from 'vitest/config'

/**
 * 画布模块的测试 project（name: mod-canvas）—— Node 环境，不碰数据库：契约（复制前落库的总线请求）这类纯逻辑。
 * 接上数据库和 HTTP 之后的样子（项目 / 画布 / 邀请接口）由 server project 里的用例守着（它们装配整个平台）。
 */
export default defineConfig({
  test: {
    name: 'mod-canvas',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
