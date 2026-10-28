import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@mariozechner/pi-agent-core'
import {
  AGENT_PROMPT_MAX_LENGTH,
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_TITLE_MAX_LENGTH,
  AgentEventType,
  NODE_MENTION_PATTERN,
  type AgentActiveRunView,
  type AgentChatMessage,
  type AgentConversationSummary,
  type AgentConversationView,
  type AgentSessionView,
  type AgentStreamEvent,
} from '@shadecn/shared/agent'
import { createId } from '@shadecn/shared/id'
import type { CanvasHandle } from './canvas.ts'
import { createRunEventMapper, type RunOutcome } from './events.ts'
import type { ResolvedAgentModel } from './model.ts'
import { expandMentions, lookupMention, SYSTEM_PROMPT } from './prompt.ts'
import { createMediaTool } from './sandbox/media-tool.ts'
import type { Sandbox, SandboxProvider } from './sandbox/types.ts'
import type {
  AgentConversationStore,
  AgentRunFinish,
  AgentRunLog,
  AgentRunStart,
  StoredConversation,
  StoredConversationMeta,
} from './store.ts'
import { canvasSnapshot, createCanvasTools, type CanvasTool } from './tools.ts'

/**
 * 编排：会话、「一张画布同时只跑一轮」、把一轮 pi Agent 跑完。
 *
 * ## 什么持久化、什么在内存
 *
 * - **会话**（对话记录 + 模型上下文）经注入的 {@link AgentConversationStore} 落库，按「画布 + 用户」归属，
 *   一个人在一张画布上可以有多个会话。进程重启、换到另一个副本，会话都还在。
 * - **运行日志**（每轮一行 + 每次工具调用一行）经注入的 {@link AgentRunLog} 落库，审计用途。
 * - **「谁在跑」**（`runs`）仍是进程内存里的 `Map`：**多副本之间不共享** —— 两个 Pod 各自允许一轮，
 *   「每张画布同一时刻一轮」只在单副本下成立；进程重启时正在跑的那一轮也随之没了。
 *   跨副本的 run 注册表要上共享层（`SharedMap.claim` + TTL + 心跳，docs/20 §3.7.2），属于 F14，留到后续。
 *
 * ## 一轮的生命周期与失败语义
 *
 * `start()` **同步**占住这张画布的槽位（第二个发起者立刻得到 `busy`，中间没有 await 可插队），
 * 然后异步跑：
 *
 * 1. **准备会话**：没给会话 id 就 `create`（标题取自这条用户消息），给了就读出来（含模型上下文），
 *    把用户消息追加进去并 `save`。这一步**先于调用模型**：用户消息先落库，模型再贵也不会白跑一趟却没留下记录。
 *    失败（库挂了 / 会话在这之间被删了）→ 只发一帧 RUN_ERROR，模型不调、画布不开。此时还没有 RUN_STARTED ——
 *    新会话根本没建起来，拿不出 threadId。
 * 2. 发 RUN_STARTED（threadId = 会话 id）+ 回显用户消息，写运行日志的开头一行。
 * 3. 打开画布 → 展开提及 → 跑 pi。每次工具结束写一行工具调用日志。
 * 4. **一次** `save` 把 assistant 消息、模型上下文、summary、messageCount、updatedAt 落库 ——
 *    success / cancelled / error 都要走到这一步。save 失败：console.error，并且**这一轮以 RUN_ERROR 收尾**，
 *    说明「对话没能保存」：画布上的改动已经在了，可这一轮的对话刷新就会丢，用户必须知道。
 * 5. 发最后一帧，关画布 / 沙箱，写运行日志的结尾一行。
 *
 * **运行日志 fail open**：它是旁路记录，`startRun` / `recordToolCall` / `finishRun` 写失败只 console.error，
 * 不影响这一轮 —— 让一次审计写入的失败把画布操作打断，是本末倒置。会话的 save 则相反（见第 4 步），
 * 因为对话本身就是用户看得见的东西。
 *
 * ## 一轮不随发起它的连接存亡
 *
 * 能让一轮停下的只有：{@link AgentRuntime.abort}（发起人点停止）、时长上限（`timeoutMs`）、
 * 失权（打开画布时宿主复核失败即收尾；运行中失权则之后每次工具调用都被宿主拒掉）、
 * 进程退出（{@link AgentRuntime.abortAll}）。
 * **客户端断开不在其中**：关页面、刷新、断网只是少了一个订阅者，这一轮照常跑完、照常落库，
 * 重新打开画布的人可以用 {@link AgentRuntime.subscribe} 接回去。
 * 已经写进画布的改动**保留**：每次工具调用是独立的 Y 事务，中止不回滚（撤回本轮是后续需求，§3.5）。
 * 中止之后照样走第 4、5 步 —— 被中止的一轮也是对话的一部分。
 *
 * ## 事件：一份缓冲，多个订阅者
 *
 * 一轮发出的每一帧都经同一个 `publish`：先追加进这一轮的**补发缓冲**，再按顺序交给每个订阅者。
 * 发起者（`start()` 的 `emit`）就是第一个订阅者，在第一帧之前就挂上了；后来的订阅者
 * （{@link AgentRuntime.subscribe}）先同步收到缓冲里的全部帧，再接着收后续的 —— 补发和实时推之间
 * 没有 await，不会漏帧也不会重帧。所以**两条路看到的序列逐帧相同**，包括「会话没准备好、
 * 只发了一帧 RUN_ERROR」那种：那一帧同样进缓冲，准备会话那几毫秒里接回的人收到的也只有它；
 * 它发完这一轮就结束了，之后没有可接回的东西。
 *
 * 缓冲有上限（`replayEvents` 条 / `replayChars` 字）：超出就标记溢出、丢掉缓冲、不再缓冲，
 * 已经挂着的订阅者照常实时收；之后再来接回的得到 `overflowed`（路由回 410）。
 * 最后一帧（RUN_FINISHED / RUN_ERROR）发出后通知订阅者「完了」；这一轮从 `runs` 删掉时缓冲随之释放。
 * 最后一帧之后、删掉之前（关画布、写运行日志那一小段）接回的，补发里就带着最后一帧，随即完结 ——
 * 只要 `activeRun` 还看得见它，就接得回。
 */

