import { Cluster } from '@learning/cluster'
import { Controller, Get, Inject, Res } from '@nestjs/common'
import { CollabServer } from './collab-server.js'
import { FlowPersistence } from './flow-persistence.js'

/** 多久没成功落库算不健康。落库是有编辑才发生的，所以必须和队列一起看：单看时间，没人编辑时天天误报 */
const STALE_STORE_MS = 5 * 60_000

/** 协同的监控端点，在根模块的 `ApiSessionGuard` 之内 */
@Controller('api/collab')
export class CollabMonitorController {
  constructor(
    @Inject(CollabServer) private readonly collab: CollabServer,
    @Inject(FlowPersistence) private readonly persistence: FlowPersistence,
    @Inject(Cluster) private readonly cluster: Cluster,
  ) {}

  /** 现在有哪些房间、各自几条连接 */
  @Get('rooms')
  rooms() {
    return this.collab.stats()
  }

  /** 落库健康度。**HTTP 状态码本身就是结论**：最土的告警（curl 判状态码）也接得上 */
  @Get('health')
  health(@Res({ passthrough: true }) reply: { code(status: number): unknown }) {
    const store = this.persistence.storeStats()
    const cluster = this.cluster.health()
    const pending = this.persistence.pendingWriteCount()
    const owed = this.persistence.failedStoreCount()
    const rooms = this.collab.stats()
    const stale = pending > 0 && store.lastOkAt !== null && Date.now() - store.lastOkAt > STALE_STORE_MS
    // 判定看「现在还欠不欠」：补齐之后就是健康的。failed 是进程累计，只留在响应里让人知道出过事，算进判定的话一次抖动就要 503 到重启
    const ok = owed === 0 && !stale && cluster.ok

    reply.code(ok ? 200 : 503)
    return {
      ok,
      instance: this.cluster.instanceId,
      store: { ...store, sinceLastOkMs: store.lastOkAt === null ? null : Date.now() - store.lastOkAt, stale },
      pending,
      owed,
      cluster,
      rooms: { total: rooms.totalRooms, connections: rooms.totalConnections },
    }
  }
}
