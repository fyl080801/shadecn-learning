import type { AgentEvent, AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Api, Message, Model } from '@earendil-works/pi-ai'
import { withoutImages } from './media.ts'
import type { AgentSkillId } from './skills/registry.ts'
import type { CanvasToolDetails } from './tools.ts'

/**
 * runner（沙箱里的 pi 推理循环）↔ 网关（服务端）的线协议 —— **两端的类型只在这一个文件里定义**（docs/22 §4）。
 *
 * ## 谁在哪一端
 *
 * - **runner**（`runner/`）：沙箱里的进程。只有网关地址、一次性 bootstrap token、工作目录和 `PATH`，
 *   没有任何长期密钥。跑 pi 的 Agent 循环；画布工具只是 RPC 代理（schema / 描述 / 能力来自同一份 `tools.ts`），
 *   模型请求经 pi 的 `streamProxy` 交给网关（服务端带真实 key 去调上游，拿回事件流）；ffmpeg / ffprobe 在自己的工作目录里跑。
 * - **网关**（`gateway.ts`，宿主挂在 {@link AGENT_GATEWAY_PATH}）：换发令牌、服务端调用模型（真实 key 只在这里）、
 *   画布工具执行（服务端的 `tools.ts` + 宿主的 direct connection）、事件上报、改动通知。
 *   **每次调用都按这一轮的 `authorize(capability)` 实时判权，不信令牌里的 scope**（docs/22 §2 第 4 条）。
 *
 * ## 一轮的调用顺序（全部 `POST`，JSON，除了换令牌都带 `Authorization: Bearer <run 短令牌>`）
 *
 * 1. `/sts/token` `{ grantType: 'bootstrap', bootstrapToken }` → run 短令牌（bootstrap token 兑换一次即废）；
 * 2. `/run/input` → {@link RunnerInput}：系统提示、这一轮的提示词（跨轮差异 + 展开提及之后的用户消息）、
 *    模型上下文、这一轮提供 / 一开始就加载的技能（runner 按同一份注册表展开成工具）、模型描述（不含地址和 key）；
 * 3. 跑 pi：模型请求走 `/model/<agentId>/api/stream`（pi 的 `streamProxy`：服务端用自己解析的模型、参数和 key 调上游，
 *    以 SSE 下发 `ProxyAssistantMessageEvent`，docs/22 §4.3）；画布工具走 `/canvas/tool`；
 *    pi 的事件裁成 {@link RunnerEvent} 分批 `/events` 上报（服务端经 `events.ts` 映射成 AG-UI —— 映射只在服务端）；
 *    **一批工具调用结束时**（`turn_end` 先把事件冲完；循环要接着请求模型时，pi 的 `prepareNextTurnWithContext` 里）
 *    `/canvas/changes` 取别人的改动通知，有就作为下一次请求前追加的消息交给 pi（docs/20 §3.10.2 的插入时机，规则在 runner 里执行）；
 * 4. 事件冲完后 `/run/finish`，然后进程退出。
 *
 * ## 子 agent（docs/20 §3.10.11）
 *
 * 父 agent 的 `delegate_task` 在 runner 里执行：先 `/agent/delegate` 登记（服务端分配子 agent id、判上限、转交占用、
 * 展开提及、定好它的系统提示与一开始加载的技能），runner 在**同一个进程**里再建一个 pi `Agent` 跑它，
 * 做完 `/agent/finish` 交回（服务端释放它的占用、汇总它改过的节点、拼好回给父 agent 的那段结果）。
 * 子 agent 的工具调用 / 事件带上它的 {@link ToolCallRequest.agentId} / `agentId`；**不带 = 父 agent**。
 * agent id 只用来在这一轮内部区分是谁（占用、「改过」、步数、事件归到哪个子任务）—— 它们都还是这一轮的令牌，
 * 服务端只认自己分配过、还没结束的 id；子 agent 不能再派（服务端拒绝 `agentId` 不是父 agent 的派发）。
 *
 * 中止 / 超时 / 失权不经协议通知 runner：服务端当场作废令牌、由驱动杀掉沙箱（docs/22 §5 stop），
 * 收尾帧由服务端按它已经收到的事件补齐。所以 runner 被杀在任何一步都是合法的结局。
 *
 * ## 令牌失效 = 401
 *
 * 伪造 / 过期 / 别的 run 的 / 这一轮已结束或已被叫停 —— 一律 401，不区分原因（原因只进服务端日志）。
 * runner 收到 401 就停下退出。
 */

