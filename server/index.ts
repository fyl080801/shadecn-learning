import './env.ts'
// 必须排在这个位置（.env 之后、其余一切之前）：它接管 console，之后仓库里既有的
// `console.log('[模块] …')` 就自动变成结构化日志。装晚了会漏掉启动阶段那些行，
// 而写成副作用 import 而不是函数调用的理由见该文件
import './logger/install.ts'
import { createAdaptorServer } from '@hono/node-server'
import { app } from './app.ts'
import { sweepExpired } from './auth/session.ts'
import {
  attachCollabServer,
  COLLAB_PATH,
  flushAllRoomsToDatabase,
  flushCollabWrites,
} from './collab/index.ts'
import { closeCluster, initCluster } from './cluster/index.ts'
import {
  assertAuthConfig,
  assertClusterConfig,
  authEnabled,
  clusterMode,
  host,
  instanceId,
  isDev,
  port,
  staticDir,
} from './config.ts'
import { disconnectDb } from './db.ts'
import { attachFrontend } from './frontend/index.ts'

assertAuthConfig()
assertClusterConfig()

// 挑共享状态的实现（单副本= 进程内存，多副本= Redis）。
// 必须在建协同服务端之前：那边要用同一个 Redis 连接参数，
// 而各模块顶层声明的共享表也是在这之后才第一次被真正取用
await initCluster()

// 先建 server 但先不 listen：Vite 中间件要拿这个 server 挂 HMR 的 upgrade。
// overrideGlobalObjects: false —— 默认会把 global.Response 换成带缓存的实现，
// 那条快路径不认 RESPONSE_ALREADY_SENT 这个标记，前端中间件自己写完响应后会被重复 writeHead。
const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })

// 协同服务端。dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
const collab = await attachCollabServer(server, { destroyUnmatchedUpgrades: !isDev })

const disposeFrontend = await attachFrontend(app, server)

// 过期会话和没用掉的授权请求：启动清一次，之后每小时清一次
const sweep = () => {
  void sweepExpired()
    .then(({ sessions, authRequests }) => {
      if (sessions || authRequests) {
        console.log(`[auth] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条`)
      }
    })
    .catch((err: unknown) => console.error('[auth] 清理过期数据失败', err))
}
sweep()
const sweepTimer = setInterval(sweep, 60 * 60 * 1000)
sweepTimer.unref()

server.listen(port, host, () => {
  const mode = isDev ? 'dev（Vite 中间件）' : `prod（静态资源 ${staticDir}）`
  console.log(`${mode} 服务已启动  http://${host}:${port}`)
  console.log(`Yjs websocket        ws://${host}:${port}${COLLAB_PATH}（房间名走消息）`)
  console.log(`登录                 ${authEnabled ? 'Keycloak（/login）' : '未启用'}`)
  console.log(
    `副本模式             ${clusterMode === 'redis' ? `多副本（Redis 共享，实例 ${instanceId}）` : '单副本（状态在进程内存）'}`,
  )
})

const orphanTimer = watchForOrphan()

/**
 * 退出时留给落库的时间上限。
 *
 * **必须有个上限**：落库排的是一条队，`Promise.allSettled` 会一直等下去，
 * 而数据库要是进了网络黑洞，这里就永远回不来 —— 然后 k8s 的
 * `terminationGracePeriodSeconds` 到点直接 SIGKILL，**连后面的清理都没跑**。
 * 卡死等来的是最糟的结局：既没落库，也没干净退出。
 *
 * 20 秒配 `terminationGracePeriodSeconds: 60`（见 k8s/），留足余量给 preStop
 * 那 5 秒和后面的关连接、断库。超时就认了往下走 —— 再等也写不进去，
 * 而内容还在客户端的 IndexedDB 里，下次打开会自己推上来。
 */
const SHUTDOWN_FLUSH_TIMEOUT = 20_000

/** 给一段收尾工作加个上限；超时只记一笔，不阻断后面的步骤 */
async function withDeadline(task: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[shutdown] ${label}超过 ${ms}ms 仍未完成，不再等待`)
      resolve()
    }, ms)
  })

  try {
    await Promise.race([task, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

let shuttingDown = false

async function shutdown() {
  // SIGINT 和 SIGTERM 可能前后脚都到，孤儿守卫也可能在退出过程中再触发一次
  if (shuttingDown) return
  shuttingDown = true

  clearInterval(sweepTimer)
  if (orphanTimer) clearInterval(orphanTimer)

  // 退出前把还开着的房间落库：内容的事实源是内存里的 Y.Doc，直接退等于丢掉
  // 最后一个防抖窗口内的改动。不靠 flushPendingStores() —— 它触发的落库要过一段
  // 微任务链才入队，同步往下走会在入队前就采样到空队列（见 flushAllRoomsToDatabase）。
  // 断连 → 逐房间直接落库并 await → 再把剩余写库排空
  try {
    collab.closeConnections()
    await withDeadline(
      (async () => {
        await flushAllRoomsToDatabase()
        await flushCollabWrites()
      })(),
      SHUTDOWN_FLUSH_TIMEOUT,
      '退出前落库',
    )
  } catch (err) {
    console.error('[collab] 退出前保存失败', err)
  }

  await disposeFrontend?.()
  await closeCluster().catch(() => undefined)
  await disconnectDb().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

// dev 下真正 listen 的是 tsx watch fork 出来的这个进程，上面还压着 tsx、sh、pnpm 三层。
// 终端里 Ctrl+C 时信号发给整个前台进程组，四层都收得到；但从 IDE 点停止、kill 顶层 pid、
// 或者直接关掉终端标签时，信号只送到最上面一两层，这里收不到 —— 于是端口还占着、连接还连着，
// 进程被 init 收养成了孤儿，下次启动就是 EADDRINUSE。攒几天能攒出几十个。
// 父进程一死 ppid 就会变成 1，据此自我了断（走正常 shutdown，Y.Doc 该落库的照样落库）。
// 定时器 unref 掉：它只是个哨兵，不该成为进程活着的理由
function watchForOrphan() {
  if (!isDev) return undefined
  const parentPid = process.ppid
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      console.log('[dev] 父进程已退出，自动关闭以释放端口')
      void shutdown()
    }
  }, 2000)
  timer.unref()
  return timer
}