export interface RunLimits {
  /** 一轮里最多几次「模型回复」（每次调工具之后模型都要再回一次） */
  maxTurns: number
  /** 一轮里最多几次工具调用，超出的被拦下并告诉模型 */
  maxToolCalls: number
  /** 一轮的总时长 */
  timeoutMs: number
  /** 一个会话的对话记录（给前端的）最多留几条 */
  chatMessages: number
  /** 一个会话的模型上下文（pi 的 messages）最多留几条；裁剪在用户消息的边界上，不拆开工具调用与结果 */
  llmMessages: number
  /** 补发缓冲最多存几帧 */
  replayEvents: number
  /** 补发缓冲最多存多少字（各帧 JSON 的字符数之和） */
  replayChars: number
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxTurns: 24,
  maxToolCalls: 60,
  timeoutMs: 5 * 60_000,
  chatMessages: 200,
  llmMessages: 120,
  /*
   * 补发缓冲的上限。按「一轮自己的上限」估：60 次工具调用 × 每次的参数（正文上限 8000 字）
   * + 结果（TOOL_RESULT_CONTENT_LIMIT 8000 字）≈ 百万字，再加上文字回复，2M 字装得下正常跑满的一轮；
   * 条数主要防「每个 token 一帧 TEXT_MESSAGE_CONTENT」的提供方：24 步、每步几百个 token 也到不了一万。
   * 一张画布同一时刻只有一轮，所以这也是每张画布的内存上限；真超了只是不能接回（410），这一轮照常跑。
   */
  replayEvents: 10_000,
  replayChars: 2_000_000,
}

/** 会话 id 的长度上限 —— 只是挡住乱给的参数，真正的校验是查库 */
export const AGENT_CONVERSATION_ID_MAX_LENGTH = 128

/** 工具调用日志里 error 的长度上限 */
const TOOL_ERROR_LOG_LIMIT = 500

/** 打开的画布：宿主实现 —— 用完要关（释放 direct connection，触发落库） */
export interface OpenedCanvas extends CanvasHandle {
  close(): Promise<void>
}

export interface AgentRuntimeOptions {
  /** `null` = 没配模型，agent 未启用 */
  model: ResolvedAgentModel | null
  /** 未启用时给人看的原因（日志 / 503 的 message） */
  disabledReason?: string
  /** 会话持久化。**必填**：没有默认实现，免得「忘了接库」悄悄变成「重启即丢」 */
  store: AgentConversationStore
  /** 运行日志。必填，理由同上 */
  runLog: AgentRunLog
  /**
   * 查用户的显示名（`activeRun.initiator.name`）。必填，理由同上：宿主才认识用户表
   * （apps/server 用 `store/users.ts`，取值顺序与协同层在场信息的名字一致）
   */
  displayName: (userId: string) => Promise<string>
  /** 测试注入；不给就用 pi 默认的 `streamSimple`（按 model.api 分发到各家 SDK） */
  streamFn?: StreamFn
  /** 给了才暴露 `run_media_command` 工具 */
  sandbox?: SandboxProvider | null
  limits?: Partial<RunLimits>
}

