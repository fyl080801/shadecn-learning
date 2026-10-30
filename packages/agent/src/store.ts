import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentChatMessage } from '@shadecn/shared/agent'
import { createId } from '@shadecn/shared/id'
import type { CanvasDigest } from './canvas-changes.ts'

export { parseCanvasDigest, type CanvasDigest } from './canvas-changes.ts'

/**
 * 编排层要的两样持久化：**会话**（对话记录 + 模型上下文）和**运行日志**（每轮一行 + 每次工具调用一行）。
 *
 * 本包不认识任何数据库：这里只声明接口，宿主注入实现（`apps/server/store/agent.ts` 是 MikroORM 那份）。
 * 下面的内存实现只给包内测试用 —— **生产路径必须显式注入**，`createAgentRuntime` 不会拿它兜底，
 * 否则「忘了接库」会悄悄退化成「重启即丢」，而且没人看得出来。
 *
 * 时间在接口上一律是 UTC epoch 毫秒（同 `AgentChatMessage.createdAt`），换成 `Date` 是实现的事。
 *
 * ## 归属
 *
 * 会话按「画布 + 发起人」归属，读写的口径不一样（docs/20 §3.10.5）：
 * - **展示用的读**（`list` / `get`）只按画布取：项目画布上成员看得到别人的会话（只读）。
 *   能不能进这张画布是宿主的事（路由的 `requireFlowMember`），这里不管；
 * - **写、以及带模型上下文的读**（`latest` / `getWithContext` / `save` / `remove`）带 `flowId` + `userId`，
 *   实现必须把它们放进查询条件（`where id and flow and user`），而不是按 id 取出来再比 ——
 *   对写来说，别人的会话和不存在的会话必须一模一样（宿主先按 `get` 的 `userId` 判 403，这里是第二道）。
 *   模型上下文（含工具调用的原始参数）只给发起人那一轮用，不随只读可见一起放开。
 */

/** 会话的元数据（列表里的一行要的全部东西，不含消息） */
export interface StoredConversationMeta {
  id: string
  flowId: string
  userId: string
  title: string
  summary: string
  messageCount: number
  createdAt: number
  updatedAt: number
  /** 会话的入口节点（docs/20 §3.10.9）；没有为 null。建会话时定下，之后不改；只记录，不限制工具 */
  nodeId: string | null
  /** 这个会话加载过的技能 id（docs/23 §3.4），按首次加载的先后，只增不减；坏数据 / 没有时为空数组 */
  skills: string[]
}

export interface StoredConversation extends StoredConversationMeta {
  messages: AgentChatMessage[]
}

/** 加上模型上下文（pi 的 messages）—— 只有跑一轮时才要，面板读会话用不着、也不该搬它 */
export interface StoredConversationWithContext extends StoredConversation {
  llmMessages: AgentMessage[]
  /**
   * 上一轮结束时存下的画布摘要（docs/20 §3.10.2 跨轮差异）；从没跑完过一轮、或画布太大没存 → null。
   * 和模型上下文一样只给发起人那一轮用。实现读到坏数据时用 {@link parseCanvasDigest} 兜成 null
   */
  canvasDigest: CanvasDigest | null
}

export interface NewConversationInput {
  flowId: string
  userId: string
  title: string
  summary: string
  messages: AgentChatMessage[]
  llmMessages: AgentMessage[]
  /** 会话的入口节点；没有为 null */
  nodeId: string | null
}

/** 一次保存。不给的字段保持原样；`updatedAt` 由实现写成当前时刻 */
export interface ConversationPatch {
  messages: AgentChatMessage[]
  summary: string
  llmMessages?: AgentMessage[]
  /** 不给 = 保持原样；`null` = 清掉 */
  canvasDigest?: CanvasDigest | null
  /** 不给 = 保持原样。调用方（编排层）给的是「之前的 ∪ 这一轮加载的」，实现原样写 */
  skills?: string[]
}

