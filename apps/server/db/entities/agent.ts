import { defineEntity, p, type InferEntity } from '@mikro-orm/core'
import { User } from './auth.ts'
import { Flow } from './canvas.ts'
import { createdAtColumn, idColumn, updatedAtColumn } from './columns.ts'

// 画布 Agent 的持久化（REQ-AGENT，docs/20-agent-canvas.md）：会话 + 运行日志 + 委托授权（Grant，docs/22-agent-sandbox.md）。
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
    /**
     * 上一轮结束时的画布摘要，JSON 字符串：`@shadecn/agent` 的 `CanvasDigest`（节点 id → 类型、名字、分组、字段值哈希；连线两端）。
     * 下一轮开始时拿它和现在的画布比，告诉模型「自你上次运行以来画布的变化」（docs/20 §3.10.2）。
     * 从没跑完过一轮 / 画布太大没存 → null。lazy：只有跑一轮时要
     */
    canvasDigest: p.text().strictNullable().lazy(),
    /**
     * 会话的入口节点 id（docs/20 §3.10.9：从导演台里发起的会话记下这个节点，只用来在那里默认打开最近的会话）；没有为 null。
     * 建会话时定下，之后不改；不限制工具、不触发技能加载。只是 id、不是外键：节点在 Y.Doc 里，不在库里；节点被删了会话照样在
     */
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
    /** 这一轮凭的 Grant（{@link AgentGrant} 的 id）；签发不出来（发起时就已失权）为 null */
    grantId: p.text().strictNullable(),
    /**
     * running | success | cancelled | error | expired（expired = Grant 到期）。失权被叫停的是 cancelled，原因在 `error`。
     * 进程被硬杀时会永远停在 running
     */
    status: p.text(),
    /** 收尾原因（给人看的中文）：失败的报错，或中止 / 失权 / 到期的原因；success 为 null */
    error: p.text().strictNullable(),
    toolCallCount: p.integer().default(0),
    /** 给人看的模型名 */
    model: p.text().strictNullable(),
    /*
     * 这一轮累计的模型用量（docs/22 §4.3 第 5 步）：服务端调模型拿到的 usage，父 agent + 全部子 agent，收尾时写。
     * 都可空：null = 没记（进程被硬杀停在 running 的行、有这几列之前的旧行），和「一个 token 都没用」的 0 分得开。
     * 加的是可空列，`db:push` 直接加（不重建表）。PG 上 `p.integer()` 是 32 位 int：一轮的 token 数到不了 21 亿
     */
    /** 输入 token（不含缓存命中 / 写入那部分，pi-ai 的 `usage.input`） */
    inputTokens: p.integer().strictNullable(),
    outputTokens: p.integer().strictNullable(),
    cacheReadTokens: p.integer().strictNullable(),
    cacheWriteTokens: p.integer().strictNullable(),
    /**
     * 费用，**百万分之一美元**（整数）：只能用五种列类型（没有小数 / decimal，见 ./columns.ts），浮点又不能精确求和；
     * 微美元在最便宜的模型上也能分辨几十个 token，32 位上限约 2147 美元一轮，够用（超出按上限记）。
     * 舍入只在整轮的合计上做一次。null = 模型没有价格信息（自定义端点），或没记
     */
    costMicroUsd: p.integer().strictNullable(),
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
    /** 这次调用凭的 Grant —— 审计回答「谁、哪个 run、哪份 Grant、做了什么」（docs/22 §10 验收 6） */
    grantId: p.text().strictNullable(),
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

/**
 * 委托授权（Grant，docs/22 §3）：发起人在一轮开始时签给这一轮（run）的授权。它才是这一轮的执行身份 ——
 * 不是发起人的登录态（退出登录、会话过期都不影响它）。
 *
 * **全部是普通 id，不建外键**（同 {@link AgentRun}）：审计要回答「被删掉的那张画布 / 那个人当时凭什么做了这些」，
 * 建了外键就会被级联删掉或挡住删除。`projectId` / `projectKind` / `personalOwnerId` 是签发时的**快照**：
 * 判权时画布必须仍在同一个项目里（个人画布仍是同一个所有者），挪走了就算失权。
 *
 * 有效与否看三列：`revokedAt` 为空、`expiresAt` 在将来 —— 再与发起人此刻的权限取交集（`apps/server/agent/authority.ts`）。
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
    /** 签发时画布所在的项目 */
    projectId: p.text(),
    /** 签发时项目的形态：team | personal */
    projectKind: p.text(),
    /** 签发时个人空间的所有者；项目画布为 null */
    personalOwnerId: p.text().strictNullable(),
    /** 绝对过期时间（这一轮的时长上限 + 余量）。到了这一轮转 expired */
    expiresAt: p.datetime(),
    /** 撤销 / 关闭的时刻；null = 仍有效 */
    revokedAt: p.datetime().strictNullable(),
    /** 撤销原因（给人看的中文）：失权、到期、账号级撤销、本轮已结束 */
    revokeReason: p.text().strictNullable(),
    createdAt: createdAtColumn(),
  },
  indexes: [{ properties: ['runId'] }, { properties: ['userId', 'revokedAt'] }],
})
export type AgentGrant = InferEntity<typeof AgentGrant>

/**
 * Grant 的一项授权范围。一个 Grant 多行，`grantId` 只是 id（理由同上）。
 *
 * - `scope`：`flow:read` / `flow:write` / `flow:delete` / `llm:invoke` / `sandbox:exec`（`@shadecn/agent/authority`）；
 * - `resource`：`flow:<id>` / `model:<provider/id>` / `run:<id>`；
 * - `onRevoke`：这一项失效时怎么处置，`stop` | `pause` | `degrade` | `finish_current` —— **一期只实现 `stop`**，
 *   列先按四种值留好（docs/22 §9 第六期的部分撤销），免得到时改表；
 * - `required`：这一项失效时这一轮还能不能继续（一期全部是 true）。
 */
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
