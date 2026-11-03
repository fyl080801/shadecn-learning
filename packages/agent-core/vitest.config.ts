import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * agent-core 的测试 project（name: agent-core）—— Node 环境，测编排、画布工具、事件映射和沙箱（test/**）。
 *
 * 不碰数据库，也不调真实模型：画布工具直接对内存里的 Y.Doc 测，模型用 pi-ai 的 faux provider 或脚本化上游。
 * @learning/* 指向源码，跑测试不用先构建它们（多段的 `@learning/contracts/x` 去掉前缀后补 `.ts`）；
 * 唯一要先 `pnpm --filter @learning/agent-core build` 的是 `test/runner-process.test.ts`（它起 tsc 产物的 runner），产物不在就跳过并说明。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@learning\/contracts\/(.*)$/, replacement: path.resolve(import.meta.dirname, '../contracts/src/$1.ts') },
      { find: /^@learning\/llm\/(.*)$/, replacement: path.resolve(import.meta.dirname, '../llm/src/$1.ts') },
    ],
  },
  test: {
    name: 'agent-core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
  },
})
