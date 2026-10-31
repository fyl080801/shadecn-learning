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
  /** 用户输入，可含 `@{node:<id>}`；去掉首尾空白后不能为空 —— **带了附件时可以为空** */
  text: string
  /**
   * 随这条消息发的附件（docs/20 §3.10.12）：这一轮 agent 执行时预先设定的资源。
   * 每一项必须是**这张画布**上传过的资源（服务端按上传时记下的归属核对，别的画布的 → 400）；
   * 类型、地址以服务端记录为准，客户端只给键和显示名。最多 {@link AGENT_ATTACHMENT_MAX_COUNT} 个，不给 = 没有。
   */
  attachments?: AgentAttachmentRef[]
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

// —— 附件 ——
//
// 会话 / 快捷会话里上传的资源，随用户消息发给 agent（docs/20 §3.10.12）。上传走画布资源的同一套接口
// （`POST /api/flows/:flowId/assets`，大文件分片），回来的对象键 + 文件名就是请求里的一项；
// 服务端核对归属后补上类型和地址，存进这条用户消息（{@link AgentAttachment}），并在这一轮的模型上下文里列出来。

/** 一条消息最多带几个附件 */
export const AGENT_ATTACHMENT_MAX_COUNT = 8
/** 附件显示名的长度上限（字符数） */
export const AGENT_ATTACHMENT_NAME_MAX_LENGTH = 120
/** 对象键的长度上限（形状另由服务端核对：必须是这张画布上传时记下的键） */
const AGENT_ATTACHMENT_KEY_MAX_LENGTH = 512

/** 请求里的一项：上传接口回来的对象键（`UploadedAsset.key`）+ 给人看的文件名 */
export interface AgentAttachmentRef {
  key: string
  name: string
}

/**
 * 存在用户消息上的附件（服务端核对过归属之后的样子）。`key` 同时是它在对话里的标识 ——
 * 模型看附件（`view_attachment`）时点的就是它。
 */
export interface AgentAttachment {
  key: string
  /** 对象存储的原始地址，同节点 `data.src`；前端直接拿来显示 */
  url: string
  /** 上传时服务端记下的类型（不是客户端这次声明的） */
  contentType: string
  name: string
}

/** 附件按什么显示：图片 / 视频有预览，其余显示文件图标 + 名字 */
export function agentAttachmentKind(contentType: string): 'image' | 'video' | 'file' {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  return 'file'
}

/** 含控制字符（换行、制表、NUL…）：键和显示名里都不该有 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * 校验请求里的 `attachments`（服务端用；不给 / null = 没有附件）：数量、每项的字段类型与长度、键不重复。
 * 只管形状 —— 是不是这张画布的资源由服务端查上传记录。显示名去掉首尾空白后不能为空。
 */
export function parseAgentAttachmentRefs(
  value: unknown,
): { ok: true; attachments: AgentAttachmentRef[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, attachments: [] }
  if (!Array.isArray(value)) return { ok: false, error: 'attachments 必须是数组' }
  if (value.length > AGENT_ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: `附件最多 ${AGENT_ATTACHMENT_MAX_COUNT} 个` }
  }
  const attachments: AgentAttachmentRef[] = []
  const keys = new Set<string>()
  for (const item of value) {
    if (!isObject(item)) return { ok: false, error: 'attachments 的每一项必须是 { key, name }' }
    const { key, name } = item
    if (typeof key !== 'string' || !key || key.length > AGENT_ATTACHMENT_KEY_MAX_LENGTH || hasControlChars(key)) {
      return { ok: false, error: '附件的 key 不合法' }
    }
    if (typeof name !== 'string') return { ok: false, error: '附件的 name 必须是字符串' }
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > AGENT_ATTACHMENT_NAME_MAX_LENGTH || hasControlChars(trimmed)) {
      return { ok: false, error: `附件的 name 不能为空、不能超过 ${AGENT_ATTACHMENT_NAME_MAX_LENGTH} 字` }
    }
    if (keys.has(key)) return { ok: false, error: '同一个附件不能重复添加' }
    keys.add(key)
    attachments.push({ key, name: trimmed })
  }
  return { ok: true, attachments }
}

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
  /**
   * 调用参数（服务端校验过的那份，JSON 文本，截到 {@link AGENT_TOOL_VIEW_TEXT_LIMIT} 字）。给人展开查看，不回给模型。
   * 这个字段出现之前存的记录没有它
   */
  input?: string
  /** 回给模型的结果文本（截到 {@link AGENT_TOOL_VIEW_TEXT_LIMIT} 字；出错时原因在 `error`，这里不重复）。旧记录没有 */
  output?: string
}