export interface AgentConversationStore {
  /** 这个人在这张画布上 updatedAt 最新的会话（含消息） */
  latest(flowId: string, userId: string): Promise<StoredConversation | null>
  /** 这张画布上**所有人**的会话，按 updatedAt 倒序，不含消息 */
  list(flowId: string): Promise<StoredConversationMeta[]>
  /** 这张画布上的一个会话（不论是谁的）；不在这张画布上 → null */
  get(flowId: string, id: string): Promise<StoredConversation | null>
  getWithContext(flowId: string, userId: string, id: string): Promise<StoredConversationWithContext | null>
  /** 建一个会话并返回它（id 由实现生成）；`messageCount` 由实现按 `messages.length` 写 */
  create(input: NewConversationInput): Promise<StoredConversationMeta>
  /** 返回 false = 这一行已经不在了（被删了 / 不属于这个人） */
  save(flowId: string, userId: string, id: string, patch: ConversationPatch): Promise<boolean>
  /** 返回 false = 本来就没有（或不是这个人的） */
  remove(flowId: string, userId: string, id: string): Promise<boolean>
}

// —— 运行日志 ——
//
// 审计用途（docs/20 §3.9 ⑤ / F13）：出事时能还原 agent 做了什么。**只记 id 类字段和长度**，
// 不记正文、不记用户输入 —— 参数摘要由 session.ts 的 `digestArgs` 生成。
// 它是旁路记录：写失败只打日志，不影响这一轮（见 session.ts 的失败语义）。

/**
 * 一轮的状态机：running → success | cancelled | error | expired（docs/22 §9 第一期）。
 * - `cancelled`：被中止 —— 发起人 / 管理员点停止、超时、步数上限、进程退出，以及**发起人失权**（Grant 被撤销，原因写在 `error`）；
 * - `expired`：Grant 到期（绝对过期时间到了，这一轮还没结束）。
 * 线上（RUN_FINISHED 的 `outcome`）只有 success / cancelled 两种，`expired` 在线上就是 cancelled —— 契约不变。
 */
export type AgentRunStatus = 'running' | 'success' | 'cancelled' | 'error' | 'expired'

export interface AgentRunStart {
  runId: string
  conversationId: string
  flowId: string
  userId: string
  /** 给人看的模型名 */
  model: string | null
  /** 这一轮凭的 Grant（审计：谁、哪个 run、哪份 Grant）；没签发出来（发起时就已失权）为 null */
  grantId: string | null
  startedAt: number
}

export interface AgentRunFinish extends AgentRunStart {
  status: Exclude<AgentRunStatus, 'running'>
  /** 收尾原因：失败的报错，或 cancelled / expired 的原因（给人看的中文）；success 为 null */
  error: string | null
  toolCallCount: number
  finishedAt: number
}

export interface AgentToolCallRecord {
  runId: string
  /** 这次调用是凭哪份 Grant 做的 */
  grantId: string | null
  toolCallId: string
  name: string
  ok: boolean
  /** `digestArgs` 的输出：id 照写、字符串只有长度 */
  args: string
  elementIds: string[]
  error: string | null
  durationMs: number
  createdAt: number
}

export interface AgentRunLog {
  startRun(run: AgentRunStart): Promise<void>
  recordToolCall(call: AgentToolCallRecord): Promise<void>
  /**
   * 收尾时带上**完整**的一行（含 start 时的字段）：实现应按 runId upsert ——
   * `startRun` 那一笔写失败了，结束这一笔照样能留下记录。
   */
  finishRun(run: AgentRunFinish): Promise<void>
}

// —— 内存实现（测试用） ——

type MemoryConversationRow = StoredConversationWithContext

export interface MemoryConversationStore extends AgentConversationStore {
  /** 测试直接看里面存了什么 */
  readonly rows: Map<string, MemoryConversationRow>
}