/**
 * runner ↔ 网关线协议的版本（整数）。**改了这份文件里的线协议（路由、请求 / 响应形状、`RUNNER_ENV`、事件形状、校验规则）
 * 就加一**，并同步更新 `test/protocol-version.test.ts` 里记录的哈希（不加版本号测试会失败）。
 *
 * 为什么需要：`oci` 驱动用预先构建的镜像，镜像没重建时 runner 和服务端的协议会悄悄错位。
 * runner 在 bootstrap 兑换请求里带上它，网关不一致（含缺失 = 老镜像）就拒绝这一轮：
 * 回 {@link PROTOCOL_MISMATCH_STATUS} + {@link ProtocolMismatchBody}（和 401 能区分），编排层以 `runner_protocol_mismatch` 收尾。
 * `process` 驱动直接跑源码，永远一致。
 */
export const RUNNER_PROTOCOL_VERSION = 6

/** 版本不一致时网关的 HTTP 状态码与 `error` 字段（不要和 401 混：令牌失效是另一回事） */
export const PROTOCOL_MISMATCH_STATUS = 409
export const PROTOCOL_MISMATCH_ERROR = 'protocol_mismatch'

/** runner 因协议版本不一致被网关拒绝时的进程退出码（`runner/main.ts`；3 = 令牌被拒，1 = 其他错误） */
export const RUNNER_EXIT_PROTOCOL_MISMATCH = 4

/** 宿主把网关挂在这个路径下（apps/server 的 `routes/agent-gateway.ts`）；runner 看到的网关地址以它结尾 */
export const AGENT_GATEWAY_PATH = '/api/agent-gateway'

/** 网关的各个接口（相对 {@link AGENT_GATEWAY_PATH}） */
export const GATEWAY_ROUTES = {
  token: '/sts/token',
  input: '/run/input',
  tool: '/canvas/tool',
  changes: '/canvas/changes',
  events: '/events',
  finish: '/run/finish',
  /** 父 agent 派一个子 agent（docs/20 §3.10.11）：登记、判上限、转交占用，回子 agent 的输入 */
  delegate: '/agent/delegate',
  /** 一个子 agent 做完了：交回结果，服务端释放它的占用、拼好给父 agent 的结果 */
  agentFinish: '/agent/finish',
  /**
   * 服务端调用模型的前缀（docs/22 §4.3）：完整路径是 `/model/<agentId>` + {@link MODEL_STREAM_SUFFIX}。
   * runner 交给 `streamProxy` 的 `proxyUrl` = 网关地址 + {@link modelProxyRoute}（`streamProxy` 自己补 `/api/stream`、
   * 不让加请求头，所以 agent 写在路径里）
   */
  model: '/model',
} as const

/** `streamProxy` 固定往 `${proxyUrl}/api/stream` 发请求 */
export const MODEL_STREAM_SUFFIX = '/api/stream'

/** 一个 agent 的 `proxyUrl`（相对网关）：`/model/<agentId>` */
export function modelProxyRoute(agentId: string): string {
  return `${GATEWAY_ROUTES.model}/${encodeURIComponent(agentId)}`
}

/** 路由 → 它的 agent id；不是模型请求的路由（或 id 不合法）为 null */
export function modelStreamAgentOf(route: string): string | null {
  const match = /^\/model\/([^/]+)\/api\/stream$/.exec(route)
  if (!match) return null
  let agentId: string
  try {
    agentId = decodeURIComponent(match[1]!)
  } catch {
    return null
  }
  return shortString(agentId, ID_MAX) ? agentId : null
}

/**
 * runner 进程的环境变量 —— **沙箱里只有这三个加 `PATH`**（docs/22 §10 验收 1）。
 * 驱动从零造环境，不继承服务端进程的任何变量（LLM key、数据库连接串、会话密钥、Redis 都没有）。
 */
