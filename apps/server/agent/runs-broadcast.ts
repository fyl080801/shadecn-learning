import type { Hocuspocus } from '@hocuspocus/server'
import { formatAgentRunsMessage, type AgentRunEntry } from '@shadecn/shared/agent'
import { collabInstance } from '../collab/hocuspocus.ts'
import { roomOf } from '../collab/persistence.ts'

/**
 * 把一张画布的运行中 agent 任务列表推给它的协同房间（docs/20 §3.10.4，契约 `AgentRunsMessage`）。
 *
 * 编排层（`@shadecn/agent/session` 的 `onRunsChange`）在一轮进列表 / 离开列表时调它，占用变化、持有者续期时也调（节流到每秒至多一次），
 * 给的都是全量列表；每项带 `occupies` 和 `expiresAt`（docs/20 §3.4）。
 * 走 Hocuspocus 的 stateless 通道，和落库状态通知（`collab/hocuspocus.ts` 的 `storeStatePayload`）同一条路：
 * 一次性的旁路消息，不进 Y.Doc、不进撤销栈、不落库。两种画布都适用 —— 个人画布的 awareness 被服务端整帧丢弃，
 * 但 stateless 不受影响。
 *
 * **只有服务端发得出**：客户端发上来的 stateless 只到服务端的 `onStateless` 钩子（我们没挂），Hocuspocus
 * 不会转发给同房间的别人；「广播」那个操作码客户端发了直接报错。所以前端收到的这条一定是服务端说的。
 *
 * 写在 agent 这边而不是协同层：协同层不该知道上面坐着谁（同 `collabInstance()` 的注释）。
 *
 * - **房间没加载（没人连着）就不发**：没有听众；之后连上的人会先 `GET {agentApiPath}` 拉一次全量。
 * - 多副本：`broadcastStateless` 会经 extension-redis 的 `beforeBroadcastStateless` 转发到别的副本；
 *   给的列表是编排层从**共享登记**读出的全量（docs/20 §3.10.10，`runs.ts`），含别的副本上的轮次，所以哪个副本发的都完整。
 *   发的一方是持有轮次的副本：它的 agent 连接钉着房间，房间一定加载着。
 */
export function broadcastAgentRuns(
  flowId: string,
  runs: AgentRunEntry[],
  hocuspocus: Hocuspocus | null = collabInstance(),
): boolean {
  const document = hocuspocus?.documents.get(roomOf(flowId))
  if (!document) return false
  // 带上服务端此刻的时钟：前端拿它把每项的 expiresAt 换算成本机时间
  document.broadcastStateless(formatAgentRunsMessage(flowId, runs, Date.now()))
  return true
}
