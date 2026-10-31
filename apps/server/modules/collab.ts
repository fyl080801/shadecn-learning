import { attachCollabServer, flushAllRoomsToDatabase, flushCollabWrites } from '../collab/index.ts'
import { defineModule } from '../kernel/module.ts'

/**
 * 协同模块（REQ-COLLAB）：把 Hocuspocus 挂到应用自己的 http server 上。
 *
 * 收尾：断连 → 逐房间直接落库并 await → 再把剩余写库排空。内容的事实源是内存里的 Y.Doc，直接退等于丢掉
 * 最后一个防抖窗口内的改动；不靠 `flushPendingStores()`（它触发的落库要过一段微任务链才入队，见 `flushAllRoomsToDatabase`）。
 * 上限 20 秒：配 k8s 的 `terminationGracePeriodSeconds: 60`，留足余量给 preStop 和后面的关连接、断库；
 * 超时就认了 —— 再等也写不进去，内容还在客户端的 IndexedDB 里，下次打开会自己推上来。
 *
 * agent 角色也带它（第 3 期起以 headless 选项启动，docs/28 §3.4.2）：agent 经 direct connection 开的房间就在这里。
 */
export const collabModule = defineModule({
  name: 'collab',
  roles: ['collab', 'agent'],
  async setup(ctx) {
    // dev 下 Vite 的 HMR 也走同一个 upgrade 事件，别把不认识的 socket 掐了
    const collab = await attachCollabServer(ctx.server, { destroyUnmatchedUpgrades: !ctx.isDev })
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
