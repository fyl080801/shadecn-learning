import { RUNNER_ENV, RUNNER_EXIT_PROTOCOL_MISMATCH } from '../protocol.ts'
import { GatewayUnauthorizedError, RunnerProtocolMismatchError, runAgentRunner } from './index.ts'

/**
 * runner 进程的入口（`process` 驱动 spawn 的就是它：源码态经 tsx，产物态是 `output/server/agent-runner.js`）。
 *
 * 环境变量只有 `RUNNER_ENV` 的三个加 `PATH`（驱动从零造），启动时打一行它们的名字（不打值）。
 * bootstrap token 读出来就从 `process.env` 里删掉 ——
 * 之后这个进程里的任何代码（包括被注入的模型让 ffmpeg 打印环境）都拿不到它；反正它也只能兑换一次。
 *
 * 退出码：0 正常跑完；1 出错；2 环境不全；3 网关拒绝（令牌失效 / 这一轮已被叫停）；
 * 4 协议版本和服务端不一致（`RUNNER_EXIT_PROTOCOL_MISMATCH`，镜像没重建；服务端那一侧已让这一轮以 `runner_protocol_mismatch` 收尾）。
 * 父进程（服务端）没了就自尽，连同自己的进程组（还在跑的 ffmpeg）一起：令牌反正也换不到了。
 * **容器里（`oci` 驱动）runner 是 1 号进程**，没有「父进程」这层关系（`ppid` 恒为 0），也不能 `kill(-1)`（= 发给所有进程）：
 * 不看父进程，孤儿由驱动的 `reap` 清理。
 */

const gatewayUrl = process.env[RUNNER_ENV.gatewayUrl] ?? ''
const bootstrapToken = process.env[RUNNER_ENV.bootstrapToken] ?? ''
const workdir = process.env[RUNNER_ENV.workdir] || process.cwd()
// 启动时只报环境变量的**名字**（不报值）：运维 / 验收一眼能看出沙箱里有没有不该有的东西（docs/22 §10 验收 1）
console.log(`[agent-runner] 启动 pid=${process.pid}，环境变量：${Object.keys(process.env).sort().join(', ')}`)
delete process.env[RUNNER_ENV.bootstrapToken]

/** 杀掉自己所在的进程组（驱动以 detached 起的 runner，组长就是自己） */
function killGroup(): never {
  try {
    process.kill(-process.pid, 'SIGKILL')
  } catch {
    // 不是组长（被别的方式启动的）：只退自己
  }
  process.exit(1)
}

function watchParent() {
  const parent = process.ppid
  const timer = setInterval(() => {
    if (process.ppid !== parent) {
      console.error('[agent-runner] 服务端进程已退出，runner 随之结束')
      killGroup()
    }
  }, 1000)
  timer.unref()
}

if (!gatewayUrl || !bootstrapToken) {
  console.error(`[agent-runner] 缺少 ${RUNNER_ENV.gatewayUrl} / ${RUNNER_ENV.bootstrapToken}，不启动`)
  process.exit(2)
}

if (process.pid !== 1) watchParent()

runAgentRunner({ gatewayUrl, bootstrapToken, workdir, ...(process.env.PATH ? { pathEnv: process.env.PATH } : {}) }).then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof RunnerProtocolMismatchError) {
      console.error(`[agent-runner] 协议版本不一致：${err.message}`)
      process.exit(RUNNER_EXIT_PROTOCOL_MISMATCH)
    }
    if (err instanceof GatewayUnauthorizedError) {
      console.error(`[agent-runner] 网关拒绝：${err.message}`)
      process.exit(3)
    }
    console.error('[agent-runner] 异常退出', err)
    process.exit(1)
  },
)
