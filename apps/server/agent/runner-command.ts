import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isBundle, moduleDir } from '../runtime.ts'

/**
 * `process` 驱动起 runner 用的命令（docs/22 §7）：
 *
 * - **构建产物**：`node output/server/agent-runner.js`（`scripts/build-server.mjs` 的第三个入口，和服务端共用 chunk）。
 *   本地 `pnpm start` 靠 `--import ./apps/server/scripts/local-start.mjs` 兜裸包名的解析，runner 也要同一个钩子 ——
 *   所以把这个进程的 `--import` 原样带给 runner（相对路径换成绝对的：runner 的 cwd 是它自己的工作目录）；
 *   容器里没有这些参数，就是一句 `node agent-runner.js`。
 * - **源码运行**（`pnpm dev` / 测试）：`node --import <tsx 的 loader> packages/agent/src/runner/main.ts`，
 *   两个路径都按包解析（`tsx` 是 apps/server 的 devDependency，`@shadecn/agent/runner/main` 是包的导出），不靠目录结构。
 *
 * 不带 `--inspect` 一类调试参数：子进程会和父进程抢同一个调试端口。
 */
export function runnerCommand(): [string, ...string[]] {
  if (isBundle) return [process.execPath, ...forwardedImports(process.execArgv), path.join(moduleDir, 'agent-runner.js')]
  const resolveFrom = createRequire(import.meta.url)
  const loader = pathToFileURL(resolveFrom.resolve('tsx')).href
  return [process.execPath, '--import', loader, resolveFrom.resolve('@shadecn/agent/runner/main')]
}

/** 只转发 `--import <模块>`（含 `--import=<模块>`），相对路径按当前 cwd 换成绝对路径 */
export function forwardedImports(execArgv: readonly string[], cwd = process.cwd()): string[] {
  const absolute = (value: string) => (value.startsWith('.') ? path.resolve(cwd, value) : value)
  const out: string[] = []
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index]!
    if (arg === '--import' && execArgv[index + 1] !== undefined) {
      out.push('--import', absolute(execArgv[index + 1]!))
      index += 1
    } else if (arg.startsWith('--import=')) {
      out.push(`--import=${absolute(arg.slice('--import='.length))}`)
    }
  }
  return out
}
