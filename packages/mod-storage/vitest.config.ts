import { defineConfig } from 'vitest/config'

/**
 * 对象存储能力包的测试 project（name: mod-storage）—— Node 环境：签名、对象键、缩略图（真 sharp，不碰网络）。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：`pnpm test:mod-storage` 单独跑。
 * 和上传路由、agent 看图接起来之后的样子，由 server project 里的用例守着。
 */
export default defineConfig({
  test: {
    name: 'mod-storage',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
