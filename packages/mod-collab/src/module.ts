import { CANVAS_SERVICE, underFlowGuard, type CanvasService } from '@shadecn/mod-canvas/contract'
import { defineModule } from '@shadecn/server-kit/kernel'
import { COLLAB_PATH } from '@shadecn/shared/collab'
import { createCollabAuth } from './authorize.ts'
import { attachCollabServer, createCollabUpgrade, flushAllRoomsToDatabase } from './hocuspocus.ts'
import { collabLogging, collabLogStats } from './logging.ts'
import { flushCollabWrites } from './persistence.ts'
import { configureCollab } from './ports.ts'
import { createCollabRoutes } from './routes.ts'

/** 个人画布 / 离线补推的内容通道（直接碰 Y.Doc，所以归 collab 角色） */
export const FLOW_DOC_PATH = '/api/flows/:flowId/doc'
/** 协同的监控接口 */
export const COLLAB_MONITOR_PATH = '/api/collab'

/**
 * 协同模块（REQ-COLLAB，docs/28 §3.4）。
 *
 * - 随 `collab` 和 `agent` 两个角色加载：agent 经 direct connection 写的活房间就开在它上面。
 *   只有 `agent` 没有 `collab` 的进程以 **headless** 启动 —— 入口声明的角色是 `collab`，内核在这种进程里不挂它们，
 *   于是自然不接 WebSocket（docs/28 §3.4.2）。
 * - 会话和 Origin 白名单来自平台，进房判权和画布内容来自 `canvas` 服务；画布要读库前的「先落库」经总线来（`flushFlowContent`）。
 * - 收尾：断连 → 逐房间直接落库并 await → 把剩余写库排空。内容的事实源是内存里的 Y.Doc，直接退等于丢掉
 *   最后一个防抖窗口内的改动。上限 20 秒，配 k8s 的 `terminationGracePeriodSeconds: 60`；超时就认了 —— 内容还在客户端的 IndexedDB 里。
 */
export default defineModule({
  name: 'collab',
  roles: ['collab', 'agent'],
  dependsOn: ['canvas'],
  routes: [
    { path: COLLAB_PATH, role: 'collab', access: 'public', kind: 'upgrade' },
    { path: COLLAB_MONITOR_PATH, role: 'collab', access: 'user' },
    { path: FLOW_DOC_PATH, role: 'collab', access: 'user' },
  ],
  async setup(ctx) {
    const canvas = ctx.service<CanvasService>(CANVAS_SERVICE)!
    const { runtime } = ctx.platform
    configureCollab({
      auth: createCollabAuth(canvas),
      flowDocs: canvas.docs,
      instanceId: runtime.instanceId,
      redis: runtime.redis,
      extensions: () => [collabLogging()],
    })

    const collab = await attachCollabServer()
    const routes = createCollabRoutes({ request: canvas.request, storeStats: collabLogStats })
    const accepting = ctx.http.upgrade(COLLAB_PATH, createCollabUpgrade(collab))
    ctx.http.route(COLLAB_MONITOR_PATH, routes.monitor)
    ctx.http.route(FLOW_DOC_PATH, underFlowGuard(canvas, routes.flowDoc))
    if (!accepting) console.log('[collab] headless：不接 WebSocket，房间只经 direct connection 打开')

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
