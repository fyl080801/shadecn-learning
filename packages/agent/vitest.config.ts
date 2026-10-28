import { defineConfig } from 'vitest/config'

/**
 * 画布 Agent 包的测试 project（name: agent）—— Node 环境，测 src/ 下的编排、画布工具、
 * 事件映射和沙箱（test/**）。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：
 * 在根目录 `pnpm test:agent`（= vitest run --project=agent）单独跑。
 *
 * 不碰数据库也不碰网络：画布工具直接对一个内存里的 Y.Doc 测，模型用 pi-ai 的 faux provider。
 * 它们和 Hocuspocus / 路由接起来之后的样子，由 server project 里的用例守着。
 */
export default defineConfig({
  test: {
    name: 'agent',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
