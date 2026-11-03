import { CanvasModule } from '@learning/canvas'
import { Module } from '@nestjs/common'
import { CollabGateway } from './collab-gateway.js'
import { CollabMonitorController } from './collab-monitor.controller.js'
import { CollabModule } from './collab.module.js'
import { FlowDocController } from './flow-doc.controller.js'
import { FlowWriter } from './flow-writer.js'

/**
 * 协同的入口：WebSocket upgrade、`/api/collab/*` 监控、`/api/flows/:flowId/doc`。
 * 登录靠根模块的 `APP_GUARD = ApiSessionGuard`。imports 里的 `CanvasModule` 是给 `FlowMemberGuard` 的：守卫在挂它的控制器所在的模块里实例化。
 */
@Module({
  imports: [CollabModule, CanvasModule],
  controllers: [CollabMonitorController, FlowDocController],
  providers: [CollabGateway, FlowWriter],
})
export class CollabGatewayModule {}
