import type { Hocuspocus } from '@hocuspocus/server'
import type * as Y from 'yjs'
import { agentOrigin } from '@shadecn/agent/canvas'
import type { OpenedCanvas } from '@shadecn/agent/session'
import { collabInstance } from '../collab/hocuspocus.ts'
import { roomOf } from '../collab/persistence.ts'
import { quotaLocked } from '../collab/quota.ts'
import { flows } from '../store/flows.ts'
import { projects } from '../store/projects.ts'

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
 * - **重查发起人的权限**（`canAccessFlow`，和 `requireFlowMember` 同口径）：画布被删、发起人被移出项目，
 *   下一次工具调用即被拒（docs/20 §3.9 ①）。不缓存 —— 一次工具调用两次查询，和一次 REST 请求同量级；
 * - **写之前查 `quotaLocked`**：房间顶到硬限就拒，一个字节都不写。写之后的字节计量不用另做：
 *   这次事务照样触发 `onChange` → `checkQuota`，超了照样 `lockRoom`。
 *
 * 不复查登录态：一轮的时长有上限（`@shadecn/agent` 的 `DEFAULT_RUN_LIMITS.timeoutMs`），而它是由一次
 * 带着有效会话的请求发起的；中途在别处登出，这一轮会跑到它自己结束为止。
 */

/** 和 `requireFlowMember` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者） */
export async function canAccessFlow(flowId: string, userId: string): Promise<boolean> {
  const target = await flows.locate(flowId)
  if (!target) return false
  return (await projects.membershipOf(target.projectId, userId)) !== null
}

/** 失权的统一说法 —— 和 404 同一个口径，不区分「画布没了」和「你不是成员了」 */
export const ACCESS_LOST = '这张画布已不存在，或你已无权访问它'

export interface OpenAgentCanvasOptions {
  flowId: string
  userId: string
  runId: string
  /** 测试注入；缺省取当前进程的协同实例 */
  hocuspocus?: Hocuspocus | null
}

export async function openAgentCanvas(options: OpenAgentCanvasOptions): Promise<OpenedCanvas> {
  const { flowId, userId, runId } = options
  const room = roomOf(flowId)

  const guard = async () => {
    if (!(await canAccessFlow(flowId, userId))) throw new Error(ACCESS_LOST)
  }

  await guard()
  const hocuspocus = options.hocuspocus === undefined ? collabInstance() : options.hocuspocus
  if (!hocuspocus) throw new Error('协同服务没有启动，agent 无法打开画布')

  // context 只是给 hook 看的标签；我们自己的 hook 不读它，日志排查时能认出是谁
  const connection = await hocuspocus.openDirectConnection(room, { agent: { runId, userId } })
  const origin = agentOrigin(runId)

  const document = (): Y.Doc => {
    if (!connection.document) throw new Error('画布连接已关闭')
    return connection.document
  }

  return {
    flowId,
    async read(fn) {
      await guard()
      return fn(document())
    },
    async write(fn) {
      await guard()
      const locked = quotaLocked(room)
      if (locked) throw new Error(`画布已达容量上限，不能再写入（${locked}）；请先删掉一些内容`)
      const doc = document()
      let result!: ReturnType<typeof fn>
      doc.transact(() => {
        result = fn(doc)
      }, origin)
      return result
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
