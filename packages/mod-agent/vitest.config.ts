import { defineConfig } from 'vitest/config'

/**
 * 画布 agent 宿主侧能力包的测试 project（name: mod-agent）—— Node 环境，不碰数据库。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：`pnpm test:mod-agent` 单独跑。
 * 和路由、数据库、协同实例接起来之后的样子，由 server project 里的用例守着。
 */
export default defineConfig({
  test: {
    name: 'mod-agent',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
