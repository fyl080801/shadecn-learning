import type { AgentEvent, AgentMessage, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { Api, Model } from '@mariozechner/pi-ai'
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
 *   模型的 `baseUrl` 指向网关的模型代理、`apiKey` 是 run 短令牌；ffmpeg / ffprobe 在自己的工作目录里跑。
 * - **网关**（`gateway.ts`，宿主挂在 {@link AGENT_GATEWAY_PATH}）：换发令牌、模型代理（注入真实 key）、
 *   画布工具执行（服务端的 `tools.ts` + 宿主的 direct connection）、事件上报、改动通知。
 *   **每次调用都按这一轮的 `authorize(capability)` 实时判权，不信令牌里的 scope**（docs/22 §2 第 4 条）。
 *
 * ## 一轮的调用顺序（全部 `POST`，JSON，除了换令牌都带 `Authorization: Bearer <run 短令牌>`）
 *
 * 1. `/sts/token` `{ grantType: 'bootstrap', bootstrapToken }` → run 短令牌（bootstrap token 兑换一次即废）；
 * 2. `/run/input` → {@link RunnerInput}：系统提示、这一轮的提示词（跨轮差异 + 展开提及之后的用户消息）、
 *    模型上下文、这一轮提供 / 一开始就加载的技能（runner 按同一份注册表展开成工具）、模型描述（不含地址和 key）；
 * 3. 跑 pi：模型请求走 `/llm/*`（OpenAI / Anthropic 兼容的透传代理）；画布工具走 `/canvas/tool`；
 *    pi 的事件裁成 {@link RunnerEvent} 分批 `/events` 上报（服务端经 `events.ts` 映射成 AG-UI —— 映射只在服务端）；
 *    **一批工具调用结束时**（`turn_end` 且这一批调过工具）先把事件冲完，再 `/canvas/changes` 取别人的改动通知，
 *    有就 `steer` 进去（docs/20 §3.10.2 的插入时机，规则在 runner 里执行）；
 * 4. 事件冲完后 `/run/finish`，然后进程退出。
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
export const RUNNER_PROTOCOL_VERSION = 3

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
  /** 模型代理的前缀：runner 的模型 `baseUrl` = 网关地址 + 它；之后的路径原样转给真实上游 */
  llm: '/llm',
} as const

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
 * 交给 runner 的模型描述：pi 的 `Model` 去掉 `baseUrl`（真实上游地址只在网关）和 `headers`（可能带凭据，由网关注入）。
 * runner 把 `baseUrl` 换成网关的模型代理。
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

export interface ToolCallRequest {
  toolCallId: string
  name: string
  args: unknown
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
       * runner 把它原样交给 pi；这一批全是它时循环提前结束，runner 并入新工具后 `continue()`（docs/23 §3.3）
       */
      terminate?: boolean
    }
  /** 工具报错 / 参数不对 / 判权没过 / 超过上限：`message` 原样回给模型 */
  | { isError: true; message: string }

// —— 别人的改动（下行） ——

/**
 * `/canvas/changes` 的回复：服务端先把合并窗口里攒着的冲掉，排着的通知并成一条（docs/20 §3.10.2）。
 * runner 拿 `text` 作为一条用户消息 `steer` 进去；pi 把它放进上下文时，上报的 `message_end` 带上 `steerId = id`，
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
export type RunnerEvent =
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
  /** 一批（一次模型回复 + 它的工具调用）结束；服务端按它数步数 */
  | { type: 'turn_end'; toolResultCount: number }

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

/** 网关的错误回复（模型代理用 OpenAI 的 `{ error: { message } }`，SDK 才认得出原因） */
export interface GatewayErrorBody {
  error: string
  message: string
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
  return { toolCallId: body.toolCallId, name: body.name, args: body.args }
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
