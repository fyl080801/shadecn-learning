/**
 * `pnpm build`：前端、服务端、沙箱上下文，全部落到 output/。
 *
 * 服务端和沙箱是两个独立的构建进程，但这算**一次构建**：这里定下一个 `AGENT_BUILD_ID` 经环境变量传给它们，
 * 两边的 runner 才是同一个构建 id（docs/22 §7.2）。根 Dockerfile 的 `RUN pnpm build` 和 CI 都走这一条，不用额外传参。
 */
import { spawnSync } from 'node:child_process'
import { resolveBuildId } from './bundle-common.mjs'

const env = { ...process.env, AGENT_BUILD_ID: resolveBuildId() }
console.log(`[build] 构建 id ${env.AGENT_BUILD_ID}`)

for (const step of ['build:client', 'build:server', 'build:sandbox']) {
  const { status, signal, error } = spawnSync('pnpm', [step], { stdio: 'inherit', env })
  if (status !== 0) {
    console.error(`[build] ${step} 失败（${error?.message ?? status ?? signal}）`)
    process.exit(status || 1)
  }
}
