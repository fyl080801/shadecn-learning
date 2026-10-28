import { defineConfig } from 'vitest/config'

/**
 * 共享包的测试 project（name: shared）—— Node 环境，测 src/ 下的纯函数和 Y.Doc 形状（test/**）。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：
 * 在根目录 `pnpm test:shared`（= vitest run --project=shared）单独跑。
 *
 * root 不写：作为 project 引入时缺省就是这份配置所在的目录。
 *
 * 这里只测「契约本身」；前后端各自怎么用它，仍由 server / client 两个 project 里原有的用例守着。
 */
export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
