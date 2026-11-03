import { DataAccess, newId } from '@learning/data-access'
import { canonicalSkillIds, type AgentChatMessage } from '@learning/contracts/agent'
import {
  parseCanvasDigest,
  type AgentConversationStore,
  type AgentRunLog as AgentRunLogPort,
  type AgentRunFinish,
  type AgentRunStart,
  type AgentRunUsage,
  type AgentToolCallRecord,
  type ConversationPatch,
  type NewConversationInput,
  type StoredConversation,
  type StoredConversationMeta,
  type StoredConversationWithContext,
} from '@learning/agent-core/store'
import { Inject, Injectable } from '@nestjs/common'
import { AgentConversation, AgentGrant, AgentGrantScope, AgentRun, AgentToolCall } from './entities.js'

/**
 * 画布 Agent 的持久化：`@learning/agent-core/store` 两个接口的实现，加 Grant 表。
 *
 * 展示用的读（`list` / `get`）只按 `flow` 取：成员看得到别人的会话（只读），能不能进这张画布由路由前面的 `FlowMemberGuard` 判。
 * **写和带模型上下文的读把 `flow` + `user` 都放进 where**：对写来说，别人的会话和不存在的会话是同一个结果（查不到 / 改了 0 行），路由先判的 403 漏了也写不进去。
 *
 * `messages` / `llmMessages` / `canvasDigest` 是 lazy 列，要用的查询显式 `populate`；列表不取。
 */

type ConversationRow = Pick<AgentConversation, 'id' | 'flow' | 'user' | 'title' | 'summary' | 'messageCount' | 'createdAt' | 'updatedAt' | 'nodeId' | 'skills'>

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
    // 合并掉的旧 id 读出时就换掉（docs/23 §4）
    skills: canonicalSkillIds(parseArray<unknown>(row.skills).filter((id): id is string => typeof id === 'string')),
  }
}

function withMessages(row: ConversationRow & { messages?: string }): StoredConversation {
  return { ...toMeta(row), messages: parseArray<AgentChatMessage>(row.messages) }
}

const META_FIELDS = ['id', 'flow', 'user', 'title', 'summary', 'messageCount', 'createdAt', 'updatedAt', 'nodeId', 'skills'] as const

/** 同一毫秒里更新的两个会话按建立先后排，列表顺序才稳定 */
const NEWEST_FIRST = { updatedAt: 'desc', createdAt: 'desc' } as const

@Injectable()
export class AgentConversations implements AgentConversationStore {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  async latest(flowId: string, userId: string): Promise<StoredConversation | null> {
    const row = await this.dataAccess.em().findOne(AgentConversation, { flow: flowId, user: userId }, { orderBy: NEWEST_FIRST, populate: ['messages'] })
    return row ? withMessages(row) : null
  }

  async list(flowId: string): Promise<StoredConversationMeta[]> {
    const rows = await this.dataAccess.em().find(AgentConversation, { flow: flowId }, { orderBy: NEWEST_FIRST, fields: [...META_FIELDS] })
    return rows.map(toMeta)
  }

  async get(flowId: string, id: string): Promise<StoredConversation | null> {
    const row = await this.dataAccess.em().findOne(AgentConversation, { id, flow: flowId }, { populate: ['messages'] })
    return row ? withMessages(row) : null
  }

  async getWithContext(flowId: string, userId: string, id: string): Promise<StoredConversationWithContext | null> {
    const row = await this.dataAccess.em().findOne(AgentConversation, { id, flow: flowId, user: userId }, { populate: ['messages', 'llmMessages', 'canvasDigest'] })
    if (!row) return null
    return {
      ...withMessages(row),
      llmMessages: parseArray<StoredConversationWithContext['llmMessages'][number]>(row.llmMessages),
      // 坏数据兜成 null：下一轮少一份跨轮差异，不值得让它失败
      canvasDigest: row.canvasDigest ? parseCanvasDigest(row.canvasDigest) : null,
    }
  }

  async create(input: NewConversationInput): Promise<StoredConversationMeta> {
    const em = this.dataAccess.em()
    const row = em.create(AgentConversation, {
      flow: input.flowId,
      user: input.userId,
      title: input.title,
      summary: input.summary,
      messageCount: input.messages.length,
      messages: JSON.stringify(input.messages),
      llmMessages: JSON.stringify(input.llmMessages),
      // em.create 不会替没给的可空字段填 null（.claude/rules/database.md）
      canvasDigest: null,
      nodeId: input.nodeId,
      skills: '[]',
    })
    await em.flush()
    return toMeta(row)
  }

