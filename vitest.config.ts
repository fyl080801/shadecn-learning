import { defineConfig } from 'vitest/config'

/**
 * 每个包一个 project，各自的配置跟着各自的包走：
 *   server —— apps/server/vitest.config.ts：Node 环境，测后端（apps/server/test/**）
 *   client —— apps/web/vitest.config.ts：jsdom 环境，测前端（apps/web/src/test/**）
 *   shared —— packages/shared/vitest.config.ts：Node 环境，测前后端共用的契约（packages/shared/test/**）
 *   agent  —— packages/agent/vitest.config.ts：Node 环境，测画布 Agent（编排、画布工具、沙箱，packages/agent/test/**）
 *   server-kit —— packages/server-kit/vitest.config.ts：Node 环境，测服务端底座的运行时库（模块内核、共享层契约、总线、权限撤销信号）
 *   server-core —— packages/server-core/vitest.config.ts：Node 环境，测服务端底座不碰数据库的部分（集成测试在 server project）
 *   mod-auth / mod-notes —— 登录模块、笔记示例模块（同上，只测不碰数据库的部分）
 *   mod-canvas —— packages/mod-canvas/vitest.config.ts：Node 环境，测画布模块（不碰数据库的部分：契约）
 *   mod-collab —— packages/mod-collab/vitest.config.ts：Node 环境，测协同能力包
 *   mod-storage —— packages/mod-storage/vitest.config.ts：Node 环境，测对象存储能力包（签名、对象键、缩略图）
 *   mod-agent —— packages/mod-agent/vitest.config.ts：Node 环境，测画布 agent 宿主侧能力包（接上数据库 / 协同之后的用例在 server project）
 *
 * 单独跑：`pnpm test:server` / `test:client` / `test:shared` / `test:agent` / `test:server-kit` / `test:mod-*`（= vitest --project=xxx）
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
      'packages/server-kit/vitest.config.ts',
      'packages/server-core/vitest.config.ts',
      'packages/mod-auth/vitest.config.ts',
      'packages/mod-notes/vitest.config.ts',
      'packages/mod-canvas/vitest.config.ts',
      'packages/mod-collab/vitest.config.ts',
      'packages/mod-storage/vitest.config.ts',
      'packages/mod-agent/vitest.config.ts',
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
        'packages/server-kit/src/**/*.ts',
        'packages/mod-*/src/**/*.ts',
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
