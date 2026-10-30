/**
 * 画布 Agent 的前后端契约（REQ-AGENT，`docs/20-agent-canvas.md`）。
 *
 * 一张画布 = agent 的一个工作项目：会话、运行、沙箱工作目录都按 `flowId` 归属；
 * 一张画布上每个用户可以有多个会话（持久化在服务端数据库，见下面「会话」一节），
 * 并发单位是**会话**：一个会话同时只跑一轮，不同会话、不同的人可以同时跑（docs/20 §3.10.3）。
 * 这里只放两边都要认的东西 —— 接口路径、流式事件的形状、对话消息的形状、
 * 以及「提及节点」在 prompt 文本里的写法。实现分别在
 * `apps/server/agent/` 和 `apps/web/src/components/flow/agent/`。
 *
 * 只用 ES2020，不碰 DOM / Node API（见本包 tsconfig 的护栏）。
 */

import { AGENT_RUNS_MESSAGE } from './collab.ts'

/** 接口都挂在画布下面，鉴权跟着 `requireFlowMember` 走（每次请求重查）：非成员 404 */
export function agentApiPath(flowId: string): string {
  return `/api/flows/${encodeURIComponent(flowId)}/agent`
}

// —— 提及节点 ——
//
// prompt 是一段纯文本，提及的节点以 `@{node:<id>}` 内嵌其中。
// 前端 prompt-input 的提及插件按这个格式 parse / serialize；服务端按它把 id 换成
// 节点的当前名字与内容再交给模型。节点改名不影响提及 —— 认的是 id，不是名字。

/** 全局匹配；用之前记得 `lastIndex = 0`，或者直接调下面的函数 */
export const NODE_MENTION_PATTERN = /@\{node:([A-Za-z0-9_-]+)\}/g

export function formatNodeMention(nodeId: string): string {
  return `@{node:${nodeId}}`
}

