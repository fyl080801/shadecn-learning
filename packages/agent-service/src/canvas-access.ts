import { agentOrigin, observeDocTransactions, type CanvasActor } from '@learning/agent-core/canvas'
import type { RunAuthority } from '@learning/agent-core/authority'
import type { OpenedCanvas } from '@learning/agent-core/session'
import { type CollabContext, CollabServer, FlowPersistence, roomOf } from '@learning/collab'
import { formatAgentRunsMessage, isAgentOrigin, type AgentRunEntry } from '@learning/contracts/agent'
import { nodesMap } from '@learning/contracts/flow-doc'
import { Inject, Injectable } from '@nestjs/common'
import * as Y from 'yjs'

/** 连接在这一轮收尾之前就没了（见 {@link AgentCanvasAccess}「一轮一条连接」） */
export const CONNECTION_CLOSED = '画布连接已断开（服务正在停止，或这一轮已经结束），这次读写没有执行'

/**
 * 事务 origin → 改动者。null = 内务，不算谁的改动：`'gc'`（落库时清理悬空连线）、`'migrate'`（灌老数据）。
 * 其余认不出的（redis 转发、落库合并回来的、别的扩展写的）一律「其他协作者」。
 */
export function classifyCollabOrigin(origin: unknown): CanvasActor | null {
  if (origin === 'gc' || origin === 'migrate') return null
  if (isAgentOrigin(origin)) return { kind: 'agent', runId: origin.runId }
  if (typeof origin === 'object' && origin !== null && (origin as { source?: unknown }).source === 'connection') {
    const context = (origin as { connection?: { context?: unknown } }).connection?.context as CollabContext | undefined
    const identity = context?.identity
    if (identity) return { kind: 'user', id: identity.id, name: identity.name }
  }
  return { kind: 'unknown' }
}

export interface OpenAgentCanvasOptions {
  flowId: string
  /** 发起人（只用作连接上下文里的标签；权限由 `authority` 判） */
  userId: string
  runId: string
  /** 这一轮的执行身份：每次读写之前判 `flow:read` / `flow:write`，打开之前判一次 `flow:read` */
  authority: Pick<RunAuthority, 'authorize'>
}

/**
 * agent 够得着画布的那一层：用 direct connection 打开活房间，实现 agent-core 的 `CanvasHandle`（docs/20 §3.3）。
 *
 * - **活房间，不是写库**：房间在线时内容的事实源是内存里的 `Y.Doc`，绕过它写库，在线的人看不到。平台上没有 WebSocket 入口，`cluster: redis` 时 Redis 扩展把写入转发给持有房间的副本（`docs/31` §6.2）。
 * - **不用 `DirectConnection.transact`**：它的 origin 是 `{ source: 'local' }`，这里要的是 `{ source: 'agent', runId }`（撤回时按 runId 认人，不进任何人的撤销栈）。Hocuspocus 对认不出的 origin 按普通改动处理，落库、配额记账、转发照常。
 * - **direct connection 绕过了写闸门和 `beforeHandleMessage`，这里自己补**：每次读写之前用这一轮的 authority 判权（失权时这一轮当场被叫停），写之前查 `quotaLocked`，一个字节都不写。权限只在 authority 里判一处，不看登录态。
 * - **一轮一条连接**：编排层一轮只开一次、收尾时 `close()`，房间在它关掉之前不会卸载。万一中途没了不偷偷重开（换一份文档，常驻观察的基线就断了），这次读写以 {@link CONNECTION_CLOSED} 失败。
 */
@Injectable()
export class AgentCanvasAccess {
  constructor(
    @Inject(CollabServer) private readonly collab: CollabServer,
    @Inject(FlowPersistence) private readonly persistence: FlowPersistence,
  ) {}

  async open(options: OpenAgentCanvasOptions): Promise<OpenedCanvas> {
    const { flowId, userId, runId, authority } = options
    const { collab } = this
    const room = roomOf(flowId)

    // 进不了这张画布就不开房间（开 direct connection 会把库里的文档灌进内存）
    await authority.authorize('flow:read')
    // context 只是给 hook 看的标签，排查时能认出是谁
    const connection = await collab.hocuspocus.openDirectConnection(room, { agent: { runId, userId } })
    const origin = agentOrigin(runId)

    const document = (): Y.Doc => {
      if (!connection.document) throw new Error(CONNECTION_CLOSED)
      return connection.document
    }

    return {
      flowId,
      async read(fn) {
        await authority.authorize('flow:read')
        return fn(document())
      },
      async write(fn) {
        await authority.authorize('flow:write')
        const locked = collab.quotaLocked(room)
        if (locked) throw new Error(`画布已达容量上限，不能再写入（${locked}）；请先删掉一些内容`)
        const doc = document()
        let result!: ReturnType<typeof fn>
        doc.transact(() => {
          result = fn(doc)
        }, origin)
        return result
      },
      observe(listener) {
        return observeDocTransactions(document(), classifyCollabOrigin, listener)
      },
      async close() {
        // 断开时 Hocuspocus 立刻跑一次落库，没有别的连接的话随即卸载房间：这一轮的改动在这里确定落库
        await connection.disconnect()
      },
    }
  }

  /**
   * 带入口节点的新会话发起之前：这个节点在不在这张画布上（docs/20 §3.10.9，404 只能在开流之前定）。
   * 房间在本进程活着就读内存；不在就读库。多副本时库里可能慢一个防抖窗口，刚建的节点会被误判成不存在（再点一次就好），不会放过真不存在的节点。
   * 只判存在，不判权限：能不能进这张画布是路由前面的 `FlowMemberGuard`。
   */
  async flowHasNode(flowId: string, nodeId: string): Promise<boolean> {
    const room = roomOf(flowId)
    const live = this.collab.hocuspocus.documents.get(room)
    if (live) return nodesMap(live).get(nodeId) instanceof Y.Map
    // 和打开房间同一条路（含还只有 graph、没有 ydoc 的画布）
    const stored = await this.persistence.load(room)
    if (!stored) return false
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, stored)
      return nodesMap(doc).get(nodeId) instanceof Y.Map
    } finally {
      doc.destroy()
    }
  }

  /**
   * 把一张画布的运行中任务列表推给它的房间（docs/20 §3.10.4）。走 stateless：一次性的旁路消息，不进 Y.Doc、不进撤销栈、不落库。
   * 房间没加载（没人连着）就不发：之后连上的人会先拉一次全量。`cluster: redis` 时经 Redis 扩展到别的副本；给的是共享登记里的全量，所以哪个副本发的都完整。
   */
  broadcastRuns(flowId: string, runs: AgentRunEntry[]): boolean {
    const document = this.collab.hocuspocus.documents.get(roomOf(flowId))
    if (!document) return false
    // 带上服务端此刻的时钟：前端拿它把每项的 expiresAt 换算成本机时间
    document.broadcastStateless(formatAgentRunsMessage(flowId, runs, Date.now()))
    return true
  }
}
