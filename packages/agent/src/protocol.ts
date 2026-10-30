import type { AgentEvent, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
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
 *   画布工具执行（服务端的 `tools.ts` + 宿主的 direct connection）、事件上报。别人改动的通知不经协议：服务端在入口 agent 的下一次
 *   模型请求时直接插进它的 transcript（docs/22 §4.3）。
 *   **每次调用都按这一轮的 `authorize(capability)` 实时判权，不信令牌里的 scope**（docs/22 §2 第 4 条）。
 *
 * ## 一轮的调用顺序（全部 `POST`，JSON，除了换令牌都带 `Authorization: Bearer <run 短令牌>`）
 *
 * 1. `/sts/token` `{ grantType: 'bootstrap', bootstrapToken }` → run 短令牌（bootstrap token 兑换一次即废）；
 * 2. `/run/input` → {@link RunnerInput}：这一轮提供的技能、入口 agent 的那一份（{@link RunnerAgentSpec}：一开始就加载 / 能加载的技能、
 *    定义的工具白名单、模型描述 —— 不含地址和 key）、可调用的 agent 目录、runner 执行的工具的调用上限、要写进工作目录的文件。**没有**系统提示、提示词和之前几轮的上下文：
 *    模型请求的上下文只用服务端的 transcript（docs/22 §4.3），runner 用不着它们；
 * 3. 跑 pi：模型请求走 `/model/<agentId>/api/stream`（pi 的 `streamProxy`：**只送空的上下文**，服务端用自己的 transcript、
 *    自己解析的模型、参数和 key 调上游，以 SSE 下发 `ProxyAssistantMessageEvent`，docs/22 §4.3）；画布工具走 `/canvas/tool`；
 *    工具的开始 / 结束裁成 {@link RunnerEvent} 分批 `/events` 上报 —— 只剩服务端看不见的那部分：runner 执行的 / pi 就地拦下的调用
 *    什么时候走到、runner 执行的工具的结果（前端看到的 AG-UI 事件由服务端从自己的模型流、执行记录、transcript 合成，映射只在 `events.ts`）。
 *    每次画布工具调用、每次模型请求之前先把攒着的事件冲完（服务端在下一次请求时补齐上一批的结果，要先看到它们）；
 * 4. 事件冲完后 `/run/finish`，然后进程退出。
 *
 * ## 被调用的 agent（docs/20 §3.10.11、docs/26 §3.5）
 *
 * 调用方的 `run_agent` 在 runner 里执行：先 `/agent/task/start` 登记（服务端分配被调用的 agent id、判调用深度与上限、转交占用、
 * 展开提及、按**被调用的 agent 自己的定义**定好它的系统提示、工具白名单、模型和一开始加载的技能），runner 在**同一个进程**里再建一个 pi `Agent` 跑它，
 * 做完 `/agent/task/finish` 交回（服务端释放它的占用、汇总它改过的节点、拼好回给调用方的那段结果）。
 * 任何 agent 都可以是调用方（深度没到上限、白名单里有 `run_agent` 时），所以发起请求带着**调用方**的 `agentId`。
 * 被调用的 agent 的工具调用 / 事件带上它的 {@link ToolCallRequest.agentId} / `agentId`；**不带 = 入口 agent**。
 * agent id 只用来在这一轮内部区分是谁（占用、「改过」、步数、事件归到哪个任务）—— 它们都还是这一轮的令牌，
 * 服务端只认自己分配过、还没结束的 id；调用深度到了上限的 agent 发起的任务服务端拒绝。
 *
 * 中止 / 超时 / 失权不经协议通知 runner：服务端当场作废令牌、由驱动杀掉沙箱（docs/22 §5 stop），
 * 收尾帧由服务端按它自己的记录补齐。所以 runner 被杀在任何一步都是合法的结局。
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
export const RUNNER_PROTOCOL_VERSION = 9

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
  events: '/events',
  finish: '/run/finish',
  /** 调用方发起任务（docs/20 §3.10.11）：登记、判调用深度与上限、转交占用，回被调用的 agent 的输入 */
  taskStart: '/agent/task/start',
  /** 一个被调用的 agent 做完了：交回结果，服务端释放它的占用、拼好给调用方的结果 */
  taskFinish: '/agent/task/finish',
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

/**
 * 一个 agent 在 runner 里要的东西（入口 agent 的在 {@link RunnerInput.entry}，被调用的 agent 的在 {@link AgentTaskInput}），
 * 全部由服务端按**这个 agent 自己的定义**定好（docs/26 §3.6：模型、工具白名单都不继承调用方的）。
 */
export interface RunnerAgentSpec {
  /** 定义的名字（docs/26 §3.1，如 `canvas`）：只用于 runner 自己的日志 */
  name: string
  /**
   * 这个 agent 的技能（docs/23 §3.2）：`offered` = 提供给它的（Grant、部署条件、它的白名单、调用深度都满足；⊆ 这一轮的
   * {@link RunnerInput.offered}），`loaded` = 一开始就加载的（⊆ offered）。runner 按注册表把 `loaded` 展开成工具（外加平台工具 `load_skill`）；
   * 之后模型 `load_skill` 成功时，网关的回复带着新加载的技能 id，runner 再把它的工具并进来。runner 不可信：网关只执行服务端记着「已加载」的技能里的工具。
   * `offered` 里有发起任务的技能（`agents`）= 这个 agent 能调用别的 agent（深度没到上限）
   */
  skills: { loaded: AgentSkillId[]; offered: AgentSkillId[] }
  /**
   * 定义的工具白名单（docs/26 §3.3）；`null` = 全部。runner 造工具时按它滤 —— 尤其是 runner 自己执行的工具（到不了网关，
   * 服务端只能在模型那头不声明它）：白名单外的不进 pi 的工具表，模型硬调也只得到 pi 的「Tool X not found」。
   * 平台工具（`load_skill`、`request_confirmation`）不受它影响
   */
  tools: string[] | null
  /** 它的模型的元数据（docs/26 §3.4：每个 agent 用自己定义里的模型；P3 起协议带上，P4 才有多项模型表） */
  model: RunnerModel
}

/** 可调用的 agent 目录里的一项（`run_agent` 的 `agent` 参数的取值与工具描述，docs/26 §3.5） */
export interface CallableAgent {
  name: string
  description: string
}

/**
 * runner 这一轮要的东西。系统提示、提示词、之前几轮的上下文**不给**（第 7 版起）：模型请求的上下文是服务端的 transcript，
 * runner 只送空的上下文（docs/22 §4.3），它们在 runner 里没有用处，也就不必进沙箱
 */
export interface RunnerInput {
  runId: string
  /**
   * 这一轮提供的技能：**这一轮可能跑起来的全部 agent 的并**（服务端按定义与调用深度算，见 `session.ts`）。
   * runner 只拿它决定开不开工作目录（有技能要 `sandbox:exec`）；每个 agent 能加载什么看它自己的 {@link RunnerAgentSpec.skills}
   */
  offered: AgentSkillId[]
  /** 入口 agent（docs/26 §3.7：固定是 `canvas`） */
  entry: RunnerAgentSpec
  /** 可调用的 agent（`run_agent` 的取值）：runner 和服务端造同一份工具定义（schema 里的 enum、描述）用 */
  agents: CallableAgent[]
  limits: {
    /**
     * 一轮里最多几次工具调用。网关执行的工具（含 `run_agent`）由网关按全轮计数判（runner 不拦）；
     * runner 执行的工具（`run_media_command`）不经网关，只能由 runner 在执行前拦下 —— 这个数就是给它的（服务端另把它们计进同一个数）
     */
    maxToolCalls: number
  }
  /** 写进工作目录的文件（相对路径 → 内容）：提供的技能的初始化钩子给的（如 `media-exec` 的 `canvas.json`） */
  files: Record<string, string>
}

// —— 画布工具 ——

/** 入口 agent 的 agent id：不带 `agentId` 的请求 / 事件都算它的 */
export const ENTRY_AGENT_ID = 'main'

export interface ToolCallRequest {
  toolCallId: string
  name: string
  args: unknown
  /** 哪个 agent 调的（被调用的 agent 的 id，服务端在 `/agent/task/start` 里分配）；不带 = 入口 agent */
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
      /** `load_skill` 成功加载时 `loadedSkills` 是新加载的内置技能（第 9 版起是数组，docs/26 §3.8）：runner 在 pi 的 `prepareNextTurnWithContext` 里把它们的工具并进下一次请求（docs/23 §3.3） */
      details: CanvasToolDetails
    }
  /** 工具报错 / 参数不对 / 判权没过 / 超过上限 / `load_skill` 没单独调用：`message` 原样回给模型 */
  | { isError: true; message: string }

// —— 事件（上行） ——

/**
 * pi 事件裁剪后的上报形状 —— 第 7 版起**只剩工具的开始 / 结束**：服务端看不见的那部分（docs/22 §4.3 第 4 步）。
 * 用途只有三样：runner 执行的 / pi 就地拦下的调用什么时候走到（界面上的时机，内容仍取服务端那条回复）、
 * runner 执行的工具的结果（transcript 里唯一取 runner 上报的）、工具调用日志。
 * 文字增量、回复定稿、一批结束（`message_update` / `message_end` / `turn_end`）不上报：界面与模型上下文都由服务端从自己的模型流、
 * 执行记录产生，上报了也不用 —— 解析器拒收含它们的整批。
 * **图片块不上报**：`tool_execution_end` 的结果里的图片换成文字占位（`media.ts` 的 `withoutImages`），runner 换一次、服务端解析时再换一次。
 * 这只是裁剪，不是映射：pi → AG-UI 的映射**只在服务端的 `events.ts`**。
 */
export type RunnerEvent = RunnerEventBody & {
  /** 被调用的 agent 的事件带上它的 id（只用于这一轮内部的区分，见文件头「被调用的 agent」）；不带 = 入口 agent */
  agentId?: string
}

export type RunnerEventBody =
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: { content: unknown[]; details?: unknown }
      isError: boolean
    }

