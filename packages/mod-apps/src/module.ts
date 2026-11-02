import { CANVAS_SERVICE, underFlowGuard, type CanvasService } from '@shadecn/mod-canvas/contract'
import { STORAGE_SERVICE, type StorageService } from '@shadecn/mod-storage/contract'
import { onAccessRevoked } from '@shadecn/server-kit/access'
import { defineModule } from '@shadecn/server-kit/kernel'
import { createAppsService } from './catalog.ts'
import { APPS_MODULE, appsConfig } from './config.ts'
import { APPS_SERVICE } from './contract.ts'
import { AppTask } from './entities.ts'
import { createAppRoutes, createFlowAppRoutes } from './routes.ts'
import { createTaskAuthorities } from './task-authority.ts'
import { createTaskRunner, handleTaskBus, startTaskSweeper } from './task-runner.ts'

export { APPS_SERVICE } from './contract.ts'

/** 应用接口的路径 */
export const APPS_PATH = '/api/apps'
/** 画布节点的执行入口（挂在画布之下，叠 `canvas.flowGuard`） */
export const FLOW_APPS_PATH = '/api/flows/:flowId/apps'

/**
 * 应用执行模块（REQ-APPS，docs/29）：把语言 / 图像 / 视频 / 3D 等生成服务统一成 `executeApp(appId, params)`。
 *
 * - 应用和提供方在应用表文件里（`MODULES_APPS_FILE`），对接服务是驱动（`drivers/`）；
 * - 别的模块经 `apps` 服务调（`./contract`），web 上另有 `/api/apps` 给前端，`/api/flows/:flowId/apps` 给画布节点
 *   （参考图按本画布资源读、产物存成本画布资源，需要 storage 模块，没有就原样）；
 * - 随 `web` 和 `agent` 两个角色加载。画布生成是**任务**（docs/29 §3.10，表 `app_task`）：web 受理、经总线派给 agent 副本，
 *   **agent 角色执行**并经 direct connection 写回节点（所以只在 agent 角色上硬依赖 collab，同 agent 模块），定时对账接手租约过期的任务。
 */
export default defineModule({
  name: APPS_MODULE,
  roles: ['web', 'agent'],
  dependsOn: ['canvas', { module: 'collab', roles: ['agent'] }],
  optional: ['storage'],
  provides: [APPS_SERVICE],
  config: appsConfig,
  entities: [AppTask],
  routes: [
    { path: APPS_PATH, role: 'web', access: 'user' },
    { path: FLOW_APPS_PATH, role: 'web', access: 'user' },
  ],
  enabled: (config) => config.catalog.apps.size > 0 || `应用表 ${config.file} 不存在或没有应用`,
  async setup(ctx) {
    const service = createAppsService(ctx.config.catalog)
    for (const app of service.list()) {
      if (app.unavailable) console.warn(`[apps] 应用 ${app.id} 现在不可用（执行会回 unavailable）：${app.unavailable}`)
    }
    console.info(`[apps] 应用表 ${ctx.config.file}：${service.list().map((app) => app.id).join('、')}`)
    ctx.provide(APPS_SERVICE, service)
    ctx.http.route(APPS_PATH, createAppRoutes(service, (c) => ctx.platform.auth.userId(c)))
    const canvas = ctx.service<CanvasService>(CANVAS_SERVICE)!
    ctx.http.route(FLOW_APPS_PATH, underFlowGuard(canvas, createFlowAppRoutes({ service, request: canvas.request })))
    if (!ctx.roles.has('agent')) return

    // 执行侧：接派发、接取消、定时对账（启动时先对一次 —— 上一个进程留下的任务在这里被接手）
    // 每个任务凭发起人执行（task-authority.ts）；权限变化事件 → 当场重判在跑的任务，失权的叫停
    const authorities = createTaskAuthorities({ canvas })
    const stopReconcile = onAccessRevoked(() => authorities.reconcileLive())
    const runner = createTaskRunner({
      service,
      authorities,
      storage: () => ctx.service<StorageService>(STORAGE_SERVICE),
      instanceId: ctx.platform.runtime.instanceId,
    })
    const stopBus = await handleTaskBus(runner)
    const stopSweeper = startTaskSweeper(runner)
    return {
      shutdownTimeoutMs: 5_000,
      async shutdown() {
        await stopBus()
        stopSweeper()
        stopReconcile()
        // 停下在跑的、放掉租约：重启后（或别的副本）有句柄的接着查
        await runner.shutdown()
      },
    }
  },
})
