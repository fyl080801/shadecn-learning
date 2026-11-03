import { Flow } from '@learning/canvas'
import { createdAtColumn, idColumn, updatedAtColumn, User } from '@learning/data-access'
import { defineEntity, type InferEntity, p } from '@mikro-orm/core'

// 画布 Agent 的持久化（docs/20、docs/31 §4.2）：会话 + 运行日志 + 委托授权（Grant，docs/22）。读写都在 ./stores.ts，接口在 @learning/agent-core/store。
// 和 `@shadecn/mod-agent` 是两份定义，互不同步。

/**
 * 一个会话：一个人在一张画布上和 agent 的一段对话。一个人在一张画布上可以有多个。
 *
 * 归属是「画布 + 用户」，所以两边都是真外键、跟着级联：人没了 / 画布行没了，会话就没有意义了
 * （画布是软删，软删期间会话留着，接口层的 `FlowMemberGuard` 已经让它们不可见）。
 *
 * `messages` / `llmMessages` 是 **lazy** 的：列表只要标题和摘要，一个会话的模型上下文（里面有 read_canvas 回来的整张画布 JSON）可以有几百 KB。
 */
export const AgentConversation = defineEntity({
  name: 'AgentConversation',
  properties: {
    id: idColumn(),
    flow: () => p.manyToOne(Flow).deleteRule('cascade'),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /** 首条用户消息的开头（原文，可含提及）；之后只有生成标题时改 */
    title: p.text(),
    /** 最近一条 assistant 回复的开头（纯文本）；每轮结束时重算 */
    summary: p.text().default(''),
    /** = messages 的条数，冗余一份给列表用，免得为了数条数去读 lazy 列 */
    messageCount: p.integer().default(0),
    /** 给前端的对话记录，JSON 字符串：`AgentChatMessage[]` */
    messages: p.text().default('[]').lazy(),
    /** 模型上下文，JSON 字符串：pi 的 `AgentMessage[]`（已裁剪，切口在用户消息上） */
    llmMessages: p.text().default('[]').lazy(),
    /** 上一轮结束时的画布摘要，JSON 字符串：`CanvasDigest`。从没跑完过一轮 / 画布太大没存 → null。lazy：只有跑一轮时要 */
    canvasDigest: p.text().strictNullable().lazy(),
    /** 会话的入口节点 id（docs/20 §3.10.9）；只是 id、不是外键：节点在 Y.Doc 里，不在库里 */
    nodeId: p.text().strictNullable(),
    /** 这个会话加载过的技能 id，JSON 字符串数组（docs/23 §3.4，只增不减）。列表要显示，不 lazy */
    skills: p.text().default('[]'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  // 列表 / latest：where flow + user order by updatedAt desc
  indexes: [{ properties: ['flow', 'user', 'updatedAt'] }],
})
export type AgentConversation = InferEntity<typeof AgentConversation>

/**
 * 一轮 agent 运行的日志（docs/20 §3.9）。
 *
 * **会话 / 画布 / 用户都只是 id，不建外键**：这是审计记录，要回答的正是「被删掉的那张画布上 agent 当时做了什么」。
 * 主键就是 runId（编排层生成，事件流里带出去的同一个），所以不用 idColumn() 的 onCreate。
 */
export const AgentRun = defineEntity({
  name: 'AgentRun',
  properties: {
    id: p.text().primary(),
    conversationId: p.text(),
    flowId: p.text(),
    userId: p.text(),
    /** 这一轮凭的 Grant；签发不出来（发起时就已失权）为 null */
    grantId: p.text().strictNullable(),
    /** running | success | cancelled | error | expired（Grant 到期）。失权被叫停的是 cancelled，原因在 `error`。进程被硬杀时会永远停在 running */
    status: p.text(),
    /** 收尾原因（给人看的中文）；success 为 null */
    error: p.text().strictNullable(),
    toolCallCount: p.integer().default(0),
    /** 给人看的模型名 */
    model: p.text().strictNullable(),
    /* 累计的模型用量（docs/22 §4.3 第 5 步），收尾时写。null = 没记，和「一个 token 都没用」的 0 分得开。PG 上 `p.integer()` 是 32 位 */
    inputTokens: p.integer().strictNullable(),
    outputTokens: p.integer().strictNullable(),
    cacheReadTokens: p.integer().strictNullable(),
    cacheWriteTokens: p.integer().strictNullable(),
    /** 费用，百万分之一美元（整数）：没有小数列，浮点又不能精确求和。null = 模型没有价格信息，或没记 */
    costMicroUsd: p.integer().strictNullable(),
    startedAt: p.datetime(),
    finishedAt: p.datetime().strictNullable(),
  },
  indexes: [{ properties: ['flowId', 'startedAt'] }],
})
export type AgentRun = InferEntity<typeof AgentRun>

/** 一次工具调用的日志。`runId` 只是 id（理由同 {@link AgentRun}）。**不记正文**：`args` 是参数摘要（`digestArgs`） */
export const AgentToolCall = defineEntity({
  name: 'AgentToolCall',
  properties: {
    id: idColumn(),
    runId: p.text(),
    /** 这次调用凭的 Grant（docs/22 §10 验收 6） */
    grantId: p.text().strictNullable(),
    /** 模型给的工具调用 id */
    toolCallId: p.text(),
    name: p.text(),
    ok: p.boolean(),
    args: p.text(),
    /** 影响到的元素 id，JSON 字符串数组 */
    elementIds: p.text().default('[]'),
    /** 失败原因（工具自己的报错，截短） */
    error: p.text().strictNullable(),
    durationMs: p.integer(),
    createdAt: createdAtColumn(),
  },
  indexes: [{ properties: ['runId'] }],
})
export type AgentToolCall = InferEntity<typeof AgentToolCall>

/**
 * 委托授权（Grant，docs/22 §3）：发起人在一轮开始时签给这一轮的授权，它才是这一轮的执行身份，不是发起人的登录态。
 *
 * **全部是普通 id，不建外键**（同 {@link AgentRun}）。`projectId` / `projectKind` / `personalOwnerId` 是签发时的**快照**：判权时画布必须仍在同一个项目里，挪走了就算失权。
 * 一轮结束时也写 `revokedAt`（原因「本轮已结束」）：结束之后它不能再被用来做任何事。
 */
export const AgentGrant = defineEntity({
  name: 'AgentGrant',
  properties: {
    id: idColumn(),
    /** 发起人（授权方） */
    userId: p.text(),
    runId: p.text(),
    flowId: p.text(),
    projectId: p.text(),
    /** team | personal */
    projectKind: p.text(),
    /** 个人空间的所有者；项目画布为 null */
    personalOwnerId: p.text().strictNullable(),
    /** 绝对过期时间（这一轮的总时长上限 + 余量） */
    expiresAt: p.datetime(),
    /** 撤销 / 关闭的时刻；null = 仍有效 */
    revokedAt: p.datetime().strictNullable(),
    /** 撤销原因（给人看的中文） */
    revokeReason: p.text().strictNullable(),
    createdAt: createdAtColumn(),
  },
  indexes: [{ properties: ['runId'] }, { properties: ['userId', 'revokedAt'] }],
})
export type AgentGrant = InferEntity<typeof AgentGrant>

/** Grant 的一项授权范围，`grantId` 只是 id。`onRevoke` 留了四种值，只实现 `stop`（docs/22 §9）；`required` 目前全是 true */
export const AgentGrantScope = defineEntity({
  name: 'AgentGrantScope',
  properties: {
    id: idColumn(),
    grantId: p.text(),
    scope: p.text(),
    resource: p.text(),
    onRevoke: p.text(),
    required: p.boolean(),
  },
  indexes: [{ properties: ['grantId'] }],
})
export type AgentGrantScope = InferEntity<typeof AgentGrantScope>

/** 这个包的全部表，经 `DATA_ACCESS_ENTITIES` 登记 */
export const AGENT_ENTITIES = [AgentConversation, AgentRun, AgentToolCall, AgentGrant, AgentGrantScope]
