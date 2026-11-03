import { CanvasModule, FlowsService, ProjectsService } from '@learning/canvas'
import { CollabModule } from '@learning/collab'
import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { StorageModule } from '@learning/storage'
import { Module } from '@nestjs/common'
import { AppsController } from './apps.controller.js'
import { AppsService } from './apps.service.js'
import type { Catalog } from './catalog.js'
import { AppTask } from './entities.js'
import { FlowAppsController } from './flow-apps.controller.js'
import { APPS_CATALOG, resolveAppsCatalog } from './options.js'
import { TaskAuthorities } from './task-authority.js'
import { DEFAULT_TASK_RUNNER_OPTIONS, TASK_RUNNER_OPTIONS, TaskRunner } from './task-runner.js'
import { AppTasks } from './tasks.js'

function createAppsService(catalog: Catalog): AppsService {
  const service = new AppsService(catalog)
  for (const app of service.list()) {
    if (app.unavailable) console.warn(`[apps] 应用 ${app.id} 现在不可用（执行会回 unavailable）：${app.unavailable}`)
  }
  console.info(`[apps] 应用：${service.list().map((app) => app.id).join('、') || '无'}`)
  return service
}

/**
 * 把语言 / 图像 / 视频 / 3D 等生成服务统一成 `executeApp(appId, params)`（docs/29），以及画布节点的生成任务（docs/29 §3.10、docs/30 §8）。
 *
 * - import `CollabModule` 只为房间：任务结果要写进 Y.Doc。这个模块单独用时进程里没有 WebSocket 入口，平台拆开部署时房间经 Redis 扩展和协同副本同步；
 * - 一个应用都没配也照样加载：列表是空的，别的功能不受影响；
 * - 依赖全局底座（`ConfigModule`、`DataAccessModule`、`ClusterModule`、`SessionIdentityModule`），不用 import。
 */
@Module({
  imports: [CanvasModule, CollabModule, StorageModule],
  controllers: [AppsController, FlowAppsController],
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [AppTask] },
    { provide: APPS_CATALOG, inject: [ConfigService], useFactory: resolveAppsCatalog },
    { provide: AppsService, inject: [APPS_CATALOG], useFactory: createAppsService },
    AppTasks,
    {
      provide: TaskAuthorities,
      inject: [FlowsService, ProjectsService],
      useFactory: (flows: FlowsService, projects: ProjectsService) =>
        new TaskAuthorities({ canvas: { locate: (flowId) => flows.locate(flowId), roleOf: (projectId, userId) => projects.roleOf(projectId, userId) } }),
    },
    { provide: TASK_RUNNER_OPTIONS, useValue: DEFAULT_TASK_RUNNER_OPTIONS },
    TaskRunner,
  ],
  exports: [AppsService],
})
export class AppsModule {}
