import type { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { isAgentOrigin } from '@shadecn/shared/agent'
import { nodesMap } from '@shadecn/shared/flow-doc'
import { agentOrigin, observeDocTransactions, type CanvasActor } from '@shadecn/agent/canvas'
import type { RunAuthority } from '@shadecn/agent/authority'
import type { OpenedCanvas } from '@shadecn/agent/session'
import { collabInstance, type CollabContext } from '../collab/hocuspocus.ts'
import { roomOf } from '../collab/persistence.ts'
import { quotaLocked } from '../collab/quota.ts'
import { readFlowUpdate } from '../collab/flow-writer.ts'

/**
 * agent 够得着画布的那一层：用 Hocuspocus 的 **direct connection** 打开活房间，
 * 实现 `@shadecn/agent` 的 `CanvasHandle`（REQ-AGENT §3.3）。
 *
 * ## 为什么是活房间，而不是 `applyFlowUpdate()` 写库
 *
 * 房间在线时，内容的事实源是内存里的 `Y.Doc`；绕过它写库，在线的人看不到，而且会被房间的
 * 下一次落库合并回来之前一直对不上。走 direct connection：
 * - 房间在线 → 改动走 Hocuspocus 的正常广播，客户端立刻收到；
 * - 房间不在线 → 它触发 `onLoadDocument` 把库里的状态灌进来，`close()` 时落库并卸载；
 * - 落库复用 `persistence.ts` 的「读 → 合并 → CAS」、防抖与欠账重试，不另开写路径。
 *
 * 个人画布同样走这里。所有者此刻要是还停在 solo 传输（只推不拉），他的 REST 写入和这个房间
 * 会经 persistence 的「读 → 合并 → CAS」在库里收敛，内容不丢；只是那个页面看不到 agent 的改动，
 * 直到它切到 WebSocket（前端在发起 agent 时做）或刷新。「房间在线时 REST `/doc` 回 409 room-live」
 * （docs/20 §3.3.2）这一期没做。
 *
 * ## 不用 `DirectConnection.transact`
 *
 * 它用的 origin 是 `{ source: 'local', context }` —— 那是 Hocuspocus 给扩展自己用的标记，
 * 我们要的是 `@shadecn/shared/agent` 的 `{ source: 'agent', runId }`（撤回本轮时按 runId 认人，
 * 也不能进任何人的撤销栈）。所以直接在 `connection.document` 上 `transact(fn, agentOrigin(runId))`。
 * Hocuspocus 对认不出的 origin 按普通改动处理：`onChange` 照跑（配额记账、日志计数、redis 转发 ——
 * extension-redis 只跳过 `source === 'redis'`），防抖落库照跑（`shouldSkipStoreHooks` 只对
 * `redis` 和带 `skipStoreHooks` 的 `local` 为真），广播不看 origin。所以这里不需要任何兼容代码。
 *
 * ## direct connection 绕过了消息层的两道闸，这里自己补
 *
 * WebSocket 写入要过 `beforeSync` 上的写入闸门（权限）和 `beforeHandleMessage` 上的配额；
 * direct connection 两样都不经过。所以 **每一次读写之前**：
 * - **用这一轮的 authority 判权**：读 `flow:read`、写 `flow:write`（`agent/authority.ts`：Grant 有效 ∩ 发起人此刻能进这张画布 ∩
 *   画布仍在同一个项目）。失权时判权失败，**这一轮当场被叫停**（docs/22 §5 stop），这次读写也不执行。
 *   权限检查只在 authority 里做一处（结论缓存数秒），工具层判的那一道和这里共用一次查询；
 * - **写之前查 `quotaLocked`**：房间顶到硬限就拒，一个字节都不写。写之后的字节计量不用另做：
 *   这次事务照样触发 `onChange` → `checkQuota`，超了照样 `lockRoom`。
 *
 * 不复查登录态：一轮凭的是 Grant，不是会话 —— 中途退出登录、会话过期，这一轮照常跑完（docs/22 §6）。
 *
 * ## 一轮一条连接（docs/20 §3.10.2）
 *
 * 编排层一轮只调一次 `openAgentCanvas`、收尾时 `close()`，所以这条 direct connection 在整轮里常驻：
 * 工具调用之间不反复开关房间，常驻观察也挂在它的文档上。它算进 `getConnectionsCount()`，
 * **房间在它关掉之前不会卸载** —— 人都走光了也一样（最多撑到一轮的时长上限）。
 * 所以「中途掉线」只剩一种来路：进程退出时编排层还没收尾（`abortAgentRuns` 在断开协同连接之前就中止并等待各轮）。
 * 万一真遇上（`connection.document` 已经是 null），**不偷偷重开**：重开等于换了一份文档，常驻观察的基线就断了，
 * 这次读写直接以 {@link CONNECTION_CLOSED} 失败，工具把原因回给模型。
 *
 * ## 别人的改动是谁做的
 *
 * {@link classifyCollabOrigin} 按 Hocuspocus 4.6 的事务 origin 认人（实测见 docs/20 §3.10.2）：客户端连接上来的更新是
 * `{ source: 'connection', connection }`，`connection.context` 就是 `onConnect` 返回的 {@link CollabContext}，
 * 里面的 `identity` 是握手时服务端认定的用户；别的副本经 extension-redis 转发来的是 `{ source: 'redis' }`，认不出人。
 */

/** 连接在这一轮收尾之前就没了（见文件头「一轮一条连接」） */
export const CONNECTION_CLOSED = '画布连接已断开（服务正在停止，或这一轮已经结束），这次读写没有执行'

/**
 * 事务 origin → 改动者。返回 null = 内务，不算谁的改动：`'gc'`（落库时清理悬空连线）、`'migrate'`（灌老数据）。
 * 其余认不出的（redis 转发、persistence 合并回来的、别的扩展写的）一律「其他协作者」。
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
  /** 测试注入；缺省取当前进程的协同实例 */
  hocuspocus?: Hocuspocus | null
}