export const RUNNER_ENV = {
  /** runner 看到的网关地址（含 {@link AGENT_GATEWAY_PATH}） */
  gatewayUrl: 'SHADECN_GATEWAY_URL',
  /** 一次性 bootstrap token：兑换一次即废；runner 读到后立刻从自己的环境里删掉 */
  bootstrapToken: 'SHADECN_BOOTSTRAP_TOKEN',
  /** 这一轮的工作目录（ffmpeg 的输入输出、canvas.json） */
  workdir: 'SHADECN_WORKDIR',
} as const

// —— 令牌 ——

export const RUN_TOKEN_ISSUER = 'shadecn-agent-sts'
export const RUN_TOKEN_AUDIENCE = 'agent-gateway'

/**
 * run 短令牌的声明（docs/22 §3）。RFC 8693 的 `act`：`sub` 是「代表谁」（发起人），`act.sub` 是「谁在执行」（这一轮）。
 * 时间是 JWT 惯例的**秒**。`scope` 只是给人看的缓存：网关每次都按 Grant 实时判权，不读它。
 */
export interface RunTokenClaims {
  iss: typeof RUN_TOKEN_ISSUER
  sub: `user:${string}`
  act: { sub: `agent-run:${string}` }
  grant_id: string
  aud: typeof RUN_TOKEN_AUDIENCE
  scope: string
  iat: number
  exp: number
  /** 每张令牌各不相同（续期换新的一张） */
  jti: string
}

export type StsTokenRequest =
  /**
   * 首次：用驱动注入的 bootstrap token 换。`protocolVersion` 是 runner 的 {@link RUNNER_PROTOCOL_VERSION}
   * （网关硬校验）；`buildId` 是 runner 的构建 id（`build-id.ts`，只用于软提示）。
   */
  | { grantType: 'bootstrap'; bootstrapToken: string; protocolVersion: number | null; buildId: string | null }
  /** 续期：带着当前有效、未过期的 run 短令牌（Authorization 头）换一张新的 */
  | { grantType: 'renew' }

export interface StsTokenResponse {
  token: string
  /** UTC epoch 毫秒 */
  expiresAt: number
}

// —— 本轮输入 ——

/**
 * 交给 runner 的模型描述：pi 的 `Model` 去掉 `baseUrl`（真实上游地址只在服务端）和 `headers`（可能带凭据）。
 * runner 只拿它给 pi 的 `Agent` 当模型元数据（`streamProxy` 拼半成品消息用 `api` / `provider` / `id`）；
 * 网关调上游用的是服务端自己解析的那个模型，runner 送来的 `model` 不看。
 */
export type RunnerModel = Omit<Model<Api>, 'baseUrl' | 'headers'>

export interface RunnerInput {
  runId: string
  systemPrompt: string
  /** 这一轮交给模型的那条用户消息（跨轮差异在前、展开提及之后的用户原文在后） */
  prompt: string
  /** 之前几轮的模型上下文（pi 的 messages） */
  llmMessages: AgentMessage[]
  /**
   * 这一轮的技能（docs/23 §3.2）：`offered` = 提供的（Grant 与部署条件都满足），`loaded` = 一开始就加载的（⊆ offered）。
   * runner 按注册表把 `loaded` 展开成工具（外加平台工具 `load_skill`）；之后模型 `load_skill` 成功时，
   * 网关的回复带着新加载的技能 id，runner 再把它的工具并进来。runner 不可信：网关只执行服务端记着「已加载」的技能里的工具。
   */
  skills: { loaded: AgentSkillId[]; offered: AgentSkillId[] }
  model: RunnerModel
  limits: {
    /** 一轮里最多几次工具调用；网关另外按同一个数硬拦画布工具 */
    maxToolCalls: number
  }
  /** 写进工作目录的文件（相对路径 → 内容）：提供的技能的初始化钩子给的（如 `media-exec` 的 `canvas.json`） */
  files: Record<string, string>
}

// —— 画布工具 ——

/** 父 agent 的 agent id：不带 `agentId` 的请求 / 事件都算它的 */
export const MAIN_AGENT_ID = 'main'