// —— 被调用的 agent（docs/20 §3.10.11） ——

/**
 * `/agent/task/start` 的请求：`agentId` 是**发起任务的** agent（调用方，入口 agent 是 {@link ENTRY_AGENT_ID}）；
 * 调用深度到了上限的调用方服务端拒绝。`agent` / `task` / `nodeIds` 是调用方那次 `run_agent` 的参数 —— 服务端以它自己那条回复里的为准，这里的只用来核对
 */
export interface AgentTaskStartRequest {
  agentId: string
  /** 调用方那次 `run_agent` 调用的 id：任务条目挂在它上面 */
  toolCallId: string
  /** 被调用的 agent 定义的名字 */
  agent: string
  task: string
  nodeIds: string[]
}

/**
 * 被调用的 agent 的输入（服务端按**它自己的定义**定好）：runner 拿它在同一个进程里再建一个 pi `Agent`。
 * 它的系统提示、任务说明在服务端它自己的 transcript 里，不给 runner（同 {@link RunnerInput}）
 */
export interface AgentTaskInput extends RunnerAgentSpec {
  agentId: string
  limits: {
    /** 它自己的步数上限（每个 agent 各算，同单轮上限）；到了 runner 就停下它（服务端另按模型请求数硬拦，不靠这个） */
    maxTurns: number
  }
}

