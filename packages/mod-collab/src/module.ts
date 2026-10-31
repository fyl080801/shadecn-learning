import { defineModule, type ServerModule } from '@shadecn/server-kit/kernel'
import { attachCollabServer, flushAllRoomsToDatabase } from './hocuspocus.ts'
import { flushCollabWrites } from './persistence.ts'
import { configureCollab, type CollabPorts } from './ports.ts'

/**
 * 协同模块（REQ-COLLAB，docs/28 §3.4）。宿主交进来端口（`apps/server/modules/collab.ts`），这里把 Hocuspocus 挂到它的 http server 上。
 *
 * **构造时就装配端口**（不等 setup）：落库、REST 写入这些函数在别的模块和测试里也会被直接调，
 * 它们要的是同一份端口；而 setup 只在真的启动时跑。
 *
 * - 随 `collab` 和 `agent` 两个角色加载：agent 经 direct connection 写的活房间就开在它上面。
 *   只有 `agent` 没有 `collab` 的进程以 **headless** 启动（不接 WebSocket，docs/28 §3.4.2）。
 * - 收尾：断连 → 逐房间直接落库并 await → 把剩余写库排空。内容的事实源是内存里的 Y.Doc，直接退等于丢掉
 *   最后一个防抖窗口内的改动；不靠 `flushPendingStores()`（它触发的落库要过一段微任务链才入队）。
 *   上限 20 秒，配 k8s 的 `terminationGracePeriodSeconds: 60`；超时就认了 —— 内容还在客户端的 IndexedDB 里。
 */
export function createCollabModule<App>(ports: CollabPorts): ServerModule<App> {
  configureCollab(ports)
  return defineModule<App>({
    name: 'collab',
    roles: ['collab', 'agent'],
    async setup(ctx) {
      const headless = !ctx.roles.has('collab')
      // dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
      const collab = await attachCollabServer(ctx.server, { headless, destroyUnmatchedUpgrades: !ctx.isDev })
      if (headless) console.log('[collab] headless：不接 WebSocket，房间只经 direct connection 打开')
      return {
        shutdownTimeoutMs: 20_000,
        async shutdown() {
          collab.closeConnections()
          await flushAllRoomsToDatabase()
          await flushCollabWrites()
        },
      }
    },
  })
}
