import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { canonicalSkillIds, type AgentChatMessage } from '@shadecn/shared/agent'
import {
  parseCanvasDigest,
  type AgentConversationStore,
  type AgentRunLog,
  type AgentRunUsage,
  type StoredConversation,
  type StoredConversationMeta,
  type StoredConversationWithContext,
} from '@shadecn/agent/store'
import { db } from '../db.ts'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall, newId } from '../db/entities/index.ts'

/**
 * 画布 Agent 的持久化：`@shadecn/agent/store` 两个接口的 MikroORM 实现（实体在 db/entities/agent.ts）。
 *
 * 归属的口径见 `@shadecn/agent/store` 的「归属」：展示用的读（`list` / `get`）只按 `flow` 取 ——
 * 项目画布上成员看得到别人的会话（只读），能不能进这张画布由路由的 `requireFlowMember` 判；
 * 写和带模型上下文的读把 `flow` + `user` 都放进 where —— 对写来说，别人的会话和不存在的会话在这里是同一个结果
 * （查不到 / 改了 0 行），路由先判的 403 漏了也写不进去。
 *
 * `messages` / `llmMessages` / `canvasDigest` 是 lazy 列，要用的查询显式 `populate`；列表不取。
 */

type ConversationRow = Pick<
  AgentConversation,
  'id' | 'flow' | 'user' | 'title' | 'summary' | 'messageCount' | 'createdAt' | 'updatedAt' | 'nodeId' | 'skills'
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
    nodeId: row.nodeId ?? null,
    // 合并掉的旧 id（`canvas-edit` → `canvas`）读出时就换掉（docs/23 §4）
    skills: canonicalSkillIds(parseArray<unknown>(row.skills).filter((id): id is string => typeof id === 'string')),
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

const META_FIELDS = [
  'id',
  'flow',
  'user',
  'title',
  'summary',
  'messageCount',
  'createdAt',
  'updatedAt',
  'nodeId',
  'skills',
] as const

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

  async list(flowId) {
    const rows = await db().find(
      AgentConversation,
      { flow: flowId },
      { orderBy: NEWEST_FIRST, fields: [...META_FIELDS] },
    )
    return rows.map(toMeta)
  },

  async get(flowId, id) {
    const row = await db().findOne(AgentConversation, { id, flow: flowId }, { populate: ['messages'] })
    return row ? withMessages(row) : null
  },

  async getWithContext(flowId, userId, id): Promise<StoredConversationWithContext | null> {
    const row = await db().findOne(
      AgentConversation,
      { id, flow: flowId, user: userId },
      { populate: ['messages', 'llmMessages', 'canvasDigest'] },
    )
    if (!row) return null
    return {
      ...withMessages(row),
      llmMessages: parseArray<AgentMessage>(row.llmMessages),
      // 坏数据兜成 null：下一轮少一份跨轮差异，不值得让它失败
      canvasDigest: row.canvasDigest ? parseCanvasDigest(row.canvasDigest) : null,
    }
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
      // em.create 不会替没给的可空字段填 null（database.md）
      canvasDigest: null,
      nodeId: input.nodeId,
      skills: '[]',
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
        ...(patch.canvasDigest !== undefined
          ? { canvasDigest: patch.canvasDigest ? JSON.stringify(patch.canvasDigest) : null }
          : {}),
        ...(patch.skills ? { skills: JSON.stringify(patch.skills) } : {}),
        updatedAt: new Date(),
      },
    )
    return count > 0
  },

  async rename(flowId, userId, id, title) {
    // 不写 updatedAt：改标题不算会话有新内容（nativeUpdate 也不会触发 onUpdate）
    return (await db().nativeUpdate(AgentConversation, { id, flow: flowId, user: userId }, { title })) > 0
  },

  async remove(flowId, userId, id) {
    return (await db().nativeDelete(AgentConversation, { id, flow: flowId, user: userId })) > 0
  },
}

/** PG 的 `int` 是 32 位：落库的整数夹在这个范围里（超出的写不进去，整行收尾就丢了） */
const INT_MAX = 2_147_483_647

const storedInt = (value: number) => Math.min(INT_MAX, Math.max(0, Math.round(value)))

/**
 * 一轮的用量 → `agent_run` 的列。费用从美元换成整数的微美元（理由见实体的注释），舍入只在合计上做这一次
 */
