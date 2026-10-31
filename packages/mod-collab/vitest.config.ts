import { defineConfig } from 'vitest/config'

/**
 * 协同能力包的测试 project（name: mod-collab）—— Node 环境。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：`pnpm test:mod-collab` 单独跑。
 * 和 Hocuspocus / 路由接起来之后的样子，由 server project 里的用例守着。
 */
export default defineConfig({
  test: {
    name: 'mod-collab',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
