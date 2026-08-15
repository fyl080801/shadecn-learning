import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { TEST_DATABASE_URL } from './server/test/paths'

const rootDir = import.meta.dirname

/**
 * 两个 project：
 *   server —— Node 环境，测 server/ 下的后端代码（server/test/**）
 *   client —— jsdom 环境，测 src/ 下的前端代码（src/test/**）
 *
 * 单独跑：`pnpm test:server` / `pnpm test:client`（= vitest --project=xxx）
 */
export default defineConfig({
  test: {
    projects: [
      // ------------------------------------------------------------ 后端
      {
        resolve: {
          /**
           * 把 server/env.ts 换成空实现：真身会读仓库根目录的 .env（开发者
           * 自己的 Keycloak 地址和密钥），测试必须跟它无关。环境变量全部由
           * 下面的 test.env 提供。
           */
          alias: [
            {
              find: /^\.\/env\.ts$/,
              replacement: path.join(rootDir, 'server/test/stubs/env.ts'),
            },
          ],
        },
        test: {
          name: 'server',
          root: rootDir,
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
          setupFiles: ['server/test/setup.ts'],
          // 建测试库 + 跑迁移，整轮只做一次
          globalSetup: ['server/test/global-setup.ts'],
          // 所有测试文件共用一个 SQLite 文件，串行跑避免互相踩数据
          fileParallelism: false,
          /**
           * 固定环境变量。这一步很关键：server/env.ts 会 loadEnvFile 读仓库根目录的
           * .env，而 loadEnvFile 不会覆盖「已存在」的变量 —— 这里先占好位，
           * 测试就跟开发者本地的 .env（真实 Keycloak、真实密钥）彻底无关了。
           */
          env: {
            NODE_ENV: 'test',
            DATABASE_URL: TEST_DATABASE_URL,
            APP_ORIGIN: 'http://127.0.0.1:3000',
            PORT: '3000',
            HOST: '127.0.0.1',
            SESSION_SECRET: 'test-session-secret',
            SESSION_TTL: '3600',
            KEYCLOAK_ISSUER: 'https://keycloak.test/realms/test',
            KEYCLOAK_CLIENT_ID: 'test-client',
            KEYCLOAK_CLIENT_SECRET: '',
            KEYCLOAK_SCOPE: 'openid profile email',
          },
        },
      },

      // ------------------------------------------------------------ 前端
      {
        plugins: [vue()],
        resolve: {
          alias: { '@': path.join(rootDir, 'src') },
        },
        test: {
          name: 'client',
          root: rootDir,
          environment: 'jsdom',
          include: ['src/test/**/*.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['server/**/*.ts', 'src/**/*.ts', 'src/**/*.vue'],
      exclude: [
        'server/generated/**',
        'server/test/**',
        'src/test/**',
        'src/components/ui/**',
        '**/*.d.ts',
      ],
    },
  },
})