export interface ToolCallRequest {
  toolCallId: string
  name: string
  args: unknown
  /** 哪个 agent 调的（子 agent 的 id，服务端在 `/agent/delegate` 里分配）；不带 = 父 agent */
  agentId?: string
}

export type ToolCallResponse =
  /**
   * `content` 可以带图片块（`view_node_media`，base64）：图片**只**走这条下行，进 runner 里 pi 的上下文；
   * 上行的事件里一律换成文字占位（{@link runnerEventOf} / {@link parseEventsRequest}，见 `media.ts` 的 `imagePlaceholder`）
   */
  | {
      isError: false
      content: AgentToolResult<CanvasToolDetails>['content']
      details: CanvasToolDetails
      /**
       * 提前结束这一批（pi 的 `terminate`）：只有 `load_skill` 成功加载时为 true（`details.loadedSkill` 是新技能）。
       * 服务端照旧带上（老镜像靠它结束这一批、并入新工具后 `continue()`）；现在的 runner 对 `load_skill` 剥掉它，
       * 在 pi 的 `prepareNextTurnWithContext` 里把新工具并进下一次请求（docs/23 §3.3）
       */
      terminate?: boolean
    }
  /** 工具报错 / 参数不对 / 判权没过 / 超过上限：`message` 原样回给模型 */
  | { isError: true; message: string }

// —— 别人的改动（下行） ——

/**
 * `/canvas/changes` 的回复：服务端先把合并窗口里攒着的冲掉，排着的通知并成一条（docs/20 §3.10.2）。
 * runner 拿 `text` 作为一条用户消息交给 pi（`prepareNextTurnWithContext` 返回的 `messages`）；pi 把它放进上下文时，上报的 `message_end` 带上 `steerId = id`，
 * 服务端那时才发 `agent.canvas-change`、记进对话。没交出去的那些留给跨轮差异。
 */
export interface CanvasChangesResponse {
  change: { id: string; text: string } | null
}

// —— 事件（上行） ——

/**
 * pi 事件裁剪后的上报形状 —— **只有 `events.ts` 与编排层要读的字段**（同名同形，`events.ts` 直接吃）。
 * 最占地方的 `message_update.message`（每个 token 一份完整的半成品消息）不上报；思考内容、工具调用的增量也不报。
 * **图片块不上报**：`message_end` 的消息和 `tool_execution_end` 的结果里的图片换成文字占位（{@link slimMessage}）——
 * 服务端据此重建、落库的模型上下文因此不带 base64，前端的工具结果里也没有图片字节。
 * 这只是裁剪，不是映射：pi → AG-UI 的映射**只在服务端的 `events.ts`**。
 */
export type RunnerEvent = RunnerEventBody & {
  /** 子 agent 的事件带上它的 id（只用于这一轮内部的区分，见文件头「子 agent」）；不带 = 父 agent */
  agentId?: string
}

export type RunnerEventBody =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } | { type: 'text_end' } }
  /** pi 往上下文里追加的每一条消息（用户提示、assistant 回复、工具结果、steer 进去的通知）；服务端据此重建模型上下文 */
  | { type: 'message_end'; message: AgentMessage; steerId?: string }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: { content: unknown[]; details?: unknown }
      isError: boolean
    }
  /** 一批（一次模型回复 + 它的工具调用）结束；只用于界面（步数由网关按模型请求数，docs/22 §4.3） */
  | { type: 'turn_end'; toolResultCount: number }

// —— 子 agent（docs/20 §3.10.11） ——

/** `/agent/delegate` 的请求：`agentId` 是**发起派发的** agent（只有父 agent 能派，服务端拒绝别的） */
export interface DelegateRequest {
  agentId: string
  /** 父 agent 那次 `delegate_task` 调用的 id：子任务条目挂在它上面 */
  toolCallId: string
  brief: string
  nodeIds: string[]
}

/** 子 agent 的输入（服务端定好）：runner 拿它在同一个进程里再建一个 pi `Agent` */
export interface SubagentInput {
  agentId: string
  systemPrompt: string
  /** 它的第一条用户消息（任务说明 + 展开了提及的节点） */
  prompt: string
  /** 一开始就加载的技能（runner 按注册表展开成工具，外加 `load_skill`）；不含 `delegate`（只有一层） */
  skills: { loaded: AgentSkillId[] }
  limits: {
    /** 它自己的步数上限（每个 agent 各算，同单轮上限）；到了 runner 就停下它 */
    maxTurns: number
  }
}