/** 对话记录里一条工具调用留多少字的参数 / 结果（落库、补发都带着它们，所以要小） */
export const AGENT_TOOL_VIEW_TEXT_LIMIT = 2000

/**
 * 入口 agent 的一段思考（模型的 thinking 块，服务端自己调模型的流里来的）。
 * 一条 assistant 消息里可能有几段（每次模型请求一段），各自按出现时的位置插在工具调用之间
 */
export interface AgentReasoningView {
  id: string
  /** 思考的文字（整条消息合计截到 {@link AGENT_REASONING_TEXT_LIMIT} 字） */
  text: string
  /** 出现在第几条工具调用之前（= 开始时这条消息已有的 `toolCalls` 条数）：界面按它把思考和工具调用排成一条时间线 */
  position: number
  /** 开始 / 结束的时刻（服务端时钟，UTC 毫秒）；还在想的没有 `finishedAt` */
  startedAt: number
  finishedAt?: number
}

/** assistant 消息里一段文字的位置 */
export interface AgentTextSegmentView {
  /** 这一段在 `text` 里的起点（含它开头和上一段之间的 `\n\n`） */
  at: number
  /** 出现在第几条工具调用之前（= 开始时这条消息已有的 `toolCalls` 条数），同 {@link AgentReasoningView.position} */
  position: number
}

/** 一条 assistant 消息里全部思考合计留多少字（超出的不再推送，也不落库） */
export const AGENT_REASONING_TEXT_LIMIT = 16000

/**
 * 一轮的模型用量（服务端调模型拿到的 `usage`，调用方与被调用的 agent 合计 —— 与运行日志同一个数，
 * 只是在收尾帧那一刻取：被叫停时还在途的那次请求不在里面）
 */
export interface AgentUsageView {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 美元；模型没有价格信息为 null（「不知道」不是「免费」） */
  costUsd: number | null
  /**
   * 入口 agent 最后一次模型请求占了多少上下文（输入 + 缓存读写 + 输出 token）—— 下一轮带着的历史大约这么大。
   * 没有发出过请求为 0
   */
  contextTokens: number
  /** 入口 agent 模型的上下文窗口（token） */
  contextWindow: number
  /** 入口 agent 模型的名字（给人看） */
  model: string
}

export type AgentChatMessage =
  | {
      id: string
      role: 'user'
      text: string
      createdAt: number
      /** 随这条消息发的附件（docs/20 §3.10.12）；没有就不带这个字段 */
      attachments?: AgentAttachment[]
    }
  | {
      id: string
      role: 'assistant'
      /** 模型的文字回复（可能为空：只调了工具） */
      text: string
      toolCalls: AgentToolCallView[]
      createdAt: number
      /** 这一轮以失败 / 中止收尾时的说明 */
      error?: string
      /**
       * 这一轮发起的任务（docs/20 §3.10.11）：每个 `run_agent` 工具调用一项，按发起的先后，**平铺**（被调用的 agent 再发起的任务也在这里，
       * 用 {@link AgentSubtaskView.parentId} 指向发起它的那个任务）。入口 agent 发起的 `toolCallId` 对得上 {@link toolCalls} 里那一条，
       * 嵌套的对得上父任务条目的 `toolCalls` 里那一条。没发起过任务就没有这个字段。
       */
      subtasks?: AgentSubtaskView[]
      /** 入口 agent 的思考（按出现先后）；没有思考（模型不支持 / 没开）或这个字段出现之前的记录没有它 */
      reasoning?: AgentReasoningView[]
      /**
       * `text` 里每一段文字从哪开始、出现在第几条工具调用之前（按出现先后）—— 界面据此把工具调用之间的话排进时间线。
       * 这个字段出现之前的记录没有它：整段 `text` 当正文
       */
      textSegments?: AgentTextSegmentView[]
      /** 这一轮的用量，收尾时写上；还在跑、或这个字段出现之前的记录没有它 */
      usage?: AgentUsageView
    }
  | AgentCanvasChangeMessage
  | AgentSkillLoadedMessage