export async function openAgentCanvas(options: OpenAgentCanvasOptions): Promise<OpenedCanvas> {
  const { flowId, userId, runId, authority } = options
  const room = roomOf(flowId)

  // 进不了这张画布就不开房间（开 direct connection 会把库里的文档灌进内存）
  await authority.authorize('flow:read')
  const hocuspocus = options.hocuspocus === undefined ? collabInstance() : options.hocuspocus
  if (!hocuspocus) throw new Error('协同服务没有启动，agent 无法打开画布')

  // context 只是给 hook 看的标签；我们自己的 hook 不读它，日志排查时能认出是谁
  const connection = await hocuspocus.openDirectConnection(room, { agent: { runId, userId } })
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
      const locked = quotaLocked(room)
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
      /*
       * 断开时 Hocuspocus 会立刻跑一次 store（`storeDocumentHooks`，不等防抖），
       * 没有别的连接的话随即卸载房间 —— 这一轮的改动在这里确定落库。
       */
      await connection.disconnect()
    },
  }
}

/**
 * 带入口节点的新会话发起之前：这个节点在不在这张画布上（docs/20 §3.10.9，路由的 404 只能在开流之前定）。
 *
 * 房间在本进程里活着就读内存里的文档（刚建的节点可能还没落库：落库有 2–10 秒的防抖）；
 * 不在就读库 —— 没人连着的房间，卸载时已经落了库。多副本时房间可能活在别的副本上，库里最多慢一个防抖窗口，
 * 这时刚建的节点会被误判成不存在（再点一次就好），不会放过一个真不存在的节点。
 * 只判存在，不判权限：能不能进这张画布是路由前面的 `requireFlowMember`。
 */
export async function flowHasNode(flowId: string, nodeId: string, hocuspocus: Hocuspocus | null = collabInstance()): Promise<boolean> {
  const live = hocuspocus?.documents.get(roomOf(flowId))
  if (live) return nodesMap(live).get(nodeId) instanceof Y.Map
  const stored = await readFlowUpdate(flowId)
  if (!stored) return false
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, stored.update)
    return nodesMap(doc).get(nodeId) instanceof Y.Map
  } finally {
    doc.destroy()
  }
}