export type DelegateResponse = { ok: true; agent: SubagentInput } | { ok: false; message: string }

/** 子 agent 怎么结束的（runner 报的；服务端可能改判，比如步数用完的一律算失败） */
export type SubagentStatus = 'done' | 'failed' | 'needs_confirmation'

export interface SubagentFinishRequest {
  agentId: string
  status: SubagentStatus
  /** 它最后的回复 */
  text: string
  /** 需要确认时它要问的问题 */
  question: string | null
  /** 失败时的原因 */
  error: string | null
}

/** `/agent/finish` 的回复：交给父 agent 的 `delegate_task` 结果（服务端拼的，限长） */
export interface SubagentFinishResponse {
  /** 失败（或这一轮已经停了）：runner 把 `text` 作为工具错误回给父 agent */
  isError: boolean
  text: string
  /** 给人看的一句话（父 agent 那条工具调用的 summary） */
  summary: string
  /** 它改过的节点 */
  changedNodeIds: string[]
}

export interface EventsRequest {
  /** 从 0 起逐批加一：服务端只收下一批，重放 / 乱序一律拒 */
  seq: number
  events: RunnerEvent[]
}

export interface FinishRequest {
  /** runner 自己出错时的原因；正常跑完为 null */
  error: string | null
}

/** 协议版本不一致的回复（409）：双方版本都带上，方便排查；`runnerVersion` 为 null = runner 没带（老镜像） */
export interface ProtocolMismatchBody extends GatewayErrorBody {
  error: typeof PROTOCOL_MISMATCH_ERROR
  runnerVersion: number | null
  serverVersion: number
}

/** 网关的错误回复（模型请求开流之前的拒绝另是 {@link ModelStreamErrorBody}） */
export interface GatewayErrorBody {
  error: string
  message: string
}

// —— 服务端调用模型（docs/22 §4.3） ——

/**
 * 模型请求开流之前的拒绝：`{ error: <原因> }` + 状态码（401 / 403 / 404 / 409 / 413 / 503）。
 * `streamProxy` 只认 `error` 是**字符串**（拼成 `Proxy error: …`）；开流之后的失败一律是 SSE 里的 `error` 帧
 */
export interface ModelStreamErrorBody {
  error: string
}

/**
 * `streamProxy` 的请求体 `{ model, context, options }` 里服务端**唯一**还看的部分：`context.messages`
 * （第 1 步上下文仍取 runner 送来的，只校验形状与大小；`model` / `options` 一个字段都不用 —— 模型、参数、请求头由服务端定）
 */
export interface ModelStreamRequest {
  messages: Message[]
}

/**
 * 消息里的图片块换成文字占位（返回新对象，**不改原消息** —— runner 里 pi 的上下文还要用带图的那份）。
 * runner 上报前换一次（不然一张图就能撑爆事件的请求体上限），服务端解析时再换一次（runner 不可信，不让它往库里塞 base64）。
 */
export function slimMessage<T extends AgentMessage>(message: T): T {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return message
  const slim = withoutImages(content)
  return slim === content ? message : ({ ...message, content: slim } as T)
}

/**
 * pi 事件 → 上报形状；`null` = 不上报。`steerIdOf` 认出「这条用户消息是我 steer 进去的那条」（按对象身份，所以先认再裁）。
 */