export interface StartRunInput {
  flowId: string
  userId: string
  /** 已校验过的用户输入（见 {@link validatePrompt}） */
  text: string
  /**
   * 发到哪个会话；`null` = 新会话。宿主应先用 {@link AgentRuntime.getConversation} 确认它存在
   * （状态码只能在开流之前定）；在那之后才被删掉的，这一轮以 RUN_ERROR 收尾。
   */
  conversationId: string | null
  /** 打开这张画布。权限复核、配额、房间连接都是宿主的事 */
  openCanvas: (runId: string) => Promise<OpenedCanvas>
  /**
   * 发起者这个订阅者：在第一帧之前挂上，收到的序列与之后任何 {@link AgentRuntime.subscribe} 一致。
   * 宿主连接断了就调返回的 `unsubscribe` —— **断开不中止这一轮**。
   */
  emit: (event: AgentStreamEvent) => void
}

export type StartRunResult =
  | {
      ok: true
      runId: string
      /** 这一轮彻底结束（最后一帧发出、画布关掉、运行日志写完） */
      done: Promise<void>
      /** 发起者不再收事件（连接断了）；这一轮照常跑 */
      unsubscribe: () => void
    }
  | { ok: false; reason: 'disabled' | 'busy'; message: string }

export type SubscribeResult =
  | {
      ok: true
      /** 最后一帧已交给这个订阅者，或它已退订 */
      done: Promise<void>
      unsubscribe: () => void
    }
  /** 不是正在跑的那一轮 / 不是发起人（不区分，免得给出探测的机会） */
  | { ok: false; reason: 'not-found' }
  /** 补发缓冲溢出了，接不回完整序列 */
  | { ok: false; reason: 'overflowed' }

export type AbortResult = 'aborted' | 'not-running' | 'forbidden'
export type DeleteConversationResult = 'deleted' | 'running' | 'not-found'

export interface AgentRuntime {
  readonly enabled: boolean
  readonly modelLabel: string | null
  readonly disabledReason: string | null
  view(flowId: string, userId: string): Promise<AgentSessionView>
  listConversations(flowId: string, userId: string): Promise<AgentConversationSummary[]>
  /** 别人的会话和不存在的一样，都是 null */
  getConversation(flowId: string, userId: string, id: string): Promise<AgentConversationView | null>
  /** 这个会话正在跑一轮时拒绝 */
  deleteConversation(flowId: string, userId: string, id: string): Promise<DeleteConversationResult>
  isRunning(flowId: string): boolean
  start(input: StartRunInput): StartRunResult
  /**
   * 接回一轮：只有发起人、只有这张画布此刻在跑的那一轮。先**同步**补发自第一帧起的全部事件，
   * 再推后续的；最后一帧之后 `done` 兑现。返回之前补发就已经发完了。
   */
  subscribe(
    flowId: string,
    runId: string,
    userId: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): SubscribeResult
  /** 只有发起人能中止 */
  abort(flowId: string, userId: string): AbortResult
  /**
   * 进程退出前：中止所有在跑的轮次，并等它们收尾（对话落库、运行日志写完、画布关掉）。
   * 宿主要在关数据库之前 await 它（给个上限）。
   */
  abortAll(reason: string): Promise<void>
}

export type ValidatedPrompt = { ok: true; text: string; conversationId: string | null } | { ok: false; error: string }

/** `POST …/messages` 的请求体校验；路由直接用 */
export function validatePrompt(body: unknown): ValidatedPrompt {
  const raw = (body as { text?: unknown } | null)?.text
  if (typeof raw !== 'string') return { ok: false, error: 'text 必须是字符串' }
  const text = raw.trim()
  if (!text) return { ok: false, error: 'text 不能为空' }
  if (text.length > AGENT_PROMPT_MAX_LENGTH) {
    return { ok: false, error: `text 超过 ${AGENT_PROMPT_MAX_LENGTH} 字` }
  }

  const conversationId = (body as { conversationId?: unknown }).conversationId
  if (conversationId === undefined || conversationId === null) return { ok: true, text, conversationId: null }
  if (typeof conversationId !== 'string' || !conversationId) {
    return { ok: false, error: 'conversationId 必须是非空字符串或 null' }
  }
  if (conversationId.length > AGENT_CONVERSATION_ID_MAX_LENGTH) {
    return { ok: false, error: `conversationId 超过 ${AGENT_CONVERSATION_ID_MAX_LENGTH} 字` }
  }
  return { ok: true, text, conversationId }
}

