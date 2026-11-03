import { defineConfig } from 'vitest/config'

/**
 * 每个包一个 project，各自的配置跟着各自的包走：
 *   server —— apps/server/vitest.config.ts：Node 环境，测后端（apps/server/test/**）
 *   client —— apps/web/vitest.config.ts：jsdom 环境，测前端（apps/web/src/test/**）
 *   shared —— packages/shared/vitest.config.ts：Node 环境，测前后端共用的契约（packages/shared/test/**）
 *   agent  —— packages/agent/vitest.config.ts：Node 环境，测画布 Agent（编排、画布工具、沙箱，packages/agent/test/**）
 *   platform —— apps/platform/vitest.config.ts：Node 环境，测 NestJS 服务（@learning/platform）
 *   collab-service —— apps/collab/vitest.config.ts：Node 环境，测协同副本（@learning/collab-service）和前置代理；设了 PLATFORM_TEST_REDIS_URL 才真的启动
 *   config —— packages/config/vitest.config.ts：Node 环境，测配置的 Nest 模块（@learning/config）
 *   learning-web —— packages/web/vitest.config.ts：Node 环境，测托管前端的 Nest 模块（@learning/web）
 *   contracts —— packages/contracts/vitest.config.ts：Node 环境，测复制的契约文件没有漂移、yjs 单份（@learning/contracts）
 *   cluster —— packages/cluster/vitest.config.ts：Node 环境，测跨进程共享状态（@learning/cluster）；设了 PLATFORM_TEST_REDIS_URL 才连 Redis
 *   foundation —— packages/foundation/vitest.config.ts：Node 环境，测服务的启动底座（@learning/foundation）
 *   data-access —— packages/data-access/vitest.config.ts：Node 环境，测数据访问的 Nest 模块（@learning/data-access）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL
 *   session —— packages/session/vitest.config.ts：Node 环境，测用户和会话的 Nest 模块（@learning/session）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL
 *   canvas —— packages/canvas/vitest.config.ts：Node 环境，测项目、邀请、画布的 Nest 模块（@learning/canvas）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL，设了 PLATFORM_TEST_REDIS_URL 才连 Redis
 *   collab —— packages/collab/vitest.config.ts：Node 环境，测实时协同的 Nest 模块（@learning/collab）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL，设了 PLATFORM_TEST_REDIS_URL 才跑跨副本的用例
 *   storage —— packages/storage/vitest.config.ts：Node 环境，测对象存储的 Nest 模块（@learning/storage）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL，设了 PLATFORM_TEST_S3_URL 才连真的对象存储
 *   apps —— packages/apps/vitest.config.ts：Node 环境，测应用执行和生成任务的 Nest 模块（@learning/apps）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL，设了 PLATFORM_TEST_REDIS_URL 才跑跨副本的用例，设了 PLATFORM_TEST_S3_URL 才连真的对象存储
 *   llm —— packages/llm/vitest.config.ts：Node 环境，测语言模型通路（@learning/llm：`llm.providers` 的解析、选模型、线协议分派）
 *   agent-core —— packages/agent-core/vitest.config.ts：Node 环境，测 Nest 服务用的画布 Agent 核心（@learning/agent-core：编排、画布工具、网关、沙箱驱动；runner 的 tsc 产物起真子进程）
 *   agent-service —— packages/agent-service/vitest.config.ts：Node 环境，测画布 agent 的 Nest 模块（@learning/agent）；设了 PLATFORM_TEST_DATABASE_URL 才连 PostgreSQL，设了 PLATFORM_TEST_REDIS_URL 共享层才走 Redis，设了 PLATFORM_TEST_S3_URL 才连真的对象存储
 *   agent-sandbox —— apps/agent-sandbox/vitest.config.ts：Node 环境，测沙箱镜像的构建脚本（runner 的边界判定、共用的打包逻辑）
 *   agent-runner —— apps/agent-runner/vitest.config.ts：Node 环境，测 Nest 服务那份 runner 镜像的构建脚本（边界判定、打包配置、Dockerfile，外加一次真实打包）
 *   server-kit —— packages/server-kit/vitest.config.ts：Node 环境，测服务端底座的运行时库（模块内核、共享层契约、总线、权限撤销信号）
 *   server-core —— packages/server-core/vitest.config.ts：Node 环境，测服务端底座不碰数据库的部分（集成测试在 server project）
 *   mod-auth —— 登录模块（同上，只测不碰数据库的部分）
 *   mod-canvas —— packages/mod-canvas/vitest.config.ts：Node 环境，测画布模块（不碰数据库的部分：契约）
 *   mod-collab —— packages/mod-collab/vitest.config.ts：Node 环境，测协同能力包
 *   mod-storage —— packages/mod-storage/vitest.config.ts：Node 环境，测对象存储能力包（签名、对象键、缩略图）
 *   mod-agent —— packages/mod-agent/vitest.config.ts：Node 环境，测画布 agent 宿主侧能力包（接上数据库 / 协同之后的用例在 server project）
 *   mod-apps —— packages/mod-apps/vitest.config.ts：Node 环境，测应用执行模块（应用表、参数校验、各驱动的上游请求）
 *
 * 单独跑：`pnpm test:server` / `test:client` / `test:shared` / `test:agent` / `test:agent-sandbox` / `test:server-kit` / `test:mod-*`（= vitest --project=xxx）
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
      'apps/agent-sandbox/vitest.config.ts',
      'apps/agent-runner/vitest.config.ts',
      'apps/platform/vitest.config.ts',
      'apps/collab/vitest.config.ts',
      'packages/config/vitest.config.ts',
      'packages/web/vitest.config.ts',
      'packages/contracts/vitest.config.ts',
      'packages/cluster/vitest.config.ts',
      'packages/foundation/vitest.config.ts',
      'packages/data-access/vitest.config.ts',
      'packages/session/vitest.config.ts',
      'packages/canvas/vitest.config.ts',
      'packages/collab/vitest.config.ts',
      'packages/storage/vitest.config.ts',
      'packages/apps/vitest.config.ts',
      'packages/llm/vitest.config.ts',
      'packages/agent-core/vitest.config.ts',
      'packages/agent-service/vitest.config.ts',
      'packages/server-kit/vitest.config.ts',
      'packages/server-core/vitest.config.ts',
      'packages/mod-auth/vitest.config.ts',
      'packages/mod-canvas/vitest.config.ts',
      'packages/mod-collab/vitest.config.ts',
      'packages/mod-storage/vitest.config.ts',
      'packages/mod-agent/vitest.config.ts',
      'packages/mod-apps/vitest.config.ts',
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'apps/server/**/*.ts',
        'apps/agent-sandbox/scripts/**/*.mjs',
        'apps/agent-runner/scripts/**/*.mjs',
        'apps/platform/src/**/*.ts',
        'apps/collab/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/web/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/cluster/src/**/*.ts',
        'packages/foundation/src/**/*.ts',
        'packages/data-access/src/**/*.ts',
        'packages/session/src/**/*.ts',
        'packages/canvas/src/**/*.ts',
        'packages/collab/src/**/*.ts',
        'packages/storage/src/**/*.ts',
        'packages/apps/src/**/*.ts',
        'packages/llm/src/**/*.ts',
        'packages/agent-core/src/**/*.ts',
        'packages/agent-service/src/**/*.ts',
        'scripts/**/*.mjs',
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
