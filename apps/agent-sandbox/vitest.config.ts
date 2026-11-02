import { defineConfig } from 'vitest/config'

/**
 * 沙箱镜像包的测试 project（name: agent-sandbox）—— Node 环境，测构建脚本：runner 的边界判定、共用的打包逻辑，
 * 外加一次真实的 esbuild（只进内存，不落盘），所以不用先 `pnpm build` 也能发现 runner 闭包越界。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：
 * 在根目录 `pnpm test:agent-sandbox`（= vitest run --project=agent-sandbox）单独跑。
 */
export default defineConfig({
  test: {
    name: 'agent-sandbox',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