// —— 任务（docs/20 §3.10.11） ——

/** 发起任务的工具名（docs/26 §3.5）：前端据此把那一条工具调用画成任务条目 */
export const AGENT_RUN_TOOL_NAME = 'run_agent'

/**
 * 发起任务的工具**原来的**名字（runner 协议第 8 版之前，docs/26 P3）。只为读旧数据保留：会话里已经存着的 assistant 消息
 * （`toolCalls`）、模型上下文（`llmMessages`）、工具调用日志里还是它，不迁移 —— 前端认它和 {@link AGENT_RUN_TOOL_NAME} 一样画成任务条目。
 * **不要删**，也不要再用它发起新的调用（服务端的工具表里已经没有它）。
 */
export const LEGACY_AGENT_DELEGATE_TOOL_NAME = 'delegate_task'

/** 这条工具调用是不是发起任务的那种（含旧名字，见 {@link LEGACY_AGENT_DELEGATE_TOOL_NAME}） */
export function isAgentRunToolName(name: string): boolean {
  return name === AGENT_RUN_TOOL_NAME || name === LEGACY_AGENT_DELEGATE_TOOL_NAME
}

/**
 * 旧的任务条目（第 8 版之前落库的）没有 `agent` 字段：那时被调用的 agent 只有 `canvas` 一种（docs/26 P2），读出时按它补上。
 * 和 `@shadecn/agent` 的入口 agent 名（`ENTRY_AGENT_NAME`）同值，但这里只管旧数据的显示，别拿它判别的
 */
export const LEGACY_TASK_AGENT_NAME = 'canvas'

/** 任务的状态：进行中 / 完成 / 失败 / 需要确认（被调用的 agent 不直接问人，以「需要确认 + 问题」交回调用方） */
export type AgentSubtaskStatus = 'running' | 'done' | 'failed' | 'needs_confirmation'

/**
 * 会话里的一个任务条目：调用方的一次 `run_agent`（旧数据里是 `delegate_task`）。被调用的 agent 在这一轮的沙箱里跑，**没有自己的会话**；
 * 它的工具调用和最终回复只在这里给人看（只读），不进入口 agent 的模型上下文。
 *
 * **嵌套**（调用深度上限 > 1 时，docs/26 §3.5）：被调用的 agent 再发起的任务同样是 `subtasks` 里平铺的一项，`parentId` 是发起它的那个任务，
 * `toolCallId` 是父任务条目 `toolCalls` 里那一条；前端按它们把子条目挂到父条目里显示。
 *
 * 实时流里：发起时一帧 CUSTOM {@link AGENT_SUBTASK_EVENT}，`value` 是完整条目（前端按 `id` 整条替换）；
 * 之后每次变化一帧 CUSTOM {@link AGENT_SUBTASK_UPDATE_EVENT}，只带变了的（{@link AgentSubtaskUpdate}，前端用 {@link applyAgentSubtaskUpdate} 合并）。
 * 随 assistant 消息落库（{@link AgentChatMessage} 的 `subtasks`，**完整条目**），刷新 / 接回补发 / 只读旁观看到的一样。
 */