export function runnerEventOf(event: AgentEvent, steerIdOf: (message: AgentMessage) => string | undefined): RunnerEvent | null {
  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: inner.delta } }
      if (inner.type === 'text_end') return { type: 'message_update', assistantMessageEvent: { type: 'text_end' } }
      return null
    }
    case 'message_end': {
      // pi 1.x 的 system 消息（开头的系统提示、load_skill 之后的 `toolsAdded`）是给模型的，不上报；服务端也不收 system 角色
      if (event.message.role === 'system') return null
      const steerId = event.message.role === 'user' ? steerIdOf(event.message) : undefined
      return { type: 'message_end', message: slimMessage(event.message), ...(steerId ? { steerId } : {}) }
    }
    case 'tool_execution_start':
      return { type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }
    case 'tool_execution_end': {
      const result = event.result as { content?: unknown; details?: unknown } | undefined
      return {
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: { content: Array.isArray(result?.content) ? withoutImages(result.content as unknown[]) : [], details: result?.details },
        isError: event.isError,
      }
    }
    case 'turn_end':
      return { type: 'turn_end', toolResultCount: event.toolResults.length }
    default:
      return null
  }
}

// —— 服务端对上报内容的校验（runner 在不可信区：形状不对就整批拒） ——

/** 一批最多几条事件 */
export const EVENTS_PER_BATCH = 500
const ID_MAX = 256
const NAME_MAX = 64
const DELTA_MAX = 100_000
/** 子任务说明 / 子 agent 回复 / 问题的上限（服务端回给父 agent 时另外再截到更短） */
export const DELEGATE_BRIEF_MAX = 8000
export const DELEGATE_NODE_IDS_MAX = 20
const SUBAGENT_TEXT_MAX = 100_000
const SUBAGENT_NOTE_MAX = 4000
/** 节点 id 的格式（同提及 `@{node:<id>}` 认的字符集） */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const shortString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function isMessage(value: unknown): value is AgentMessage {
  if (!isObject(value)) return false
  const { role } = value
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return false
  return typeof value.content === 'string' || Array.isArray(value.content)
}

function parseEvent(raw: unknown): RunnerEvent | null {
  if (!isObject(raw)) return null
  if (raw.agentId !== undefined && !shortString(raw.agentId, ID_MAX)) return null
  const body = parseEventBody(raw)
  if (!body) return null
  return raw.agentId === undefined ? body : { ...body, agentId: raw.agentId as string }
}

function parseEventBody(raw: Record<string, unknown>): RunnerEventBody | null {
  switch (raw.type) {
    case 'message_update': {
      const inner = raw.assistantMessageEvent
      if (!isObject(inner)) return null
      if (inner.type === 'text_delta' && typeof inner.delta === 'string' && inner.delta.length <= DELTA_MAX) {
        return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: inner.delta } }
      }
      if (inner.type === 'text_end') return { type: 'message_update', assistantMessageEvent: { type: 'text_end' } }
      return null
    }
    case 'message_end': {
      if (!isMessage(raw.message)) return null
      if (raw.steerId !== undefined && !shortString(raw.steerId, ID_MAX)) return null
      return {
        type: 'message_end',
        message: slimMessage(raw.message),
        ...(raw.steerId ? { steerId: raw.steerId as string } : {}),
      }
    }
    case 'tool_execution_start':
      if (!shortString(raw.toolCallId, ID_MAX) || !shortString(raw.toolName, NAME_MAX)) return null
      return { type: 'tool_execution_start', toolCallId: raw.toolCallId, toolName: raw.toolName, args: raw.args }
    case 'tool_execution_end': {
      if (!shortString(raw.toolCallId, ID_MAX) || !shortString(raw.toolName, NAME_MAX)) return null
      if (typeof raw.isError !== 'boolean' || !isObject(raw.result) || !Array.isArray(raw.result.content)) return null
      return {
        type: 'tool_execution_end',
        toolCallId: raw.toolCallId,
        toolName: raw.toolName,
        result: { content: withoutImages(raw.result.content as unknown[]), details: raw.result.details },
        isError: raw.isError,
      }
    }
    case 'turn_end':
      if (!Number.isInteger(raw.toolResultCount) || (raw.toolResultCount as number) < 0) return null
      return { type: 'turn_end', toolResultCount: raw.toolResultCount as number }
    default:
      return null
  }
}

/** `/events` 的请求体；形状不对返回 null（整批拒，不挑着收） */
export function parseEventsRequest(body: unknown): EventsRequest | null {
  if (!isObject(body) || !Number.isInteger(body.seq) || (body.seq as number) < 0) return null
  if (!Array.isArray(body.events) || body.events.length > EVENTS_PER_BATCH) return null
  const events: RunnerEvent[] = []
  for (const raw of body.events) {
    const event = parseEvent(raw)
    if (!event) return null
    events.push(event)
  }
  return { seq: body.seq as number, events }
}