interface Subscriber {
  onEvent: (event: AgentStreamEvent) => void
  complete: () => void
}

interface RunState {
  runId: string
  flowId: string
  userId: string
  /** UTC epoch 毫秒 */
  startedAt: number
  /** 新会话在准备好之前是 null —— 那时也没人知道它的 id，删不到它 */
  conversationId: string | null
  abort: (reason: string) => void
  done: Promise<void>
  /** 自第一帧起发出的全部事件；溢出后为 null（不再缓冲） */
  replay: AgentStreamEvent[] | null
  replayChars: number
  /** 最后一帧（RUN_FINISHED / RUN_ERROR）已经发出 */
  finished: boolean
  subscribers: Set<Subscriber>
}

const isTerminal = (event: AgentStreamEvent) =>
  event.type === AgentEventType.RUN_FINISHED || event.type === AgentEventType.RUN_ERROR

/** 工具日志里的参数摘要：id 类字段照写，字符串只记长度 —— 不把用户内容写进日志 */
const ID_KEYS = new Set([
  'id',
  'ids',
  'source',
  'target',
  'connectFrom',
  'sourcePort',
  'targetPort',
  'type',
  'command',
])

export function digestArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (ID_KEYS.has(key) && typeof value === 'string') parts.push(`${key}=${value}`)
    else if (ID_KEYS.has(key) && Array.isArray(value)) parts.push(`${key}=[${value.slice(0, 20).join(',')}]`)
    else if (typeof value === 'string') parts.push(`${key}(${value.length}字)`)
    else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`)
    // 按组传的对象（metadata / data）只记**字段名**，值一个字都不记
    else if (typeof value === 'object' && value !== null) parts.push(`${key}{${Object.keys(value).slice(0, 20).join(',')}}`)
    else if (value !== undefined) parts.push(key)
  }
  return parts.join(' ')
}

/**
 * 裁剪模型上下文：留最后 `max` 条，**切口落在一条用户消息上** ——
 * 从中间切开会留下一个没有对应 tool_use 的 tool_result，各家 API 都会拒。
 */
export function trimLlmHistory(messages: AgentMessage[], max: number): AgentMessage[] {
  if (messages.length <= max) return messages
  for (let index = messages.length - max; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') return messages.slice(index)
  }
  // 最近 max 条里一条用户消息都没有（一轮里工具调用极多）：宁可清空也不留半截
  return []
}

/** 对话记录只留最后 `max` 条（前端看的，没有配对约束，直接切） */
function trimChat(messages: AgentChatMessage[], max: number): AgentChatMessage[] {
  return messages.length > max ? messages.slice(messages.length - max) : messages
}

/**
 * 截到 `max` 字（含末尾的省略号）。不切开代理对，也不切开一个 `@{node:<id>}` ——
 * 半截提及在前端会显示成一串乱码，宁可整个丢掉。
 */
function clipText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let head = chars.slice(0, max - 1).join('')
  const open = head.lastIndexOf('@{')
  if (open !== -1 && !head.includes('}', open)) head = head.slice(0, open)
  return `${head.trimEnd()}…`
}

/** 会话标题：首条用户消息的开头，原文（提及保留，前端按提及渲染），空白折成一个空格 */
export function conversationTitle(text: string): string {
  return clipText(text.replace(/\s+/g, ' ').trim(), AGENT_TITLE_MAX_LENGTH)
}

/** 把模型回复压成一行纯文本：去掉 markdown 的记号，提及换成「@节点」（这里没有画布可查名字） */
function plainText(text: string): string {
  return text
    // 全局正则交给 replace 是安全的：它从头扫、不受 lastIndex 残留影响
    .replace(NODE_MENTION_PATTERN, '@节点')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 会话摘要：最近一条 assistant 消息的开头（纯文本）。
 * 它只调了工具、没说话时，拿工具调用的那几句话顶上；再没有就是出错说明；还没有 assistant 消息时为空串。
 */
export function conversationSummary(messages: AgentChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const text =
      plainText(message.text) ||
      message.toolCalls.map((call) => call.summary).join('；') ||
      (message.error ?? '')
    return clipText(text, AGENT_SUMMARY_MAX_LENGTH)
  }
  return ''
}

/** 落库的 pi messages 是外部数据：不是数组就当没有（坏数据丢的只是上下文，不值得让这一轮失败） */
function asLlmMessages(value: unknown): AgentMessage[] {
  return Array.isArray(value) ? (value as AgentMessage[]) : []
}

function conversationGone(): AgentStreamEvent {
  return {
    type: AgentEventType.RUN_ERROR,
    message: '这个会话不存在或已被删除',
    code: 'conversation_not_found',
    timestamp: Date.now(),
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...options.limits }
  const resolved = options.model
  const { store, runLog } = options
  /** flowId → 正在跑的那一轮。进程内存，多副本不共享（见文件头） */
  const runs = new Map<string, RunState>()

  /** 会话是发起人私有的：「这个会话在跑」只可能对发起人自己的会话成立 */
  const isConversationRunning = (flowId: string, userId: string, id: string) => {
    const run = runs.get(flowId)
    return run !== undefined && run.userId === userId && run.conversationId === id
  }

  function deliver(subscriber: Subscriber, event: AgentStreamEvent) {
    try {
      subscriber.onEvent(event)
    } catch (err) {
      // 一个订阅者写不出去（连接已断）不该打断这一轮，也不该连累别的订阅者
      console.warn('[agent] 事件发送失败', err)
    }
  }

  /** 一轮的每一帧都从这里出去：先进补发缓冲，再按顺序交给每个订阅者（见文件头） */
  function publish(run: RunState, event: AgentStreamEvent) {
    if (run.finished) {
      console.warn(`[agent] run=${run.runId} 最后一帧之后还有事件（${event.type}），丢弃`)
      return
    }
    if (run.replay) {
      const chars = JSON.stringify(event).length
      if (run.replay.length >= limits.replayEvents || run.replayChars + chars > limits.replayChars) {
        console.warn(
          `[agent] run=${run.runId} 补发缓冲超过上限（${run.replay.length} 帧 / ${run.replayChars} 字），之后不能再接回`,
        )
        run.replay = null
        run.replayChars = 0
      } else {
        run.replay.push(event)
        run.replayChars += chars
      }
    }
    const terminal = isTerminal(event)
    if (terminal) run.finished = true
    for (const subscriber of [...run.subscribers]) deliver(subscriber, event)
    if (terminal) {
      for (const subscriber of run.subscribers) subscriber.complete()
      run.subscribers.clear()
    }
  }

  function subscriberOf(onEvent: (event: AgentStreamEvent) => void) {
    let complete!: () => void
    const done = new Promise<void>((resolve) => (complete = resolve))
    const subscriber: Subscriber = { onEvent, complete }
    return { subscriber, done }
  }

  function summaryOf(row: StoredConversationMeta): AgentConversationSummary {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      running: isConversationRunning(row.flowId, row.userId, row.id),
    }
  }

  function viewOf(row: StoredConversation): AgentConversationView {
    return { ...summaryOf(row), messages: row.messages }
  }

  /** 旁路写入：失败只记一笔（见文件头「运行日志 fail open」） */
  function sideWrite(label: string, task: () => Promise<void>): Promise<void> {
    try {
      return task().catch((err: unknown) => console.error(`[agent] ${label}写入失败`, err))
    } catch (err) {
      console.error(`[agent] ${label}写入失败`, err)
      return Promise.resolve()
    }
  }

  async function execute(input: StartRunInput, run: RunState, ac: AbortController): Promise<void> {
    if (!resolved) return
    const { flowId, userId, text } = input
    const { startedAt } = run

    const send = (events: AgentStreamEvent[]) => {
      for (const event of events) publish(run, event)
    }

    const userMessage: Extract<AgentChatMessage, { role: 'user' }> = {
      id: createId('msg'),
      role: 'user',
      text,
      createdAt: Date.now(),
    }

    // —— 1. 准备会话：用户消息先落库，再调模型 ——
    let conversationId: string
    let chat: AgentChatMessage[]
    let llmHistory: AgentMessage[]
    let previousSummary: string
    try {
      if (input.conversationId === null) {
        chat = [userMessage]
        llmHistory = []
        previousSummary = ''
        const created = await store.create({
          flowId,
          userId,
          title: conversationTitle(text),
          summary: '',
          messages: chat,
          llmMessages: [],
        })
        conversationId = created.id
      } else {
        const existing = await store.getWithContext(flowId, userId, input.conversationId)
        if (!existing) {
          send([conversationGone()])
          return
        }
        conversationId = existing.id
        chat = trimChat([...existing.messages, userMessage], limits.chatMessages)
        llmHistory = asLlmMessages(existing.llmMessages)
        previousSummary = existing.summary
        if (!(await store.save(flowId, userId, conversationId, { messages: chat, summary: previousSummary }))) {
          send([conversationGone()])
          return
        }
      }
    } catch (err) {
      console.error(`[agent] run=${run.runId} flow=${flowId} 会话没能保存，这一轮不开始`, err)
      send([
        {
          type: AgentEventType.RUN_ERROR,
          message: `对话没能保存，这一轮没有开始：${errorText(err)}`,
          code: 'persist_failed',
          timestamp: Date.now(),
        },
      ])
      return
    }
    run.conversationId = conversationId

    // —— 2. 开始 ——
    const tools = new Map<string, CanvasTool>()
    const mapper = createRunEventMapper({
      threadId: conversationId,
      runId: run.runId,
      assistantMessageId: createId('msg'),
      describeTool: (name, args) => tools.get(name)?.describe(args as never) ?? name,
    })
    send(mapper.start(userMessage))
    console.info(
      `[agent] run=${run.runId} flow=${flowId} user=${userId} conversation=${conversationId} 开始（${text.length} 字）`,
    )

    const runStart: AgentRunStart = {
      runId: run.runId,
      conversationId,
      flowId,
      userId,
      model: resolved.label,
      startedAt,
    }
    // 不 await：和下面的开画布并行。结尾那笔 finishRun 会先等它，保证两笔的先后
    const runStarted = sideWrite('运行日志', () => runLog.startRun(runStart))
    const toolLogs: Promise<void>[] = []

    let canvas: OpenedCanvas | null = null
    let sandbox: Sandbox | null = null
    let abortReason: string | null = null
    let toolCalls = 0
    let outcome: RunOutcome
    let nextLlm = llmHistory

    const timer = setTimeout(() => run.abort(`超过 ${limits.timeoutMs / 1000} 秒，已停止`), limits.timeoutMs)

    // —— 3. 跑 ——
    try {
      canvas = await input.openCanvas(run.runId)
      const opened = canvas

      for (const tool of createCanvasTools({ canvas: opened })) tools.set(tool.name, tool)
      if (options.sandbox) {
        sandbox = await options.sandbox.create(flowId, run.runId)
        // 一张画布一个项目：run 开始时的画布快照放进工作目录，媒体命令可以读它
        await sandbox.writeFile('canvas.json', JSON.stringify(await opened.read(canvasSnapshot), null, 2))
        const media = createMediaTool(sandbox)
        tools.set(media.name, media)
      }

      const prompt = await opened.read((doc) => expandMentions(text, (id) => lookupMention(doc, id)))

      const agent = new Agent({
        initialState: {
          systemPrompt: SYSTEM_PROMPT,
          model: resolved.model,
          thinkingLevel: 'off',
          tools: [...tools.values()] as AgentTool[],
          messages: llmHistory,
        },
        getApiKey: () => resolved.apiKey,
        ...(options.streamFn ? { streamFn: options.streamFn } : {}),
        // 一次工具调用一个 Y 事务、按模型给出的顺序执行：「先建节点、再连线」不能并发
        toolExecution: 'sequential',
        beforeToolCall: async () => {
          toolCalls += 1
          if (toolCalls > limits.maxToolCalls) {
            return { block: true, reason: `本轮工具调用已达上限 ${limits.maxToolCalls} 次，请停止并向用户说明进度` }
          }
          return undefined
        },
      })

      let turns = 0
      // 工具调用日志要的参数摘要和耗时：end 事件不带参数，start 时记下来
      const startedCalls = new Map<string, { args: unknown; at: number }>()
      agent.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          startedCalls.set(event.toolCallId, { args: event.args, at: Date.now() })
        }
        if (event.type === 'turn_end') {
          turns += 1
          if (turns >= limits.maxTurns) run.abort(`超过本轮步数上限 ${limits.maxTurns}，已停止`)
        }
        const mapped = mapper.handle(event)
        if (event.type === 'tool_execution_end') {
          const begun = startedCalls.get(event.toolCallId)
          startedCalls.delete(event.toolCallId)
          const details = (event.result as { details?: { elementIds?: unknown } } | undefined)?.details
          const elementIds = Array.isArray(details?.elementIds)
            ? details.elementIds.filter((id): id is string => typeof id === 'string')
            : []
          // 错误原因取 mapper 刚算出来的那份（就是回给模型的文本），截短；它是工具自己的报错，不是用户正文
          const view = mapper.message.toolCalls.find((call) => call.id === event.toolCallId)
          const now = Date.now()
          toolLogs.push(
            sideWrite('工具调用日志', () =>
              runLog.recordToolCall({
                runId: run.runId,
                toolCallId: event.toolCallId,
                name: event.toolName,
                ok: !event.isError,
                args: digestArgs(begun?.args),
                elementIds,
                error: event.isError ? (view?.error ?? '工具调用失败').slice(0, TOOL_ERROR_LOG_LIMIT) : null,
                durationMs: begun ? now - begun.at : 0,
                createdAt: now,
              }),
            ),
          )
        }
        send(mapped)
      })

      run.abort = (reason) => {
        abortReason ??= reason
        agent.abort()
      }
      /*
       * 挂上真正的 abort 之前就已经要求中止了（开画布那几十毫秒里点了停止 / 超时 / 进程退出）：
       * 不调模型。`agent.abort()` 在 prompt 之前调是空操作，所以这里得自己拦。
       */
      if (ac.signal.aborted) abortReason ??= String(ac.signal.reason ?? '已中止')
      else await agent.prompt(prompt)

      nextLlm = trimLlmHistory(agent.state.messages, limits.llmMessages)
      const last = agent.state.messages.at(-1)
      const aborted = abortReason !== null || (last?.role === 'assistant' && last.stopReason === 'aborted')
      outcome = aborted
        ? { type: 'cancelled', reason: abortReason ?? '已中止' }
        : mapper.modelError
          ? { type: 'error', message: mapper.modelError, code: 'model_error' }
          : { type: 'success' }
    } catch (err) {
      // 打开画布失败（失权 / 画布已删 / 配额锁定）、沙箱建不起来……这一轮直接失败
      outcome = abortReason
        ? { type: 'cancelled', reason: abortReason }
        : { type: 'error', message: errorText(err), code: 'run_failed' }
    } finally {
      clearTimeout(timer)
    }

    // —— 4. 一次 save 落定这一轮 ——
    const finishing = mapper.finish(outcome)
    const finalChat = trimChat([...chat, mapper.message], limits.chatMessages)
    let persistError: string | null = null
    try {
      const saved = await store.save(flowId, userId, conversationId, {
        messages: finalChat,
        summary: conversationSummary(finalChat),
        llmMessages: nextLlm,
      })
      if (!saved) persistError = '会话已被删除'
    } catch (err) {
      persistError = errorText(err)
    }
    if (persistError !== null) {
      console.error(`[agent] run=${run.runId} flow=${flowId} conversation=${conversationId} 对话没能保存：${persistError}`)
      // 换掉最后一帧（RUN_FINISHED / RUN_ERROR），前面关文字段的那几帧照发
      const terminal = finishing.pop()
      const earlier = terminal?.type === AgentEventType.RUN_ERROR ? `${terminal.message}；另外，` : ''
      finishing.push({
        type: AgentEventType.RUN_ERROR,
        message: `${earlier}这一轮的对话没能保存（${persistError}），刷新后会丢失；画布上已做的改动不受影响`,
        code: 'persist_failed',
        timestamp: Date.now(),
      })
    }

    // —— 5. 收尾 ——
    send(finishing)

    const closing: Promise<unknown>[] = []
    if (canvas) closing.push(canvas.close())
    if (sandbox) closing.push(sandbox.dispose())
    const closed = await Promise.allSettled(closing)
    for (const item of closed) {
      if (item.status === 'rejected') console.warn(`[agent] run=${run.runId} 收尾失败`, item.reason)
    }

    const finish: AgentRunFinish = {
      ...runStart,
      status: persistError !== null ? 'error' : outcome.type,
      error:
        persistError !== null
          ? `对话没能保存：${persistError}`
          : outcome.type === 'error'
            ? outcome.message
            : outcome.type === 'cancelled'
              ? (outcome.reason ?? '已中止')
              : null,
      toolCallCount: mapper.message.toolCalls.length,
      finishedAt: Date.now(),
    }
    await Promise.all([runStarted, ...toolLogs])
    await sideWrite('运行日志', () => runLog.finishRun(finish))

    console.info(
      `[agent] run=${run.runId} flow=${flowId} 结束（${finish.status}，${finish.toolCallCount} 次工具调用，` +
        `${finish.finishedAt - startedAt}ms）`,
    )
  }

  return {
    enabled: resolved !== null,
    modelLabel: resolved?.label ?? null,
    disabledReason: resolved ? null : (options.disabledReason ?? '没有配置模型'),

    async view(flowId, userId) {
      // 先同步取一份快照：下面的 await 期间这一轮可能结束，但这次回复要自洽
      const run = runs.get(flowId) ?? null
      const mine = run !== null && run.userId === userId
      const ownConversationId = mine ? run.conversationId : null

      const [initiatorName, latest] = await Promise.all([
        run ? options.displayName(run.userId) : Promise.resolve(''),
        (async () => {
          // 我有一轮在跑：面板默认打开那一轮所在的会话（它也可能刚被删掉 —— 退回最近的那个）
          const running = ownConversationId ? await store.get(flowId, userId, ownConversationId) : null
          return running ?? (await store.latest(flowId, userId))
        })(),
      ])

      const activeRun: AgentActiveRunView | null = run
        ? {
            runId: run.runId,
            conversationId: ownConversationId,
            initiator: { id: run.userId, name: initiatorName },
            mine,
            startedAt: run.startedAt,
          }
        : null
      return {
        enabled: resolved !== null,
        running: activeRun !== null,
        activeRun,
        latest: latest ? viewOf(latest) : null,
      }
    },

    async listConversations(flowId, userId) {
      return (await store.list(flowId, userId)).map(summaryOf)
    },

    async getConversation(flowId, userId, id) {
      const row = await store.get(flowId, userId, id)
      return row ? viewOf(row) : null
    },

    async deleteConversation(flowId, userId, id) {
      // 正在跑的那个会话不能删：结尾那次 save 会扑空，这一轮的对话就凭空没了
      if (isConversationRunning(flowId, userId, id)) return 'running'
      return (await store.remove(flowId, userId, id)) ? 'deleted' : 'not-found'
    },

    isRunning: (flowId) => runs.has(flowId),

    start(input) {
      if (!resolved) {
        return { ok: false, reason: 'disabled', message: options.disabledReason ?? '没有配置模型' }
      }
      // 同步占位：从这里到 runs.set 之间没有 await，第二个发起者不可能插进来
      if (runs.has(input.flowId)) {
        return { ok: false, reason: 'busy', message: '这张画布上已经有一轮 agent 正在运行，请等它结束' }
      }

      const ac = new AbortController()
      // 发起者是第一个订阅者，在第一帧之前挂上（execute 的同步段就可能发出那一帧 RUN_ERROR）
      const initiator = subscriberOf(input.emit)
      const run: RunState = {
        runId: createId('run'),
        flowId: input.flowId,
        userId: input.userId,
        startedAt: Date.now(),
        conversationId: input.conversationId,
        // 真正的 Agent 建好之前，中止只是记下来；建好后 execute 会把它换成真的
        abort: (reason) => ac.abort(reason),
        done: Promise.resolve(),
        replay: [],
        replayChars: 0,
        finished: false,
        subscribers: new Set([initiator.subscriber]),
      }
      runs.set(input.flowId, run)

      run.done = execute(input, run, ac)
        .catch((err: unknown) => console.error(`[agent] run=${run.runId} 异常`, err))
        .finally(() => {
          // 没走到最后一帧就异常退出了：补一帧收尾，订阅者才知道这一轮完了
          if (!run.finished) {
            publish(run, {
              type: AgentEventType.RUN_ERROR,
              message: '这一轮异常结束',
              code: 'run_failed',
              timestamp: Date.now(),
            })
          }
          // 删掉条目 = 释放补发缓冲；之后再来接回的一律 not-found
          if (runs.get(input.flowId) === run) runs.delete(input.flowId)
        })

      return {
        ok: true,
        runId: run.runId,
        done: run.done,
        unsubscribe: () => {
          if (run.subscribers.delete(initiator.subscriber)) initiator.subscriber.complete()
        },
      }
    },

    subscribe(flowId, runId, userId, onEvent) {
      const run = runs.get(flowId)
      if (!run || run.runId !== runId || run.userId !== userId) return { ok: false, reason: 'not-found' }
      if (!run.replay) return { ok: false, reason: 'overflowed' }

      const { subscriber, done } = subscriberOf(onEvent)
      // 补发与挂上之间没有 await：这期间不可能有新帧插进来，所以不漏也不重
      for (const event of run.replay) deliver(subscriber, event)
      if (run.finished) {
        // 最后一帧已经发过了（这一轮正在关画布、写日志）：补发里就有它，到此为止
        subscriber.complete()
        return { ok: true, done, unsubscribe: () => {} }
      }
      run.subscribers.add(subscriber)
      return {
        ok: true,
        done,
        unsubscribe: () => {
          if (run.subscribers.delete(subscriber)) subscriber.complete()
        },
      }
    },

    abort(flowId, userId) {
      const run = runs.get(flowId)
      if (!run) return 'not-running'
      if (run.userId !== userId) return 'forbidden'
      run.abort('已中止')
      return 'aborted'
    },

    async abortAll(reason) {
      const pending = [...runs.values()]
      for (const run of pending) run.abort(reason)
      await Promise.allSettled(pending.map((run) => run.done))
    },
  }
}