/** 文本里提及了哪些节点（去重，保持首次出现的顺序） */
export function parseNodeMentions(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(NODE_MENTION_PATTERN)) {
    const id = match[1]!
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

// —— 请求 ——

/** `POST {agentApiPath}/messages` 的请求体 */
export interface AgentPromptRequest {
  /** 用户输入，可含 `@{node:<id>}`；去掉首尾空白后不能为空 */
  text: string
  /**
   * 发到哪个会话。`null` / 不给 = **新会话**：服务端在这一轮开始时建好它，
   * id 由 RUN_STARTED 的 `threadId` 带回来；新会话总是可以发起（不受别的会话在跑影响）。
   *
   * 给了 id 时：这张画布上没有这个会话 → 404；是别人的会话（项目画布上只读可见）→ 403；
   * 这个会话此刻已经有一轮在跑 → 409（一个会话同时只跑一轮）。
   *
   * 「发起新会话」按钮因此只是前端把当前会话置空，不发请求 —— 不会留下一堆空会话。
   */
  conversationId?: string | null
  /**
   * 会话的入口节点（docs/20 §3.10.9、docs/07 §7.5）：从导演台里发起的新会话记下这个节点，只用来在那里默认打开
   * 「我在这个节点上最近的会话」。**只在新建会话时给**（和 `conversationId` 同时给 → 400）；节点不在这张画布上 → 404。
   * 它**不限制**工具、不影响占用、也不触发技能加载 —— 所有会话都是全局 agent，指定节点靠消息里的提及。
   */
  nodeId?: string | null
}

/** 单条 prompt 的长度上限（字符数），服务端超限 400 */
export const AGENT_PROMPT_MAX_LENGTH = 4000

// —— 对话记录 ——

export interface AgentToolCallView {
  id: string
  /** 工具名，如 `add_node` */
  name: string
  /** 给人看的一句话（「新建节点 xxx」），不是原始参数 */
  summary: string
  status: 'running' | 'done' | 'error'
  /** 出错时的原因 */
  error?: string
}

export type AgentChatMessage =
  | { id: string; role: 'user'; text: string; createdAt: number }
  | {
      id: string
      role: 'assistant'
      /** 模型的文字回复（可能为空：只调了工具） */
      text: string
      toolCalls: AgentToolCallView[]
      createdAt: number
      /** 这一轮以失败 / 中止收尾时的说明 */
      error?: string
    }
  | AgentCanvasChangeMessage
  | AgentSkillLoadedMessage

// —— 技能（docs/23） ——

/**
 * 内置技能的 id（`canvas` / `media-view` / `media-exec` / `director` / …）：发布后不改，对话记录里存的就是它。
 * 有哪些技能由服务端的注册表定（`@shadecn/agent` 的 `skills/`），这里不枚举 —— 前端只拿它做 key，显示用 {@link AgentSkillView.title}。
 */
export type AgentSkillId = string

/**
 * 合并 / 改名掉的技能 id → 现在的 id。对话记录里存着旧的，**读出时**换成新的（{@link canonicalSkillIds}）。
 * `canvas-edit`：原先写画布的技能，和只读的 `canvas` 合成了一个（docs/23 §4）。
 */
export const AGENT_SKILL_ID_ALIASES: ReadonlyMap<AgentSkillId, AgentSkillId> = new Map([['canvas-edit', 'canvas']])

/** 存下来的技能 id 换成现在的：旧 id 按 {@link AGENT_SKILL_ID_ALIASES} 换掉，换完重复的只留第一次出现的位置 */
export function canonicalSkillIds(ids: readonly AgentSkillId[]): AgentSkillId[] {
  return [...new Set(ids.map((id) => AGENT_SKILL_ID_ALIASES.get(id) ?? id))]
}

/** 一个技能给人看的样子 */
export interface AgentSkillView {
  id: AgentSkillId
  /** 「画布」「查看素材」；服务端注册表里已经没有这个技能时就是 id 本身 */
  title: string
}

/**
 * 一次技能加载（模型调 `load_skill` 成功）：对话里一行「已加载：<标题>」。
 * 实时流里经 CUSTOM {@link AGENT_SKILL_LOADED_EVENT} 到达（`value` 就是这条消息），和 `canvas-change` 一样排在这一轮的
 * assistant 消息之后、随这一轮落库，刷新 / 接回补发 / 只读旁观看到的是同一条。
 * 一轮开始时自动加载的技能不发这一条（不逐条刷屏），只出现在会话的 {@link AgentConversationSummary.skills} 里。
 */
export interface AgentSkillLoadedMessage {
  id: string
  role: 'skill-loaded'
  skill: AgentSkillView
  createdAt: number
}

/**
 * 画布改动通知（docs/20 §3.10.2）：别人对画布的改动，作为一行系统提示出现在对话里。
 *
 * - `live`：这一轮运行期间别人（成员 / 别的 agent）改了画布，服务端合并成摘要插进模型上下文
 *   （下一次请求模型之前）时发出；在对话里排在这一轮的 assistant 消息之后。
 * - `since-last-run`：这一轮开始时对比上一轮结束时存下的画布摘要得出的差异（不区分是谁改的），
 *   排在这一轮的用户消息之后、assistant 消息之前。
 *
 * 实时流里经 CUSTOM {@link AGENT_CANVAS_CHANGE_EVENT} 到达（`value` 就是这条消息），
 * 这一轮结束时和 assistant 消息一起落库，刷新后从会话里读回来的是同一条。
 * 它不是模型说的话，也不是用户的指令 —— 前端显示成灰色的一行，不当气泡。
 */
export interface AgentCanvasChangeMessage {
  id: string
  role: 'canvas-change'
  scope: 'live' | 'since-last-run'
  /** 一行概括（「张三 改动了画布（3 处）」），折叠时只显示它 */
  summary: string
  /** 每处改动一行（已按上限截断，见 `omitted`）；展开时显示 */
  items: string[]
  /** 改动者的显示名（「张三」「李四 的 agent」「其他协作者」）；`since-last-run` 为空数组 */
  actors: string[]
  /** 超出上限没列出来的改动数；0 = 全列了 */
  omitted: number
  createdAt: number
}

// —— 会话 ——
//
// 会话持久化在服务端数据库里，**按「画布 + 发起人」归属**：
// - **项目画布**：成员能看到这张画布上所有人的会话（列表、内容，只读）—— 看别人的 agent 在改什么、为什么改；
//   只有发起人能往里继续发消息、删除它（别人 403）。不存在的会话 / 不在这张画布上的 → 404。
// - **个人画布**：只有所有者进得来，所以列表里只有他自己的会话（`mine` 恒为 true）。
//
// 并发单位是会话：一个会话同时只跑一轮；不同会话、不同的人可以在同一张画布上同时跑（docs/20 §3.10.3）。
// 每轮的删除上限、工具调用日志、补发缓冲、中止都按各自那一轮计。

/**
 * 会话 / 一轮的发起人。名字的取值顺序与协同层在场信息一致（服务端 `displayNameOf`），
 * 同一个人在两处不会叫两个名字；**接口上没有邮箱字段**。
 */
export interface AgentUserView {
  id: string
  name: string
  /** 头像地址，同 `ProjectMemberView.avatarUrl`；没有为 null */
  avatarUrl: string | null
}

/** `GET {agentApiPath}` 的响应 —— 面板打开时（以及协同连接连上 / 重连时）的那一次 */
export interface AgentSessionView {
  /**
   * 服务端是否配置了模型；false 时前端只显示说明，不给输入框。**不带模型名**：用的是哪家、哪个模型是服务端的部署细节，
   * 界面上不展示，也就不该出现在接口里（打开开发者工具一样看得到）。运行日志表里仍记着它。
   */
  enabled: boolean
  /** 这张画布此刻是否有任务在跑（任何人的）；= `activeRuns.length > 0` */
  running: boolean
  /**
   * 这张画布上此刻正在跑的全部任务，按 `startedAt` 升序：项目画布是所有成员的，个人画布只有所有者的。
   * 之后的变化经协同连接上的 stateless 消息推送（{@link AgentRunsMessage}），不用轮询。
   */
  activeRuns: AgentActiveRunView[]
  /**
   * 面板默认打开的会话（含消息）：**我自己有任务在跑时是最近发起的那一轮所在的会话**，
   * 否则是我在这张画布上最近更新的那个（只挑我自己的）；一个都没有时为 null（新会话空状态）。
   */
  latest: AgentConversationView | null
}

/**
 * 运行中任务列表里的一项 —— 广播载荷（{@link AgentRunsMessage}）里的就是它。
 *
 * 只在这一轮**开始之后**（RUN_STARTED 已发出、会话已建好）才出现，所以 `conversationId` 总有值；
 * 这一轮彻底结束（最后一帧发出、画布关掉、运行日志写完）时离开列表。
 */
export interface AgentRunEntry {
  runId: string
  /** 这一轮所在的会话；项目成员可以只读打开它、订阅这一轮的事件流 */
  conversationId: string
  /** 会话标题（原文，可含 `@{node:<id>}`），同 `AgentConversationSummary.title` */
  conversationTitle: string
  /** 发起人 */
  owner: AgentUserView
  /** UTC epoch 毫秒 */
  startedAt: number
  /**
   * 这一轮所在会话的入口节点（会话的 `nodeId`，docs/20 §3.10.9）：导演台暂时据它显示「某某的助手正在编辑这个场景」，
   * 之后由占用（docs/20 §3.10.8 的 `occupies`）替换。没有入口的会话没有这个字段（不是 null —— 老的载荷里本来就没有，读的一侧一律按「没有」处理）。
   */
  nodeId?: string
}

/**
 * `GET {agentApiPath}` 里的一项：{@link AgentRunEntry} + 「是不是我的」。
 *
 * **一轮不随发起它的那个 HTTP 连接存亡**：关页面、刷新、断网都不会中止它，只有
 * {@link agentRunAbortPath}、时长上限、失权或服务端退出会。所以重新打开画布时要能接回去 ——
 * 任何能进这张画布的人都可以用 {@link agentRunEventsPath} 订阅它的事件（只读），
 * 能中止它的只有发起人和项目管理员。
 */
export interface AgentActiveRunView extends AgentRunEntry {
  /** 发起人是不是当前用户 —— 决定能不能在那个会话里继续发、能不能中止（管理员另算） */
  mine: boolean
}

/** 给广播里的列表补上 `mine`（广播发给整个房间，不能带 `mine`；前端按自己的 user id 算） */
export function withMine(runs: readonly AgentRunEntry[], userId: string): AgentActiveRunView[] {
  return runs.map((run) => ({ ...run, mine: run.owner.id === userId }))
}

/**
 * 接回 / 旁观一轮的事件流：`GET` → `text/event-stream`，帧格式同 `POST …/messages`。
 * 发起人与这张画布的其他成员都可以订阅（只读；项目画布上成员本就看得到别人的会话）。
 *
 * 服务端先**从头补发**这一轮已经发出的全部事件（从 RUN_STARTED 起），再接着推后续的，
 * 以 RUN_FINISHED / RUN_ERROR 收尾后关流；所以前端拿到的序列和发起时那条流一模一样，
 * 用同一套折叠逻辑即可。
 *
 * 和已落库消息的关系：这一轮的**用户消息**在调模型之前就已落库（所以这个会话 `messages`
 * 的最后一条就是它），**assistant 消息**要到这一轮结束才落库。前端先摆好会话的 `messages`，
 * 再折叠补发的事件：CUSTOM `agent.user-message` 的 id 与已有那条相同，按 id 去重而不是再插一条；
 * 之后的文字 / 工具事件照常拼出 assistant 消息。
 * 这一轮已经结束、runId 不对（或不在这张画布上）→ 404（前端改为重新拉会话）。
 * 补发缓冲有上限，超出时服务端回 410，前端同样改为等结束后重新拉会话。
 */
export function agentRunEventsPath(flowId: string, runId: string): string {
  return `${agentApiPath(flowId)}/runs/${encodeURIComponent(runId)}/events`
}

/**
 * 中止一轮：`POST`，成功 204。只有发起人和项目管理员能中止（别人 403）；
 * 这一轮已经结束 / runId 不对 → 同样 204（幂等：要的结果就是「它不在跑了」）。
 * 已经写进画布的改动保留。
 */
export function agentRunAbortPath(flowId: string, runId: string): string {
  return `${agentApiPath(flowId)}/runs/${encodeURIComponent(runId)}/abort`
}

// —— 运行中任务的推送 ——
//
// run 开始 / 结束时，服务端经 Hocuspocus 的 stateless 通道（`document.broadcastStateless`）
// 把这张画布当前的完整任务列表推给房间里的每条连接；两种画布都适用（个人画布的 awareness 被服务端整帧丢弃，
// 走不了在场层）。**只有服务端发得出**：客户端发的 stateless 只到服务端的 `onStateless` 钩子，
// Hocuspocus 不转发给别的连接，客户端也发不了「广播」那个操作码。
//
// 每条消息都是**全量**（不是增量）：前端直接替换，漏收一条不会积累误差。房间没加载（没人连着）时不发；
// 前端在协同连接连上 / 重连时先 `GET {agentApiPath}` 拉一次，补上没连着那段时间的变化。
//
// 多副本：任务登记表在各进程内存里（F14），每个副本只广播自己进程里的任务，
// 跨副本时列表不完整（甚至会被另一个副本的广播覆盖）。上共享层之前，这只在单副本下准确。

/** stateless 载荷（JSON）的形状 */
export interface AgentRunsMessage {
  type: typeof AGENT_RUNS_MESSAGE
  /** 哪张画布；前端拿它和当前画布比对，对不上就丢（换画布时的残留） */
  flowId: string
  /** 全量，按 `startedAt` 升序；没有在跑的为空数组 */
  runs: AgentRunEntry[]
}

/** 服务端用：序列化成 stateless 载荷 */
export function formatAgentRunsMessage(flowId: string, runs: readonly AgentRunEntry[]): string {
  const message: AgentRunsMessage = { type: AGENT_RUNS_MESSAGE, flowId, runs: [...runs] }
  return JSON.stringify(message)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseUser(value: unknown): AgentUserView | null {
  if (!isObject(value)) return null
  const { id, name, avatarUrl } = value
  if (typeof id !== 'string' || !id || typeof name !== 'string') return null
  if (avatarUrl !== null && avatarUrl !== undefined && typeof avatarUrl !== 'string') return null
  return { id, name, avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null }
}

function parseRunEntry(value: unknown): AgentRunEntry | null {
  if (!isObject(value)) return null
  const { runId, conversationId, conversationTitle, startedAt } = value
  const owner = parseUser(value.owner)
  if (typeof runId !== 'string' || !runId) return null
  if (typeof conversationId !== 'string' || !conversationId) return null
  if (typeof conversationTitle !== 'string') return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  if (!owner) return null
  // nodeId 可选：不是非空字符串就当没有（不因为它丢掉整项）
  const nodeId = typeof value.nodeId === 'string' && value.nodeId ? value.nodeId : undefined
  // 只取认得的字段：载荷里多出来的东西不往下传
  return { runId, conversationId, conversationTitle, owner, startedAt, ...(nodeId ? { nodeId } : {}) }
}

/**
 * 解析一条 stateless 消息里的任务列表；不是这类消息（或整体形状不对）就返回 `null`。
 *
 * **防御着写**，同 `parseStoreState`：stateless 是个通用旁路通道，一条读不懂的消息绝不能变成一次异常 ——
 * 那会打断整条连接的消息处理。列表里个别项形状不对时**只丢那一项**，其余照收：
 * 少显示一个任务，好过把整份列表当没收到、一直显示过期的那份。
 */
export function parseAgentRunsMessage(payload: string): { flowId: string; runs: AgentRunEntry[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.type !== AGENT_RUNS_MESSAGE) return null
  if (typeof parsed.flowId !== 'string' || !Array.isArray(parsed.runs)) return null
  const runs: AgentRunEntry[] = []
  for (const item of parsed.runs) {
    const run = parseRunEntry(item)
    if (run) runs.push(run)
  }
  return { flowId: parsed.flowId, runs }
}

/**
 * 会话列表里的一行（`GET {agentApiPath}/conversations`，按 `updatedAt` 倒序）。
 * 项目画布上是这张画布上**所有人**的会话（含已离开项目的人留下的），个人画布上只有所有者的。
 */
export interface AgentConversationSummary {
  id: string
  /** 第一条用户消息的开头（原文，可含 `@{node:<id>}`，前端按提及渲染），最多 `AGENT_TITLE_MAX_LENGTH` 字 */
  title: string
  /** 最近一条 assistant 回复的开头（纯文本），最多 `AGENT_SUMMARY_MAX_LENGTH` 字；还没有回复时为空串 */
  summary: string
  /** 消息条数（用户 + assistant） */
  messageCount: number
  /** UTC epoch 毫秒，同 `AgentChatMessage.createdAt` */
  createdAt: number
  updatedAt: number
  /** 发起人（会话的主人）。个人画布上恒为所有者，前端不显示 */
  owner: AgentUserView
  /** 是不是我的会话 —— 只有自己的会话能继续发、能删；别人的只读 */
  mine: boolean
  /** 这个会话此刻正在跑一轮（只可能是它的发起人发起的） */
  running: boolean
  /** 会话的入口节点（从导演台里发起的会话记下它，docs/20 §3.10.9）；没有为 null。建会话时定下，之后不变；不限制工具 */
  nodeId: string | null
  /** 这个会话加载过的技能（只增不减，docs/23 §3.4），按首次加载的先后；还没跑完过一轮为空数组 */
  skills: AgentSkillView[]
}

/** 一个会话的全部内容（`GET {agentApiPath}/conversations/:id`；能进这张画布的人都能读，别人的只读） */
export interface AgentConversationView extends AgentConversationSummary {
  messages: AgentChatMessage[]
}

export const AGENT_TITLE_MAX_LENGTH = 60
export const AGENT_SUMMARY_MAX_LENGTH = 120

/** 会话接口的路径；删除是 `DELETE` 同一路径（只有发起人能删，别人 403；正在跑时 409） */
export function agentConversationPath(flowId: string, conversationId?: string): string {
  const base = `${agentApiPath(flowId)}/conversations`
  return conversationId ? `${base}/${encodeURIComponent(conversationId)}` : base
}

// —— 流式事件：AG-UI ——
//
// `POST {agentApiPath}/messages` 以 `text/event-stream` 回复，事件是
// [AG-UI](https://docs.ag-ui.com) 协议的子集，字段名与 `@ag-ui/core` 1.0.3 的类型逐一对齐。
// 帧格式照 AG-UI 的 HTTP SSE 编码：只有 `data: <事件 JSON>\n\n`，**不带 `event:` 行**，
// 类型看 JSON 里的 `type`。
//
// 为什么自己声明而不依赖 `@ag-ui/core`：本包只放类型和纯函数、不引第三方运行时，
// 而这里只用得到十来个字段；协议字段名照抄，将来前端换 `@ag-ui/client` 直接能读。
// pi（`@mariozechner/pi-agent-core`）自己没有对外的线上协议 —— 它的 `AgentEvent`
// 只在进程内 `subscribe`，映射成 AG-UI 在 `@shadecn/agent` 里集中做。
//
// 顺序：
//   RUN_STARTED → CUSTOM(agent.user-message) → CUSTOM(agent.canvas-change, since-last-run)?
//   → ( TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END
//     | TOOL_CALL_START → TOOL_CALL_ARGS* → TOOL_CALL_END → TOOL_CALL_RESULT
//     | CUSTOM(agent.canvas-change, live) | CUSTOM(agent.skill-loaded) )*
//   → RUN_FINISHED | RUN_ERROR
// 最后一帧之后服务端关流。同一轮里 assistant 的文字可能分几段（每次调工具前后各一段），
// 它们共用一个 `messageId` —— 对应对话记录里的同一条 assistant 消息。
//
// **画布状态不走 AG-UI 的 STATE_SNAPSHOT / STATE_DELTA**：画布内容是 Y.Doc，
// agent 的改动经协同层实时到达，这条流只讲「agent 在说什么、在做什么」。

/** 与 `@ag-ui/core` 的 `EventType` 同值；这里只列用到的 */
export const AgentEventType = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  CUSTOM: 'CUSTOM',
} as const

export type AgentEventTypeName = (typeof AgentEventType)[keyof typeof AgentEventType]

/** AG-UI 的 BaseEvent 公共字段 */
interface AgentBaseEvent {
  timestamp?: number
}

/** `TOOL_CALL_START` / `TOOL_CALL_RESULT` 的 metadata —— 给人看的那一句和状态 */
export interface AgentToolCallMetadata {
  summary: string
  status: AgentToolCallView['status']
  error?: string
}

/** CUSTOM 事件的名字：服务端回显用户消息（带服务端分配的 id），前端拿它替换乐观插入的那条 */
export const AGENT_USER_MESSAGE_EVENT = 'agent.user-message'

/** CUSTOM 事件的名字：画布改动通知（{@link AgentCanvasChangeMessage}），前端按 id 去重后追加到对话末尾 */
export const AGENT_CANVAS_CHANGE_EVENT = 'agent.canvas-change'

/** CUSTOM 事件的名字：技能加载（{@link AgentSkillLoadedMessage}），前端按 id 去重后追加到对话末尾 */
export const AGENT_SKILL_LOADED_EVENT = 'agent.skill-loaded'

export type AgentStreamEvent =
  | (AgentBaseEvent & {
      type: typeof AgentEventType.RUN_STARTED
      /**
       * = 会话 id（AG-UI 的 thread 就是一段对话）。请求里 `conversationId` 为空时，
       * 这是服务端刚建好的新会话 —— 前端从这里拿到它的 id。
       */
      threadId: string
      runId: string
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.CUSTOM
      name: typeof AGENT_USER_MESSAGE_EVENT
      value: Extract<AgentChatMessage, { role: 'user' }>
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.CUSTOM
      name: typeof AGENT_CANVAS_CHANGE_EVENT
      value: AgentCanvasChangeMessage
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.CUSTOM
      name: typeof AGENT_SKILL_LOADED_EVENT
      value: AgentSkillLoadedMessage
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TEXT_MESSAGE_START
      messageId: string
      role: 'assistant'
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TEXT_MESSAGE_CONTENT
      messageId: string
      delta: string
    })
  | (AgentBaseEvent & { type: typeof AgentEventType.TEXT_MESSAGE_END; messageId: string })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TOOL_CALL_START
      toolCallId: string
      toolCallName: string
      parentMessageId: string
      metadata: AgentToolCallMetadata
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TOOL_CALL_ARGS
      toolCallId: string
      /** 参数 JSON 的片段；本实现一次发完整段 */
      delta: string
    })
  | (AgentBaseEvent & { type: typeof AgentEventType.TOOL_CALL_END; toolCallId: string })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TOOL_CALL_RESULT
      /** 工具结果消息自己的 id（AG-UI 要求），不是 assistant 那条 */
      messageId: string
      toolCallId: string
      /** 回给模型的结果文本 */
      content: string
      role: 'tool'
      metadata: AgentToolCallMetadata
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.RUN_FINISHED
      /** = 会话 id */
      threadId: string
      runId: string
      outcome: { type: 'success' } | { type: 'cancelled' }
      /** 这一轮落定的 assistant 消息（对话记录里存的就是它） */
      result: Extract<AgentChatMessage, { role: 'assistant' }>
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.RUN_ERROR
      message: string
      code?: string
    })

/**
 * agent 写画布时的 Yjs 事务 origin。
 *
 * 不是 `LOCAL_ORIGIN`：agent 的改动不能进任何人的撤销栈（Ctrl+Z 只撤自己的）。
 * 将来「撤回本轮」按 `runId` 建 UndoManager 跟踪的就是它。
 */
export interface AgentTransactionOrigin {
  source: 'agent'
  runId: string
}

export function isAgentOrigin(origin: unknown): origin is AgentTransactionOrigin {
  return (
    typeof origin === 'object' &&
    origin !== null &&
    (origin as { source?: unknown }).source === 'agent' &&
    typeof (origin as { runId?: unknown }).runId === 'string'
  )
}