/** `/canvas/tool` 的请求体 */
export function parseToolCallRequest(body: unknown): ToolCallRequest | null {
  if (!isObject(body) || !shortString(body.toolCallId, ID_MAX) || !shortString(body.name, NAME_MAX)) return null
  if (body.agentId !== undefined && !shortString(body.agentId, ID_MAX)) return null
  return {
    toolCallId: body.toolCallId,
    name: body.name,
    args: body.args,
    ...(body.agentId !== undefined ? { agentId: body.agentId as string } : {}),
  }
}

/** `/agent/delegate` 的请求体：说明非空、节点 id 合法且不多于上限（去重） */
export function parseDelegateRequest(body: unknown): DelegateRequest | null {
  if (!isObject(body) || !shortString(body.agentId, ID_MAX) || !shortString(body.toolCallId, ID_MAX)) return null
  if (typeof body.brief !== 'string' || !body.brief.trim() || body.brief.length > DELEGATE_BRIEF_MAX) return null
  const raw = body.nodeIds ?? []
  if (!Array.isArray(raw) || raw.length > DELEGATE_NODE_IDS_MAX) return null
  if (!raw.every((id) => typeof id === 'string' && NODE_ID_PATTERN.test(id))) return null
  return { agentId: body.agentId, toolCallId: body.toolCallId, brief: body.brief.trim(), nodeIds: [...new Set(raw as string[])] }
}

const nullableNote = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : typeof value === 'string' ? value.slice(0, SUBAGENT_NOTE_MAX) : undefined

/** `/agent/finish` 的请求体 */
export function parseSubagentFinishRequest(body: unknown): SubagentFinishRequest | null {
  if (!isObject(body) || !shortString(body.agentId, ID_MAX)) return null
  if (body.status !== 'done' && body.status !== 'failed' && body.status !== 'needs_confirmation') return null
  if (typeof body.text !== 'string') return null
  const question = nullableNote(body.question)
  const error = nullableNote(body.error)
  if (question === undefined || error === undefined) return null
  return { agentId: body.agentId, status: body.status, text: body.text.slice(0, SUBAGENT_TEXT_MAX), question, error }
}

/** `/run/finish` 的请求体 */
export function parseFinishRequest(body: unknown): FinishRequest | null {
  if (!isObject(body)) return null
  if (body.error === null || body.error === undefined) return { error: null }
  return typeof body.error === 'string' ? { error: body.error.slice(0, 2000) } : null
}

/** `/sts/token` 的请求体 */
export function parseStsTokenRequest(body: unknown): StsTokenRequest | null {
  if (!isObject(body)) return null
  if (body.grantType === 'renew') return { grantType: 'renew' }
  if (body.grantType === 'bootstrap' && shortString(body.bootstrapToken, ID_MAX)) {
    return {
      grantType: 'bootstrap',
      bootstrapToken: body.bootstrapToken,
      // 缺失 / 类型不对一律当「没带」：网关把没带的视为不一致（老镜像）
      protocolVersion: Number.isSafeInteger(body.protocolVersion) ? (body.protocolVersion as number) : null,
      buildId: shortString(body.buildId, ID_MAX) ? body.buildId : null,
    }
  }
  return null
}

/** 模型请求的上下文里认的角色：pi 的 transcript 带 `system`（开头的系统提示 + 工具表、`toolsAdded`） */
function isTranscriptMessage(value: unknown): value is Message {
  if (!isObject(value)) return false
  const { role } = value
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'toolResult') return false
  return typeof value.content === 'string' || Array.isArray(value.content)
}

/** 模型请求（`streamProxy` 的请求体）：只取 `context.messages`，形状不对返回 null */
export function parseModelStreamRequest(body: unknown): ModelStreamRequest | null {
  if (!isObject(body) || !isObject(body.context) || !Array.isArray(body.context.messages)) return null
  const messages = body.context.messages as unknown[]
  if (!messages.every(isTranscriptMessage)) return null
  return { messages: messages as Message[] }
}
