import { createRequire } from 'node:module'

/**
 * `process` 驱动起 runner 的命令：`node <agent-core 的 tsc 产物>/runner/main.js`。按包解析，不用 tsx，也不用转发 `--import`（`docs/31` §3.3 R1）。
 * pi 从 agent-core 自己的 `node_modules` 解析。产物不存在时这里抛错，`SANDBOX_DRIVER` 据此写成「未启用」的原因。
 */
export function runnerCommand(): [string, ...string[]] {
  return [process.execPath, createRequire(import.meta.url).resolve('@learning/agent-core/runner/main')]
}