export interface AgentSubtaskView {
  /** 被调用的 agent 的 id（服务端分配，一轮之内唯一） */
  id: string
  /** 执行它的 agent 定义的名字（docs/26 §3.1，如 `canvas`）。旧条目没有，读出时按 {@link LEGACY_TASK_AGENT_NAME} 补 */
  agent: string
  /** 发起它的那个任务的 `id`；入口 agent 发起的没有这个字段 */
  parentId?: string
  /**
   * 调用方那次 `run_agent` 的显示 id：入口 agent 发起的是 assistant 消息 `toolCalls` 里那一条的 `id`，嵌套的是父任务条目 `toolCalls` 里那一条的
   * （各自在自己的列表里唯一：上游复用调用 id 时服务端给后来的那条加后缀，见 `@shadecn/agent` 的 `events.ts`）
   */
  toolCallId: string
  /** 任务说明（调用方写的，`run_agent` 的 `task`；字段名沿用落库的形状） */
  brief: string
  /** 派给它处理的节点 */
  nodeIds: string[]
  status: AgentSubtaskStatus
  /** UTC epoch 毫秒（服务端时钟） */
  startedAt: number
  /** 结束的时刻；还在跑没有这个字段 */
  finishedAt?: number
  /** 被调用的 agent 的工具调用（同 assistant 消息的 `toolCalls`，只读） */
  toolCalls: AgentToolCallView[]
  /** 被调用的 agent 的回复（最后一次的文字）；还没说话为空串 */
  text: string
  /** 需要确认时它要问的问题 */
  question?: string
  /** 失败的原因 */
  error?: string
  /** 它改过的节点（服务端按执行记录汇总） */
  changedNodeIds: string[]
}

const SUBTASK_STATUSES: readonly AgentSubtaskStatus[] = ['running', 'done', 'failed', 'needs_confirmation']
const TOOL_CALL_STATUSES: readonly AgentToolCallView['status'][] = ['running', 'done', 'error']
/** 一个任务条目里最多收几条工具调用、几个节点 id（防一条畸形载荷撑爆界面） */
const SUBTASK_TOOL_CALLS_MAX = 200
const SUBTASK_NODE_IDS_MAX = 200

function parseToolCallView(value: unknown): AgentToolCallView | null {
  if (!isObject(value)) return null
  const { id, name, summary, status, error, input, output } = value
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof summary !== 'string') return null
  if (!TOOL_CALL_STATUSES.includes(status as AgentToolCallView['status'])) return null
  return {
    id,
    name,
    summary,
    status: status as AgentToolCallView['status'],
    ...(typeof error === 'string' ? { error } : {}),
    // 服务端已截过；这里再按上限兜一次（截短的标记占几个字，留余量）
    ...(typeof input === 'string' && input ? { input: input.slice(0, AGENT_TOOL_VIEW_TEXT_LIMIT + 64) } : {}),
    ...(typeof output === 'string' && output ? { output: output.slice(0, AGENT_TOOL_VIEW_TEXT_LIMIT + 64) } : {}),
  }
}

