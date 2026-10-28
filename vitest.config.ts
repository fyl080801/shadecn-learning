import { defineConfig } from 'vitest/config'

/**
 * 三个 project，各自的配置跟着各自的包走：
 *   server —— apps/server/vitest.config.ts：Node 环境，测后端（apps/server/test/**）
 *   client —— apps/web/vitest.config.ts：jsdom 环境，测前端（apps/web/src/test/**）
 *   shared —— packages/shared/vitest.config.ts：Node 环境，测前后端共用的契约（packages/shared/test/**）
 *
 * 单独跑：`pnpm test:server` / `pnpm test:client` / `pnpm test:shared`（= vitest --project=xxx）
 *
 * 覆盖率在这里统一配置，汇总到仓库根的 coverage/。
 */
export default defineConfig({
  test: {
    projects: [
      'apps/server/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'packages/shared/vitest.config.ts',
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
      ],
      exclude: [
        'apps/server/generated/**',
        'apps/server/test/**',
        // 迁移前这两份配置不在 server/** 范围里，不计入覆盖率
        'apps/server/prisma.config.ts',
        'apps/server/vitest.config.ts',
        'apps/web/src/test/**',
        'apps/web/src/components/ui/**',
        '**/*.d.ts',
      ],
    },
  },
})
