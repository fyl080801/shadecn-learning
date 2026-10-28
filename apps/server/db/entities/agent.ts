import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { User } from './auth.ts'
import { Flow } from './canvas.ts'
import { createdAtColumn, idColumn, updatedAtColumn } from './columns.ts'

// 画布 Agent 的持久化（REQ-AGENT，docs/20-agent-canvas.md）：会话 + 运行日志。
// 写实体的规矩见 ./columns.ts 的头注释；读写都在 apps/server/store/agent.ts，接口在 @shadecn/agent/store。

/**
 * 一个会话：一个人在一张画布上和 agent 的一段对话。一个人在一张画布上可以有多个。
 *
 * 归属是「画布 + 用户」，所以两边都是真外键、跟着级联：人没了 / 画布行没了，会话就没有意义了
 * （画布是软删，软删期间会话留着，接口层的 requireFlowMember 已经让它们不可见）。
 *
 * `messages` / `llmMessages` 是 **lazy** 的：列表只要标题和摘要，一个会话的模型上下文
 * （里面有 read_canvas 回来的整张画布 JSON）可以有几百 KB，不该被列表顺手带出来。
 */
export const AgentConversation = defineEntity({
  name: 'AgentConversation',
  properties: {
    id: idColumn(),
    flow: () => p.manyToOne(Flow).deleteRule('cascade'),
    user: () => p.manyToOne(User).deleteRule('cascade'),
    /** 首条用户消息的开头（原文，可含提及），建会话时定下，之后不改 */
    title: p.text(),
    /** 最近一条 assistant 回复的开头（纯文本）；每轮结束时重算 */
    summary: p.text().default(''),
    /** = messages 的条数，冗余一份给列表用，免得为了数条数去读 lazy 列 */
    messageCount: p.integer().default(0),
    /** 给前端的对话记录，JSON 字符串：`AgentChatMessage[]` */
    messages: p.text().default('[]').lazy(),
    /** 模型上下文，JSON 字符串：pi 的 `AgentMessage[]`（已裁剪，切口在用户消息上） */
    llmMessages: p.text().default('[]').lazy(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  // 列表 / latest：where flow + user order by updatedAt desc
  indexes: [{ properties: ['flow', 'user', 'updatedAt'] }],
})
export type AgentConversation = InferEntity<typeof AgentConversation>

/**
 * 一轮 agent 运行的日志（docs/20 §3.9 ⑤ / F13）。
 *
 * **会话 / 画布 / 用户都只是 id，不建外键**：这是审计记录，要回答的正是「被删掉的那张画布上
 * agent 当时做了什么」—— 建了外键，删会话或删画布就会把它级联删掉（或者反过来挡住删除），
 * 两种都不对。
 *
 * 主键就是 runId（`run_<时间戳>_<随机段>`，编排层生成，事件流里带出去的同一个），
 * 不另造 UUID：日志、SSE、console 输出用同一个 id 才对得上。由调用方给值，所以不用 idColumn() 的 onCreate。
 */
export const AgentRun = defineEntity({
  name: 'AgentRun',
  properties: {
    id: p.text().primary(),
    conversationId: p.text(),
    flowId: p.text(),
    userId: p.text(),
    /** running | success | cancelled | error。进程被硬杀时会永远停在 running */
    status: p.text(),
    /** 失败 / 中止的原因 */
    error: p.text().strictNullable(),
    toolCallCount: p.integer().default(0),
    /** 给人看的模型名 */
    model: p.text().strictNullable(),
    startedAt: p.datetime(),
    finishedAt: p.datetime().strictNullable(),
  },
  indexes: [{ properties: ['flowId', 'startedAt'] }],
})
export type AgentRun = InferEntity<typeof AgentRun>

/**
 * 一次工具调用的日志。同 {@link AgentRun}：`runId` 只是 id，不建外键。
 *
 * **不记正文**：`args` 是参数摘要（id 类字段照写、字符串只记长度，见 `@shadecn/agent/session` 的
 * `digestArgs`），节点的名字、正文、用户的话都不进这张表。
 */
export const AgentToolCall = defineEntity({
  name: 'AgentToolCall',
  properties: {
    id: idColumn(),
    runId: p.text(),
    /** 模型给的工具调用 id（同 SSE 里的 toolCallId） */
    toolCallId: p.text(),
    /** 工具名，如 add_node */
    name: p.text(),
    ok: p.boolean(),
    /** 参数摘要 */
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
