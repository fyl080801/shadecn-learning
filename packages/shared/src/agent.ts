/**
 * 画布 Agent 的前后端契约（REQ-AGENT，`docs/20-agent-canvas.md`）。
 *
 * 一张画布 = agent 的一个工作项目：会话、运行、沙箱工作目录都按 `flowId` 归属；
 * 一张画布上每个用户可以有多个会话（持久化在服务端数据库，见下面「会话」一节）。
 * 这里只放两边都要认的东西 —— 接口路径、流式事件的形状、对话消息的形状、
 * 以及「提及节点」在 prompt 文本里的写法。实现分别在
 * `apps/server/agent/` 和 `apps/web/src/components/flow/agent/`。
 *
 * 只用 ES2020，不碰 DOM / Node API（见本包 tsconfig 的护栏）。
 */

/** 接口都挂在画布下面，鉴权跟着 `requireFlowMember` 走：非成员 404 */
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
   * id 由 RUN_STARTED 的 `threadId` 带回来。给的 id 不存在、或不是当前用户在这张画布上的会话 → 404。
   *
   * 「发起新会话」按钮因此只是前端把当前会话置空，不发请求 —— 不会留下一堆空会话。
   */
  conversationId?: string | null
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

// —— 会话 ——
//
// 会话持久化在服务端数据库里，**按「画布 + 用户」归属**：只有本人看得到、删得掉自己的会话，
// 别人的会话 id 一律当不存在（404）。同一张画布同一时刻仍只有一轮在跑（不分会话、不分人）。

/** `GET {agentApiPath}` 的响应 —— 面板打开时的那一次 */
export interface AgentSessionView {
  /**
   * 服务端是否配置了模型；false 时前端只显示说明，不给输入框。**不带模型名**：用的是哪家、哪个模型是服务端的部署细节，
   * 界面上不展示，也就不该出现在接口里（打开开发者工具一样看得到）。运行日志表里仍记着它。
   */
  enabled: boolean
  /** 这张画布此刻是否有一轮正在跑（任何人发起的）；= `activeRun !== null` */
  running: boolean
  /** 正在跑的那一轮；没有为 null */
  activeRun: AgentActiveRunView | null
  /**
   * 面板默认打开的会话（含消息）：**我自己有一轮正在跑时是那一轮所在的会话**，
   * 否则是当前用户在这张画布上最近更新的那个；一个都没有时为 null（新会话空状态）。
   */
  latest: AgentConversationView | null
}

/**
 * 画布上正在跑的那一轮（同一张画布同一时刻至多一轮）。
 *
 * **一轮不随发起它的那个 HTTP 连接存亡**：关页面、刷新、断网都不会中止它，只有
 * `POST {agentApiPath}/abort`、时长上限、失权或服务端退出会。所以重新打开画布时要能接回去 ——
 * 发起人用 {@link agentRunEventsPath} 订阅它的事件；别人只看得到「有一轮在跑、谁发起的」，
 * 看不到内容（会话是发起人私有的）。
 */
export interface AgentActiveRunView {
  runId: string
  /** 只有发起人本人拿得到；别人看到的是 null */
  conversationId: string | null
  initiator: { id: string; name: string }
  /** 发起人是不是当前用户 —— 决定能不能接回事件流、能不能中止 */
  mine: boolean
  /** UTC epoch 毫秒 */
  startedAt: number
}

/**
 * 接回一轮的事件流：`GET` → `text/event-stream`，帧格式同 `POST …/messages`。
 *
 * 服务端先**从头补发**这一轮已经发出的全部事件（从 RUN_STARTED 起），再接着推后续的，
 * 以 RUN_FINISHED / RUN_ERROR 收尾后关流；所以前端拿到的序列和发起时那条流一模一样，
 * 用同一套折叠逻辑即可。
 *
 * 和已落库消息的关系：这一轮的**用户消息**在调模型之前就已落库（所以 `latest.messages`
 * 的最后一条就是它），**assistant 消息**要到这一轮结束才落库。前端先摆好 `latest.messages`，
 * 再折叠补发的事件：CUSTOM `agent.user-message` 的 id 与已有那条相同，按 id 去重而不是再插一条；
 * 之后的文字 / 工具事件照常拼出 assistant 消息。
 * 这一轮已经结束、runId 不对、或不是发起人 → 404（前端改为重新拉会话）。
 * 补发缓冲有上限，超出时服务端回 410，前端同样改为等结束后重新拉会话。
 */
export function agentRunEventsPath(flowId: string, runId: string): string {
  return `${agentApiPath(flowId)}/runs/${encodeURIComponent(runId)}/events`
}

/** 会话列表里的一行（`GET {agentApiPath}/conversations`，按 `updatedAt` 倒序） */
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
  /** 这个会话此刻正在跑一轮（只可能是我自己发起的） */
  running: boolean
}

/** 一个会话的全部内容（`GET {agentApiPath}/conversations/:id`） */
export interface AgentConversationView extends AgentConversationSummary {
  messages: AgentChatMessage[]
}

export const AGENT_TITLE_MAX_LENGTH = 60
export const AGENT_SUMMARY_MAX_LENGTH = 120

/** 会话接口的路径；删除是 `DELETE` 同一路径（正在跑时 409） */
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
//   RUN_STARTED → CUSTOM(agent.user-message)
//   → ( TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END
//     | TOOL_CALL_START → TOOL_CALL_ARGS* → TOOL_CALL_END → TOOL_CALL_RESULT )*
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