export function usageColumns(usage: AgentRunUsage) {
  return {
    inputTokens: storedInt(usage.inputTokens),
    outputTokens: storedInt(usage.outputTokens),
    cacheReadTokens: storedInt(usage.cacheReadTokens),
    cacheWriteTokens: storedInt(usage.cacheWriteTokens),
    costMicroUsd: usage.costUsd === null ? null : storedInt(usage.costUsd * 1_000_000),
  }
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
      grantId: run.grantId,
      status: 'running',
      error: null,
      toolCallCount: 0,
      model: run.model,
      // 用量收尾时才写：停在 running 的行（进程被硬杀）就是「没记」
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costMicroUsd: null,
      startedAt: new Date(run.startedAt),
      finishedAt: null,
    })
  },

  async recordToolCall(call) {
    // insert 不走工作单元：id / createdAt 的 onCreate 不触发，自己给
    await db().insert(AgentToolCall, {
      id: newId(),
      runId: call.runId,
      grantId: call.grantId,
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
    // 撞上已有行时只改收尾的字段（grantId 也带上：两笔里写的是同一个值）—— 开头那几个以 startRun 写的为准
    await db().upsert(
      AgentRun,
      {
        id: run.runId,
        conversationId: run.conversationId,
        flowId: run.flowId,
        userId: run.userId,
        grantId: run.grantId,
        status: run.status,
        error: run.error,
        toolCallCount: run.toolCallCount,
        model: run.model,
        ...usageColumns(run.usage),
        startedAt: new Date(run.startedAt),
        finishedAt: new Date(run.finishedAt),
      },
      {
        onConflictFields: ['id'],
        onConflictMergeFields: [
          'grantId',
          'status',
          'error',
          'toolCallCount',
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'costMicroUsd',
          'finishedAt',
        ],
      },
    )
  },
}

// —— 委托授权（Grant，docs/22 §3）——

export interface NewGrantScope {
  scope: string
  resource: string
  onRevoke: string
  required: boolean
}

export interface NewGrant {
  userId: string
  runId: string
  flowId: string
  projectId: string
  projectKind: string
  personalOwnerId: string | null
  expiresAt: Date
  scopes: NewGrantScope[]
}

/** 判权要的那几列 */
export interface GrantState {
  id: string
  expiresAt: Date
  revokedAt: Date | null
  revokeReason: string | null
}

/**
 * Grant 的读写。只有 `apps/server/agent/authority.ts` 用（编排层只认 `@shadecn/agent/authority` 的接口）。
 * 所有撤销都是「`revokedAt` 为空才写」：先写下的原因（失权）不会被后来的（本轮已结束）盖掉。
 */
export const agentGrants = {
  /** 一个 Grant 和它的全部 scope，一个事务写下 */
  async create(input: NewGrant): Promise<string> {
    return db().transactional(async (em) => {
      const grant = em.create(AgentGrant, {
        userId: input.userId,
        runId: input.runId,
        flowId: input.flowId,
        projectId: input.projectId,
        projectKind: input.projectKind,
        personalOwnerId: input.personalOwnerId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokeReason: null,
      })
      for (const scope of input.scopes) em.create(AgentGrantScope, { grantId: grant.id, ...scope })
      await em.flush()
      return grant.id
    })
  },

  async state(grantId: string): Promise<GrantState | null> {
    const row = await db().findOne(AgentGrant, grantId, {
      fields: ['id', 'expiresAt', 'revokedAt', 'revokeReason'],
    })
    return row ? { id: row.id, expiresAt: row.expiresAt, revokedAt: row.revokedAt, revokeReason: row.revokeReason } : null
  },

  /** 撤销 / 关闭一份；返回 false = 已经撤销过（原因保持先写下的那个） */
  async revoke(grantId: string, reason: string, at = new Date()): Promise<boolean> {
    return (await db().nativeUpdate(AgentGrant, { id: grantId, revokedAt: null }, { revokedAt: at, revokeReason: reason })) > 0
  },

  /** 一个人全部还有效的 Grant（账号级撤销，docs/22 §5）；返回撤销了几份 */
  async revokeAllForUser(userId: string, reason: string, at = new Date()): Promise<number> {
    return db().nativeUpdate(AgentGrant, { userId, revokedAt: null }, { revokedAt: at, revokeReason: reason })
  },

  /**
   * 过了 `expiresAt` 还没撤销的，标成到期。定时对账用：在跑的那一轮由对账另行叫停；
   * 进程崩溃留下的孤儿 Grant（那一轮早就没了）也在这里收掉。返回标了几份
   */
  async expireDue(reason: string, now = new Date()): Promise<number> {
    return db().nativeUpdate(
      AgentGrant,
      { revokedAt: null, expiresAt: { $lte: now } },
      { revokedAt: now, revokeReason: reason },
    )
  },
}