export function createMemoryConversationStore(now: () => number = Date.now): MemoryConversationStore {
  const rows = new Map<string, MemoryConversationRow>()
  /** 单调递增的时刻：同一毫秒里的两次写也分得出先后，倒序排列才稳定 */
  let last = 0
  const tick = () => {
    last = Math.max(last + 1, now())
    return last
  }

  const owned = (flowId: string, userId: string, id: string) => {
    const row = rows.get(id)
    return row && row.flowId === flowId && row.userId === userId ? row : null
  }
  const meta = (row: MemoryConversationRow): StoredConversationMeta => ({
    id: row.id,
    flowId: row.flowId,
    userId: row.userId,
    title: row.title,
    summary: row.summary,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nodeId: row.nodeId,
    skills: [...row.skills],
  })
  const withMessages = (row: MemoryConversationRow): StoredConversation => ({
    ...meta(row),
    messages: structuredClone(row.messages),
  })
  const newestFirst = (a: MemoryConversationRow, b: MemoryConversationRow) =>
    b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
  const mine = (flowId: string, userId: string) =>
    [...rows.values()].filter((row) => row.flowId === flowId && row.userId === userId).sort(newestFirst)

  return {
    rows,
    async latest(flowId, userId) {
      const [row] = mine(flowId, userId)
      return row ? withMessages(row) : null
    },
    async list(flowId) {
      return [...rows.values()].filter((row) => row.flowId === flowId).sort(newestFirst).map(meta)
    },
    async get(flowId, id) {
      const row = rows.get(id)
      return row && row.flowId === flowId ? withMessages(row) : null
    },
    async getWithContext(flowId, userId, id) {
      const row = owned(flowId, userId, id)
      return row
        ? {
            ...withMessages(row),
            llmMessages: structuredClone(row.llmMessages),
            canvasDigest: row.canvasDigest ? structuredClone(row.canvasDigest) : null,
          }
        : null
    },
    async create(input) {
      const at = tick()
      const row: MemoryConversationRow = {
        id: createId('conv'),
        flowId: input.flowId,
        userId: input.userId,
        title: input.title,
        summary: input.summary,
        messageCount: input.messages.length,
        createdAt: at,
        updatedAt: at,
        messages: structuredClone(input.messages),
        llmMessages: structuredClone(input.llmMessages),
        canvasDigest: null,
        nodeId: input.nodeId,
        skills: [],
      }
      rows.set(row.id, row)
      return meta(row)
    },
    async save(flowId, userId, id, patch) {
      const row = owned(flowId, userId, id)
      if (!row) return false
      row.messages = structuredClone(patch.messages)
      row.messageCount = patch.messages.length
      row.summary = patch.summary
      if (patch.llmMessages) row.llmMessages = structuredClone(patch.llmMessages)
      if (patch.canvasDigest !== undefined) row.canvasDigest = patch.canvasDigest ? structuredClone(patch.canvasDigest) : null
      if (patch.skills) row.skills = [...patch.skills]
      row.updatedAt = tick()
      return true
    },
    async remove(flowId, userId, id) {
      if (!owned(flowId, userId, id)) return false
      rows.delete(id)
      return true
    },
  }
}

export interface MemoryRunLog extends AgentRunLog {
  readonly runs: Map<string, AgentRunFinish | (AgentRunStart & { status: 'running' })>
  readonly toolCalls: AgentToolCallRecord[]
}

export function createMemoryRunLog(): MemoryRunLog {
  const runs: MemoryRunLog['runs'] = new Map()
  const toolCalls: AgentToolCallRecord[] = []
  return {
    runs,
    toolCalls,
    async startRun(run) {
      runs.set(run.runId, { ...run, status: 'running' })
    },
    async recordToolCall(call) {
      toolCalls.push(structuredClone(call))
    },
    async finishRun(run) {
      runs.set(run.runId, { ...run })
    },
  }
}