function stringIds(value: unknown, max: number): string[] {
  const out: string[] = []
  if (!Array.isArray(value)) return out
  for (const id of value) {
    if (out.length >= max) break
    if (typeof id === 'string' && id && id.length <= OCCUPIED_ID_MAX && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 解析一个任务条目（CUSTOM {@link AGENT_SUBTASK_EVENT} 的 `value`、落库的 `subtasks` 里的一项）；形状不对返回 null。
 * **防御着写**：认不出的字段丢掉，列表里个别项不对只丢那一项，不让一条畸形载荷把界面带崩。
 */
export function parseAgentSubtask(value: unknown): AgentSubtaskView | null {
  if (!isObject(value)) return null
  const { id, agent, parentId, toolCallId, brief, status, startedAt, finishedAt, text, question, error } = value
  if (typeof id !== 'string' || !id || typeof toolCallId !== 'string' || !toolCallId) return null
  if (typeof brief !== 'string') return null
  if (!SUBTASK_STATUSES.includes(status as AgentSubtaskStatus)) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  const toolCalls: AgentToolCallView[] = []
  if (Array.isArray(value.toolCalls)) {
    for (const item of value.toolCalls) {
      if (toolCalls.length >= SUBTASK_TOOL_CALLS_MAX) break
      const call = parseToolCallView(item)
      if (call) toolCalls.push(call)
    }
  }
  return {
    id,
    // 旧条目（第 8 版之前）没有 agent：那时只有 canvas
    agent: typeof agent === 'string' && agent ? agent : LEGACY_TASK_AGENT_NAME,
    ...(typeof parentId === 'string' && parentId ? { parentId } : {}),
    toolCallId,
    brief,
    nodeIds: stringIds(value.nodeIds, SUBTASK_NODE_IDS_MAX),
    status: status as AgentSubtaskStatus,
    startedAt,
    ...(typeof finishedAt === 'number' && Number.isFinite(finishedAt) ? { finishedAt } : {}),
    toolCalls,
    text: typeof text === 'string' ? text : '',
    ...(typeof question === 'string' && question ? { question } : {}),
    ...(typeof error === 'string' && error ? { error } : {}),
    changedNodeIds: stringIds(value.changedNodeIds, SUBTASK_NODE_IDS_MAX),
  }
}

/**
 * 任务条目的一次变化（CUSTOM {@link AGENT_SUBTASK_UPDATE_EVENT} 的 `value`）：只带变了的字段。
 * 不重复任务说明（最长 8000 字）、节点和已经发过的工具调用 —— 每次变化都发完整条目时，补发量随「调用数 × 条目大小」增长，
 * 几个长任务就能撑爆补发缓冲（中途接回 410）。没带的字段不变。
 */
export interface AgentSubtaskUpdate {
  id: string
  status?: AgentSubtaskStatus
  finishedAt?: number
  /** 被调用的 agent 的回复：整段替换 */
  text?: string
  question?: string
  error?: string
  /** 整个替换 */
  changedNodeIds?: string[]
  /** 新增或变了的工具调用：按 `id` 替换，没有的追加 */
  toolCalls?: AgentToolCallView[]
}

/** 解析一帧任务变化；没有 `id` 返回 null。**防御着写**：认不出 / 形状不对的字段丢掉（等于这个字段没变） */
export function parseAgentSubtaskUpdate(value: unknown): AgentSubtaskUpdate | null {
  if (!isObject(value)) return null
  const { id, status, finishedAt, text, question, error } = value
  if (typeof id !== 'string' || !id) return null
  const toolCalls: AgentToolCallView[] = []
  if (Array.isArray(value.toolCalls)) {
    for (const item of value.toolCalls) {
      if (toolCalls.length >= SUBTASK_TOOL_CALLS_MAX) break
      const call = parseToolCallView(item)
      if (call) toolCalls.push(call)
    }
  }
  return {
    id,
    ...(SUBTASK_STATUSES.includes(status as AgentSubtaskStatus) ? { status: status as AgentSubtaskStatus } : {}),
    ...(typeof finishedAt === 'number' && Number.isFinite(finishedAt) ? { finishedAt } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof question === 'string' && question ? { question } : {}),
    ...(typeof error === 'string' && error ? { error } : {}),
    ...(Array.isArray(value.changedNodeIds) ? { changedNodeIds: stringIds(value.changedNodeIds, SUBTASK_NODE_IDS_MAX) } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

/**
 * 把一次变化合并进条目，返回新对象（不改传进来的）；`id` 对不上原样返回。
 * 服务端落库的完整条目 = 首帧完整条目依次合并之后的每一帧（补发、只读旁观、刷新看到的一样）
 */
export function applyAgentSubtaskUpdate(view: AgentSubtaskView, update: AgentSubtaskUpdate): AgentSubtaskView {
  if (update.id !== view.id) return view
  const toolCalls = view.toolCalls.slice()
  for (const call of update.toolCalls ?? []) {
    const index = toolCalls.findIndex((item) => item.id === call.id)
    if (index >= 0) toolCalls[index] = { ...call }
    else if (toolCalls.length < SUBTASK_TOOL_CALLS_MAX) toolCalls.push({ ...call })
  }
  return {
    ...view,
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.finishedAt !== undefined ? { finishedAt: update.finishedAt } : {}),
    ...(update.text !== undefined ? { text: update.text } : {}),
    ...(update.question !== undefined ? { question: update.question } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
    ...(update.changedNodeIds !== undefined ? { changedNodeIds: [...update.changedNodeIds] } : {}),
    toolCalls,
  }
}

// —— 技能（docs/23） ——

/**
 * 内置技能的 id（`canvas` / `media-view` / `media-exec` / `director` / …）：发布后不改，对话记录里存的就是它。
 * 有哪些技能由服务端的注册表定（`@shadecn/agent` 的 `skills/`），这里不枚举 —— 前端只拿它做 key，显示用 {@link AgentSkillView.title}。
 */
export type AgentSkillId = string

/**
 * 合并 / 改名掉的技能 id → 现在的 id。对话记录里存着旧的，**读出时**换成新的（{@link canonicalSkillIds}）。
 * `canvas-edit`：原先写画布的技能，和只读的 `canvas` 合成了一个（docs/23 §4）。
 * `delegate`：发起任务的技能，runner 协议第 8 版起改名 `agents`（工具 `delegate_task` → `run_agent`，docs/26 P3）。
 */
export const AGENT_SKILL_ID_ALIASES: ReadonlyMap<AgentSkillId, AgentSkillId> = new Map([
  ['canvas-edit', 'canvas'],
  ['delegate', 'agents'],
])

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
  /** 服务端此刻的时钟（UTC epoch 毫秒）：前端拿它把 `expiresAt` 换算成本机时间（两边时钟不一定对得上） */
  now?: number
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
   * 这一轮所在会话的入口节点（会话的 `nodeId`，docs/20 §3.10.9），只是回显入口：**不表示它在改这个节点**
   * （「正在编辑」看 {@link occupies}）。没有入口的会话没有这个字段（不是 null —— 老的载荷里本来就没有，读的一侧一律按「没有」处理）。
   */
  nodeId?: string
  /**
   * 这一轮**占用**的节点（docs/20 §3.4、§3.10.8）：占用登记成功、本轮写过 `data` 的节点（含删除的、新建的），
   * 按占用的先后。一轮之内只增不减；节点上的占用标签、导演台的「正在编辑这个场景」都看它。只由服务端写。
   */
  occupies: string[]
  /**
   * 这一项的过期时间（服务端时钟的 UTC epoch 毫秒）：持有者每次续期重发，客户端到点还没收到新的就自行去掉
   * （副本崩溃时没人发「离开」）。和本机时钟的偏差用载荷里的 `now` 换算；没有这个字段 = 不按时过期（老的载荷）。
   */
  expiresAt?: number
  /**
   * 这一轮此刻在跑的任务数（docs/20 §3.10.11，任务列表显示「含 N 个任务进行中」）；没有在跑的任务时没有这个字段。
   * 任务不是单独的一轮，任务列表里仍只有这一轮自己这一项。
   */
  subtasks?: number
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
// 多副本（docs/20 §3.10.10）：任务登记在共享层，持有副本在变化 / 续期时读**共享登记的全量**再广播
// （经 redis 扩展到达所有副本的客户端），所以不论哪个副本发的都是完整列表。持有副本崩溃时没人发「离开」，
// 客户端按每项的 `expiresAt` 自行去掉。

/** stateless 载荷（JSON）的形状 */
export interface AgentRunsMessage {
  type: typeof AGENT_RUNS_MESSAGE
  /** 哪张画布；前端拿它和当前画布比对，对不上就丢（换画布时的残留） */
  flowId: string
  /** 全量，按 `startedAt` 升序；没有在跑的为空数组 */
  runs: AgentRunEntry[]
  /** 发出时服务端的时钟（UTC epoch 毫秒），同 {@link AgentSessionView.now}；老的载荷没有 */
  now?: number
}

/** 服务端用：序列化成 stateless 载荷 */
export function formatAgentRunsMessage(flowId: string, runs: readonly AgentRunEntry[], now: number = Date.now()): string {
  const message: AgentRunsMessage = { type: AGENT_RUNS_MESSAGE, flowId, runs: [...runs], now }
  return JSON.stringify(message)
}

/** 占用列表里一个节点 id 最长多少（同节点 id 的格式上限）；一项最多带几个（防一条畸形载荷撑爆界面） */
const OCCUPIED_ID_MAX = 64
const OCCUPIES_MAX = 500

/**
 * 「某某的助手」：节点上的占用标签、导演台顶部那行、写入被拒时给模型看的那句都用这个说法。
 * 个人画布（`showOwner` 为 false）只说「助手」；自己的说「我的助手」。
 */
export function agentHolderLabel(owner: { name: string }, options: { mine?: boolean; showOwner?: boolean } = {}): string {
  if (options.showOwner === false) return '助手'
  return options.mine ? '我的助手' : `${owner.name || '匿名用户'}的助手`
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
  // occupies：不是数组当空；里面不是合法 id 的那几个丢掉、重复的去掉（不因为它丢掉整项）
  const occupies: string[] = []
  if (Array.isArray(value.occupies)) {
    for (const id of value.occupies) {
      if (occupies.length >= OCCUPIES_MAX) break
      if (typeof id === 'string' && id && id.length <= OCCUPIED_ID_MAX && !occupies.includes(id)) occupies.push(id)
    }
  }
  // expiresAt：不是有限数字就当没有（不按时过期）
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined
  // subtasks：正整数才算（0 / 不是数字 = 没有在跑的任务）
  const subtasks = typeof value.subtasks === 'number' && Number.isInteger(value.subtasks) && value.subtasks > 0 ? value.subtasks : undefined
  // 只取认得的字段：载荷里多出来的东西不往下传
  return {
    runId,
    conversationId,
    conversationTitle,
    owner,
    startedAt,
    ...(nodeId ? { nodeId } : {}),
    occupies,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(subtasks !== undefined ? { subtasks } : {}),
  }
}

/**
 * 解析一条 stateless 消息里的任务列表；不是这类消息（或整体形状不对）就返回 `null`。
 *
 * **防御着写**，同 `parseStoreState`：stateless 是个通用旁路通道，一条读不懂的消息绝不能变成一次异常 ——
 * 那会打断整条连接的消息处理。列表里个别项形状不对时**只丢那一项**，其余照收：
 * 少显示一个任务，好过把整份列表当没收到、一直显示过期的那份。
 */
export function parseAgentRunsMessage(payload: string): { flowId: string; runs: AgentRunEntry[]; now?: number } | null {
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
  const now = typeof parsed.now === 'number' && Number.isFinite(parsed.now) ? parsed.now : undefined
  return { flowId: parsed.flowId, runs, ...(now !== undefined ? { now } : {}) }
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
// pi（`@earendil-works/pi-agent-core`）自己没有对外的线上协议 —— 它的 `AgentEvent`
// 只在进程内 `subscribe`，映射成 AG-UI 在 `@shadecn/agent` 里集中做。
//
// 顺序：
//   RUN_STARTED → CUSTOM(agent.user-message) → CUSTOM(agent.canvas-change, since-last-run)?
//   → ( TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END
//     | REASONING_MESSAGE_START → REASONING_MESSAGE_CONTENT* → REASONING_MESSAGE_END
//     | TOOL_CALL_START → TOOL_CALL_ARGS* → TOOL_CALL_END → TOOL_CALL_RESULT
//     | CUSTOM(agent.canvas-change, live) | CUSTOM(agent.skill-loaded)
//     | CUSTOM(agent.subtask) | CUSTOM(agent.subtask-update) )*
//   → RUN_FINISHED | RUN_ERROR
// 最后一帧之后服务端关流。同一轮里 assistant 的文字可能分几段（每次调工具前后各一段），
// 它们共用一个 `messageId` —— 对应对话记录里的同一条 assistant 消息。
// 思考（只有入口 agent 的）每段一个自己的 `messageId`（= {@link AgentReasoningView.id}），`parentMessageId` 指那条 assistant 消息；
// 名字照 AG-UI 后来加的 reasoning 事件。
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
  REASONING_MESSAGE_START: 'REASONING_MESSAGE_START',
  REASONING_MESSAGE_CONTENT: 'REASONING_MESSAGE_CONTENT',
  REASONING_MESSAGE_END: 'REASONING_MESSAGE_END',
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
  /** 条目上的 {@link AgentToolCallView.input}（START 带；截过的那份，前端照抄 —— 实时看到的和刷新后读回的一致） */
  input?: string
  /** 条目上的 {@link AgentToolCallView.output}（RESULT 带，同上） */
  output?: string
}

/** CUSTOM 事件的名字：服务端回显用户消息（带服务端分配的 id），前端拿它替换乐观插入的那条 */
export const AGENT_USER_MESSAGE_EVENT = 'agent.user-message'

/** CUSTOM 事件的名字：画布改动通知（{@link AgentCanvasChangeMessage}），前端按 id 去重后追加到对话末尾 */
export const AGENT_CANVAS_CHANGE_EVENT = 'agent.canvas-change'

/** CUSTOM 事件的名字：技能加载（{@link AgentSkillLoadedMessage}），前端按 id 去重后追加到对话末尾 */
export const AGENT_SKILL_LOADED_EVENT = 'agent.skill-loaded'

/**
 * CUSTOM 事件的名字：发起了一个任务（{@link AgentSubtaskView}）。
 * `value` 是条目的完整样子，前端先 {@link parseAgentSubtask} 再按 `id` 整条替换进这一轮的 assistant 消息
 */
export const AGENT_SUBTASK_EVENT = 'agent.subtask'

/**
 * CUSTOM 事件的名字：任务条目变了（被调用的 agent 调工具 / 回复 / 结束）。`value` 只带变了的（{@link AgentSubtaskUpdate}），
 * 前端先 {@link parseAgentSubtaskUpdate} 再用 {@link applyAgentSubtaskUpdate} 合并进同 `id` 的那一项；还没有那一项就丢掉
 */
export const AGENT_SUBTASK_UPDATE_EVENT = 'agent.subtask-update'

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
      type: typeof AgentEventType.CUSTOM
      name: typeof AGENT_SUBTASK_EVENT
      value: AgentSubtaskView
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.CUSTOM
      name: typeof AGENT_SUBTASK_UPDATE_EVENT
      value: AgentSubtaskUpdate
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TEXT_MESSAGE_START
      messageId: string
      role: 'assistant'
      /** 这一段出现在第几条工具调用之前（{@link AgentTextSegmentView.position}；AG-UI 之外的字段）。旧服务端不带 */
      position?: number
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.TEXT_MESSAGE_CONTENT
      messageId: string
      delta: string
    })
  | (AgentBaseEvent & { type: typeof AgentEventType.TEXT_MESSAGE_END; messageId: string })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.REASONING_MESSAGE_START
      /** 这段思考的 id（{@link AgentReasoningView.id}） */
      messageId: string
      role: 'reasoning'
      /** 它属于的那条 assistant 消息 */
      parentMessageId: string
      /** {@link AgentReasoningView.position} */
      position: number
    })
  | (AgentBaseEvent & {
      type: typeof AgentEventType.REASONING_MESSAGE_CONTENT
      messageId: string
      delta: string
    })
  | (AgentBaseEvent & { type: typeof AgentEventType.REASONING_MESSAGE_END; messageId: string })
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
