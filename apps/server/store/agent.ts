import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { AgentChatMessage } from '@shadecn/shared/agent'
import type {
  AgentConversationStore,
  AgentRunLog,
  StoredConversation,
  StoredConversationMeta,
  StoredConversationWithContext,
} from '@shadecn/agent/store'
import { db } from '../db.ts'
import { AgentConversation, AgentRun, AgentToolCall, newId } from '../db/entities/index.ts'

/**
 * 画布 Agent 的持久化：`@shadecn/agent/store` 两个接口的 MikroORM 实现（实体在 db/entities/agent.ts）。
 *
 * 会话的每一次读写都把 `flow` + `user` 放进 where —— 别人的会话和不存在的会话在这里就是同一个结果（查不到），
 * 调用方没有机会把它们区分开，也就不可能漏掉归属检查。
 *
 * `messages` / `llmMessages` 是 lazy 列，要用的查询显式 `populate`；列表不取。
 */

type ConversationRow = Pick<
  AgentConversation,
  'id' | 'flow' | 'user' | 'title' | 'summary' | 'messageCount' | 'createdAt' | 'updatedAt'
>

function toMeta(row: ConversationRow): StoredConversationMeta {
  return {
    id: row.id,
    flowId: row.flow.id,
    userId: row.user.id,
    title: row.title,
    summary: row.summary,
    messageCount: row.messageCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }
}

/** 库里的 JSON 是外部数据：解析不了 / 不是数组就当空（坏一行不该让整个面板打不开） */
function parseArray<T>(serialized: string | undefined): T[] {
  if (!serialized) return []
  try {
    const parsed: unknown = JSON.parse(serialized)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function withMessages(row: ConversationRow & { messages?: string }): StoredConversation {
  return { ...toMeta(row), messages: parseArray<AgentChatMessage>(row.messages) }
}

const META_FIELDS = ['id', 'flow', 'user', 'title', 'summary', 'messageCount', 'createdAt', 'updatedAt'] as const

/** 同一毫秒里更新的两个会话按建立先后排，列表顺序才稳定 */
const NEWEST_FIRST = { updatedAt: 'desc', createdAt: 'desc' } as const

export const agentConversations: AgentConversationStore = {
  async latest(flowId, userId) {
    const row = await db().findOne(
      AgentConversation,
      { flow: flowId, user: userId },
      { orderBy: NEWEST_FIRST, populate: ['messages'] },
    )
    return row ? withMessages(row) : null
  },

  async list(flowId, userId) {
    const rows = await db().find(
      AgentConversation,
      { flow: flowId, user: userId },
      { orderBy: NEWEST_FIRST, fields: [...META_FIELDS] },
    )
    return rows.map(toMeta)
  },

  async get(flowId, userId, id) {
    const row = await db().findOne(AgentConversation, { id, flow: flowId, user: userId }, { populate: ['messages'] })
    return row ? withMessages(row) : null
  },

  async getWithContext(flowId, userId, id): Promise<StoredConversationWithContext | null> {
    const row = await db().findOne(
      AgentConversation,
      { id, flow: flowId, user: userId },
      { populate: ['messages', 'llmMessages'] },
    )
    if (!row) return null
    return { ...withMessages(row), llmMessages: parseArray<AgentMessage>(row.llmMessages) }
  },

  async create(input) {
    const em = db()
    const row = em.create(AgentConversation, {
      flow: input.flowId,
      user: input.userId,
      title: input.title,
      summary: input.summary,
      messageCount: input.messages.length,
      messages: JSON.stringify(input.messages),
      llmMessages: JSON.stringify(input.llmMessages),
    })
    await em.flush()
    return toMeta(row)
  },

  async save(flowId, userId, id, patch) {
    // nativeUpdate 直接发 SQL，onUpdate 不会触发：updatedAt 得自己写（见 columns.ts 的头注释）
    const count = await db().nativeUpdate(
      AgentConversation,
      { id, flow: flowId, user: userId },
      {
        messages: JSON.stringify(patch.messages),
        messageCount: patch.messages.length,
        summary: patch.summary,
        ...(patch.llmMessages ? { llmMessages: JSON.stringify(patch.llmMessages) } : {}),
        updatedAt: new Date(),
      },
    )
    return count > 0
  },

  async remove(flowId, userId, id) {
    return (await db().nativeDelete(AgentConversation, { id, flow: flowId, user: userId })) > 0
  },
}

/**
 * 运行日志。调用方（编排层）对这里抛出的错误一律 fail open，所以这里不吞错：
 * 吞了，console 里就看不到日志没写进去。
 */
export const agentRunLog: AgentRunLog = {
  async startRun(run) {
    await db().insert(AgentRun, {
      id: run.runId,
      conversationId: run.conversationId,
      flowId: run.flowId,
      userId: run.userId,
      status: 'running',
      error: null,
      toolCallCount: 0,
      model: run.model,
      startedAt: new Date(run.startedAt),
      finishedAt: null,
    })
  },

  async recordToolCall(call) {
    // insert 不走工作单元：id / createdAt 的 onCreate 不触发，自己给
    await db().insert(AgentToolCall, {
      id: newId(),
      runId: call.runId,
      toolCallId: call.toolCallId,
      name: call.name,
      ok: call.ok,
      args: call.args,
      elementIds: JSON.stringify(call.elementIds),
      error: call.error,
      durationMs: Math.max(0, Math.round(call.durationMs)),
      createdAt: new Date(call.createdAt),
    })
  },

  async finishRun(run) {
    // 按 runId upsert：startRun 那一笔没写进去，结尾这一笔照样留下完整的一行。
    // 撞上已有行时只改收尾的四个字段 —— 开头那几个以 startRun 写的为准
    await db().upsert(
      AgentRun,
      {
        id: run.runId,
        conversationId: run.conversationId,
        flowId: run.flowId,
        userId: run.userId,
        status: run.status,
        error: run.error,
        toolCallCount: run.toolCallCount,
        model: run.model,
        startedAt: new Date(run.startedAt),
        finishedAt: new Date(run.finishedAt),
      },
      {
        onConflictFields: ['id'],
        onConflictMergeFields: ['status', 'error', 'toolCallCount', 'finishedAt'],
      },
    )
  },
}
