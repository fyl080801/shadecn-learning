import { defineConfig } from 'vitest/config'

/** contracts 的测试 project —— Node 环境：防漂移（逐字比较 packages/shared/src 的同名文件）和 yjs 单份 */
export default defineConfig({
  test: {
    name: 'contracts',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