  async save(flowId: string, userId: string, id: string, patch: ConversationPatch): Promise<boolean> {
    // nativeUpdate 不触发 onUpdate：updatedAt 自己写
    const count = await this.dataAccess.em().nativeUpdate(
      AgentConversation,
      { id, flow: flowId, user: userId },
      {
        messages: JSON.stringify(patch.messages),
        messageCount: patch.messages.length,
        summary: patch.summary,
        ...(patch.llmMessages ? { llmMessages: JSON.stringify(patch.llmMessages) } : {}),
        ...(patch.canvasDigest !== undefined ? { canvasDigest: patch.canvasDigest ? JSON.stringify(patch.canvasDigest) : null } : {}),
        ...(patch.skills ? { skills: JSON.stringify(patch.skills) } : {}),
        updatedAt: new Date(),
      },
    )
    return count > 0
  }

  /** 不写 updatedAt：改标题不算会话有新内容 */
  async rename(flowId: string, userId: string, id: string, title: string): Promise<boolean> {
    return (await this.dataAccess.em().nativeUpdate(AgentConversation, { id, flow: flowId, user: userId }, { title })) > 0
  }

  async remove(flowId: string, userId: string, id: string): Promise<boolean> {
    return (await this.dataAccess.em().nativeDelete(AgentConversation, { id, flow: flowId, user: userId })) > 0
  }
}

/** PG 的 `int` 是 32 位：落库的整数夹在这个范围里（超出的写不进去，整行收尾就丢了） */
const INT_MAX = 2_147_483_647

const storedInt = (value: number) => Math.min(INT_MAX, Math.max(0, Math.round(value)))

/** 一轮的用量 → `agent_run` 的列。费用从美元换成整数的微美元，舍入只在合计上做这一次 */
export function usageColumns(usage: AgentRunUsage) {
  return {
    inputTokens: storedInt(usage.inputTokens),
    outputTokens: storedInt(usage.outputTokens),
    cacheReadTokens: storedInt(usage.cacheReadTokens),
    cacheWriteTokens: storedInt(usage.cacheWriteTokens),
    costMicroUsd: usage.costUsd === null ? null : storedInt(usage.costUsd * 1_000_000),
  }
}

/** 运行日志。调用方（编排层）对这里抛出的错误一律 fail open，所以这里不吞错：吞了，日志里就看不到没写进去 */
@Injectable()
export class AgentRunLog implements AgentRunLogPort {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  async startRun(run: AgentRunStart): Promise<void> {
    await this.dataAccess.em().insert(AgentRun, {
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
  }

  async recordToolCall(call: AgentToolCallRecord): Promise<void> {
    // insert 不走工作单元：id / createdAt 的 onCreate 不触发，自己给
    await this.dataAccess.em().insert(AgentToolCall, {
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
  }

  /** 按 runId upsert：startRun 那一笔没写进去，结尾这一笔照样留下完整的一行。撞上已有行时只改收尾的字段 */
  async finishRun(run: AgentRunFinish): Promise<void> {
    await this.dataAccess.em().upsert(
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
        onConflictMergeFields: ['grantId', 'status', 'error', 'toolCallCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costMicroUsd', 'finishedAt'],
      },
    )
  }
}

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

export interface GrantState {
  id: string
  expiresAt: Date
  revokedAt: Date | null
  revokeReason: string | null
}

/**
 * 委托授权（Grant，docs/22 §3）的表。**没有 `revokeAllForUser`**：账号级撤销在旧服务也没有生产调用方（`docs/31` §4.4），不搬。
 * 每次撤销都只写 `revokedAt` 还为空的行，所以第一个原因留下。
 */
@Injectable()
export class AgentGrants {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /** 一个 Grant 和它的全部 scope，一个事务写下 */
  create(input: NewGrant): Promise<string> {
    return this.dataAccess.transactional(async (em) => {
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
  }

  async state(grantId: string): Promise<GrantState | null> {
    const row = await this.dataAccess.em().findOne(AgentGrant, grantId, { fields: ['id', 'expiresAt', 'revokedAt', 'revokeReason'] })
    return row ? { id: row.id, expiresAt: row.expiresAt, revokedAt: row.revokedAt, revokeReason: row.revokeReason } : null
  }

  /** 撤销 / 关闭一份；返回 false = 已经撤销过（原因保持先写下的那个） */
  async revoke(grantId: string, reason: string, at = new Date()): Promise<boolean> {
    return (await this.dataAccess.em().nativeUpdate(AgentGrant, { id: grantId, revokedAt: null }, { revokedAt: at, revokeReason: reason })) > 0
  }

  /** 过了 `expiresAt` 还没撤销的标成到期（定时对账用，进程崩溃留下的孤儿也在这里收掉）。返回标了几份 */
  expireDue(reason: string, now = new Date()): Promise<number> {
    return this.dataAccess.em().nativeUpdate(AgentGrant, { revokedAt: null, expiresAt: { $lte: now } }, { revokedAt: now, revokeReason: reason })
  }
}
