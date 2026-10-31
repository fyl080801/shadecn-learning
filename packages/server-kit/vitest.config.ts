import { defineConfig } from 'vitest/config'

/**
 * 服务端底座运行时库的测试 project（name: server-kit）—— Node 环境，测模块内核、共享层契约、总线、权限撤销信号。
 *
 * 由仓库根的 vitest.config.ts 通过 `projects` 引进来：`pnpm test:server-kit` 单独跑。
 * 共享层的 Redis 实现只有设了 `TEST_REDIS_URL`（命令行或 shell 环境）才跑，和 server project 同一个开关。
 */
export default defineConfig({
  test: {
    name: 'server-kit',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