export type AgentTaskStartResponse = { ok: true; agent: AgentTaskInput } | { ok: false; message: string }

/**
 * `/agent/task/finish` 的请求：只说「这个被调用的 agent 的循环结束了」。它怎么结束的（完成 / 失败 / 需要确认）、问题、回复文字
 * 全由服务端按它的 transcript 判（docs/22 §4.3 第 3 步），runner 不报
 */
export interface AgentTaskFinishRequest {
  agentId: string
}

/** `/agent/task/finish` 的回复：交给调用方的 `run_agent` 结果（服务端拼的，限长） */
export interface AgentTaskFinishResponse {
  /** 失败（或这一轮已经停了）：runner 把 `text` 作为工具错误回给调用方 */
  isError: boolean
  text: string
  /** 给人看的一句话（调用方那条工具调用的 summary） */
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
 * 模型请求开流之前的拒绝：`{ error: <原因> }` + 状态码（400 / 401 / 403 / 404 / 409 / 413 / 503）。
 * `streamProxy` 只认 `error` 是**字符串**（拼成 `Proxy error: …`）；开流之后的失败一律是 SSE 里的 `error` 帧
 */
export interface ModelStreamErrorBody {
  error: string
}

/**
 * pi 事件 → 上报形状；`null` = 不上报（只报工具的开始 / 结束，见 {@link RunnerEvent}）。
 */
export function runnerEventOf(event: AgentEvent): RunnerEvent | null {
  switch (event.type) {
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
    default:
      return null
  }
}

// —— 服务端对上报内容的校验（runner 在不可信区：形状不对就整批拒） ——

/** 一批最多几条事件 */
export const EVENTS_PER_BATCH = 500
const ID_MAX = 256
const NAME_MAX = 64
/** 任务说明（`run_agent` 的 `task`）的上限（服务端回给调用方时另外再截到更短） */
export const AGENT_TASK_MAX = 8000
/** `run_agent` 的 `nodeIds` 最多几个 */
export const AGENT_TASK_NODE_IDS_MAX = 20
/** agent 定义名的格式（同 `agents.ts` 的校验） */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/
/** 节点 id 的格式（同提及 `@{node:<id>}` 认的字符集） */
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const shortString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function parseEvent(raw: unknown): RunnerEvent | null {
  if (!isObject(raw)) return null
  if (raw.agentId !== undefined && !shortString(raw.agentId, ID_MAX)) return null
  const body = parseEventBody(raw)
  if (!body) return null
  return raw.agentId === undefined ? body : { ...body, agentId: raw.agentId as string }
}

/** 只认工具的开始 / 结束；别的类型（含第 6 版的 `message_update` / `message_end` / `turn_end`）一律不认 → 整批拒 */
function parseEventBody(raw: Record<string, unknown>): RunnerEventBody | null {
  switch (raw.type) {
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

/** `/agent/task/start` 的请求体：agent 名合法、说明非空、节点 id 合法且不多于上限（去重） */
export function parseAgentTaskStartRequest(body: unknown): AgentTaskStartRequest | null {
  if (!isObject(body) || !shortString(body.agentId, ID_MAX) || !shortString(body.toolCallId, ID_MAX)) return null
  if (typeof body.agent !== 'string' || !AGENT_NAME_PATTERN.test(body.agent)) return null
  if (typeof body.task !== 'string' || !body.task.trim() || body.task.length > AGENT_TASK_MAX) return null
  const raw = body.nodeIds ?? []
  if (!Array.isArray(raw) || raw.length > AGENT_TASK_NODE_IDS_MAX) return null
  if (!raw.every((id) => typeof id === 'string' && NODE_ID_PATTERN.test(id))) return null
  return {
    agentId: body.agentId,
    toolCallId: body.toolCallId,
    agent: body.agent,
    task: body.task.trim(),
    nodeIds: [...new Set(raw as string[])],
  }
}

/** `/agent/task/finish` 的请求体：只取 `agentId`（别的字段一概不看） */
export function parseAgentTaskFinishRequest(body: unknown): AgentTaskFinishRequest | null {
  if (!isObject(body) || !shortString(body.agentId, ID_MAX)) return null
  return { agentId: body.agentId }
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

/**
 * 模型请求（`streamProxy` 的请求体 `{ model, context, options }`）：**只校验是个 JSON 对象**（大小另由网关限），内容一个字段都不用 ——
 * 上下文是服务端的 transcript，模型、参数、请求头由服务端定（docs/22 §4.3）。runner 只送空的上下文；送了非空的也照样不看
 */
export function isModelStreamRequest(body: unknown): boolean {
  return isObject(body)
}
