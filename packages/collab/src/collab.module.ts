import { CanvasModule } from '@learning/canvas'
import { Cluster } from '@learning/cluster'
import { Module } from '@nestjs/common'
import { AwarenessClaims } from './awareness.js'
import { CollabAuth } from './collab-auth.js'
import { COLLAB_EXTENSIONS, createCollabExtensions } from './collab-extensions.js'
import { CollabServer } from './collab-server.js'
import { ExclusiveConnections } from './exclusive.js'
import { FlowPersistence } from './flow-persistence.js'
import { CollabQuota } from './quota.js'

/**
 * Hocuspocus 实例、持久化、配额、awareness、单连接互斥、写闸门、复验、退出（docs/30 §2）。**没有 HTTP 和 WebSocket 入口**：要房间但不接 WebSocket 的进程只 import 这个（平台上的生成任务、将来的 agent 进程）。
 * 依赖全局底座（`DataAccessModule`、`ClusterModule`、`SessionIdentityModule`），不用 import。
 */
@Module({
  imports: [CanvasModule],
  providers: [
    CollabAuth,
    FlowPersistence,
    CollabQuota,
    AwarenessClaims,
    ExclusiveConnections,
    { provide: COLLAB_EXTENSIONS, inject: [Cluster], useFactory: createCollabExtensions },
    CollabServer,
  ],
  exports: [CollabServer, FlowPersistence],
})
export class CollabModule {}
