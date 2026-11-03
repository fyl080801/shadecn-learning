import { defineConfig } from 'vitest/config'

/**
 * runner 镜像包的测试 project（name: agent-runner）—— Node 环境，测构建脚本：runner 的边界判定、打包配置、Dockerfile，
 * 外加一次真实的 esbuild（只进内存，不落盘），所以不用先构建也能发现 runner 闭包越界。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：
 * 在根目录 `pnpm test:agent-runner`（= vitest run --project=agent-runner）单独跑。
 */
export default defineConfig({
  test: {
    name: 'agent-runner',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
