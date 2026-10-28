import { defineConfig } from 'vitest/config'

/**
 * 四个 project，各自的配置跟着各自的包走：
 *   server —— apps/server/vitest.config.ts：Node 环境，测后端（apps/server/test/**）
 *   client —— apps/web/vitest.config.ts：jsdom 环境，测前端（apps/web/src/test/**）
 *   shared —— packages/shared/vitest.config.ts：Node 环境，测前后端共用的契约（packages/shared/test/**）
 *   agent  —— packages/agent/vitest.config.ts：Node 环境，测画布 Agent（编排、画布工具、沙箱，packages/agent/test/**）
 *
 * 单独跑：`pnpm test:server` / `pnpm test:client` / `pnpm test:shared` / `pnpm test:agent`（= vitest --project=xxx）
 *
 * 覆盖率在这里统一配置，汇总到仓库根的 coverage/。
 */
export default defineConfig({
  test: {
    projects: [
      'apps/server/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'packages/shared/vitest.config.ts',
      'packages/agent/vitest.config.ts',
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'apps/server/**/*.ts',
        'apps/web/src/**/*.ts',
        'apps/web/src/**/*.vue',
        'packages/shared/src/**/*.ts',
        'packages/agent/src/**/*.ts',
      ],
      exclude: [
        'apps/server/test/**',
        // 测试配置本身不计入覆盖率
        'apps/server/vitest.config.ts',
        'apps/web/src/test/**',
        'apps/web/src/components/ui/**',
        '**/*.d.ts',
      ],
    },
  },
})
