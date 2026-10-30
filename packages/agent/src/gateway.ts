import type { ProxyAssistantMessageEvent } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai'
import { isRunAuthorityError } from './authority.ts'
import { BUILD_ID, buildsDiffer } from './build-id.ts'
import { AGENT_CLIENT_IDENTITY, outputTokenLimit, proxyFramesOf, streamUpstream, type ModelTurnResult } from './model-stream.ts'
import {
  AGENT_GATEWAY_PATH,
  GATEWAY_ROUTES,
  modelStreamAgentOf,
  PROTOCOL_MISMATCH_ERROR,
  PROTOCOL_MISMATCH_STATUS,
  RUNNER_PROTOCOL_VERSION,
  isModelStreamRequest,
  parseAgentTaskStartRequest,
  parseEventsRequest,
  parseFinishRequest,
  parseAgentTaskFinishRequest,
  parseStsTokenRequest,
  parseToolCallRequest,
  type AgentTaskStartRequest,
  type AgentTaskStartResponse,
  type FinishRequest,
  type ModelStreamErrorBody,
  type ProtocolMismatchBody,
  type RunnerEvent,
  type RunnerInput,
  type StsTokenResponse,
  type AgentTaskFinishRequest,
  type AgentTaskFinishResponse,
  type ToolCallRequest,
  type ToolCallResponse,
} from './protocol.ts'
import {
  bearerOf,
  BOOTSTRAP_TOKEN_TTL_MS,
  createBootstrapToken,
  hashBootstrapToken,
  RUN_TOKEN_TTL_MS,
  runTokenClaims,
  signRunToken,
  verifyRunToken,
} from './token.ts'

/**
 * 网关：沙箱里的 runner 够得着服务端的**唯一**入口（docs/22 §4）。宿主把 {@link AgentGateway.handle}
 * 挂在 `AGENT_GATEWAY_PATH` 下（apps/server 的 `routes/agent-gateway.ts`，**在会话登录那道闸之外**：
 * 这里只认 run 短令牌，浏览器的会话 cookie 在这里一文不值）。
 *
 * ## 这里管什么、不管什么
 *
 * - 管：STS（bootstrap token → run 短令牌、续期）、令牌校验（验签 + 这一轮还在 + Grant id 对得上）、
 *   请求体的大小与形状、`/events` 的批次顺序、服务端调用模型（真实 key 只在这里，见下）；
 * - 不管：判权与执行。画布工具、被调用的 agent 的发起与交回、事件、收尾交给这一轮登记的 {@link GatewayRunHandlers}
 *   （编排层 `session.ts` 实现，判权走这一轮的 `authorize`，执行走服务端的 `tools.ts`）。
 *   **令牌里的 scope 从来不读**：每一次调用都按 Grant 实时判（docs/22 §2 第 4 条）。
 *
 * ## 令牌什么时候失效
 *
 * 过期、签名不对、这一轮不在本进程（已结束 / 别的副本上 / 从没有过）、Grant id 对不上、
 * 这一轮已被 {@link GatewayRun.close}（叫停 / 收尾）—— 一律 401，原因只记服务端日志。
 * 所以「中止 / 超时 / 失权」时编排层先 `close()` 再杀沙箱：杀之前那几毫秒里漏网的请求也进不来。
 *
 * ## 服务端调用模型（docs/22 §4.3）
 *
 * runner 的 `streamFn` 是 pi 的 `streamProxy`：`POST /model/<agentId>/api/stream`，`Authorization: Bearer <run 短令牌>`，
 * 请求体 `{ model, context, options }`：**一个字段都不用**（只校验大小、是个 JSON 对象；runner 只送空的上下文，上限随之是 {@link MODEL_BODY_LIMIT}）。
 * 上下文是编排层给的、服务端维护的 transcript（{@link ModelRequestDecision} 的 `context`，docs/22 §4.3 第 2 步）；
 * 模型是服务端解析的那个，`maxTokens`（有上限）、重试、`sessionId`、`identity`、请求头都由服务端定，runner 送的 `model` / `options` 一概不看。
 * 服务端带真实 key 用 pi-ai 的 `streamSimple` 调上游（`model-stream.ts`），把事件流换成 `ProxyAssistantMessageEvent` 以 SSE 下发。
 *
 * - 开流之前的拒绝回 `{ error: <字符串> }` + 状态码（`streamProxy` 只认字符串 `error`）；开流之后的失败都是 `error` 帧；
 * - **一次请求 = 一步**、同一个 agent 同时只能有一个在途请求：由这一轮的 {@link GatewayRunHandlers.modelRequest} 判（编排层按 agent 计数）；
 * - 上游的信号 = 这一轮的 `signal` ∪ 这次 HTTP 请求的 `signal` ∪ 掐断（参数过长、runner 断开）；被叫停时补一帧 `error { reason: 'aborted' }` 再正常结束
 *   （中断是预期内的结局，不让它变成 HTTP 层的流错误）；
 * - 在途从请求进来算到服务端的流结束（或断开）为止，空闲上限据此判断；结束时打一行用量日志；累计进运行日志的是同一个数，经 `release` 交回的定稿里的 `usage`（docs/22 §4.3 第 5 步）。
 * 支持的线协议见 `model-stream.ts` 的 `SERVED_MODEL_APIS`；其余的宿主据此把 agent 标成未启用。
 */

/** 叫停时在途的模型请求怎么收尾：`error { reason: 'aborted' }` 带上这句 */
const STOPPED_MESSAGE = '这一轮已经停止，模型请求已取消'

/** 请求体上限：事件一批、工具参数都远到不了 */
const BODY_LIMIT = 4 * 1024 * 1024
/**
 * 模型请求的请求体上限：runner 只送空的上下文（docs/22 §4.3 第 4 步），剩下的是模型描述和 pi 的几个选项，几 KB；
 * 送整段上下文（老习惯，或想塞东西进来）的超过就 413 —— 内容本来就一个字都不用
 */
export const MODEL_BODY_LIMIT = 64 * 1024

/** 上游请求重试（pi-ai 的 `retryProviderRequest` 只重试建立请求那一段，退避可被中止打断）：默认同 SDK */
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000

/**
 * 编排层对一次模型请求的判定（{@link GatewayRunHandlers.modelRequest}）：
 * - `stream`：放行，用 `context`（服务端的 transcript，runner 送的上下文不用）调上游；终止帧发给 runner **之前**调一次 `release`，
 *   交回这条回复的定稿（编排层记进 transcript、释放这个 agent 的在途名额 —— runner 拿到终止帧就可能来执行工具；
 *   定稿的 `usage` 就是终止帧的 / 用量日志里的那个数，编排层据此累计这一轮的用量）；**开流了就一定调且只调一次**
 *   （上游抛错 / 没给终止帧时是补的那条出错回复，用量为 0），编排层收尾时要等它；拿不到定稿（不该发生）给 null。`frame`：终止帧之前的每一帧，写给 runner **之前**交给编排层一份
 *   （界面上的文字流由服务端从这里产生，docs/22 §4.3 第 3 步；编排层抛错不影响下发）；
 * - `refuse`：开流之前拒绝（`{ error }` + 状态码），不调上游；
 * - `fail`：开流、只发一帧 `error`（如被调用的 agent 步数用完），不调上游。
 */
export type ModelRequestDecision =
  | {
      kind: 'stream'
      sessionId: string
      step: number
      context: TranscriptContext
      release(result: ModelTurnResult | null): void
      frame?(frame: ProxyAssistantMessageEvent): void
    }
  | { kind: 'refuse'; status: number; message: string }
  | { kind: 'fail'; message: string }

export interface GatewayRunHandlers {
  input(): Promise<RunnerInput>
  tool(request: ToolCallRequest): Promise<ToolCallResponse>
  /** 发起任务（docs/20 §3.10.11）：发起者、上限、转交占用都由编排层判；拒绝是 `{ ok: false }`，不是 HTTP 错误 */
  delegate(request: AgentTaskStartRequest): Promise<AgentTaskStartResponse>
  /** 一个被调用的 agent 做完了：编排层释放它的占用、拼好给调用方的结果 */
  agentFinish(request: AgentTaskFinishRequest): Promise<AgentTaskFinishResponse>
  /** 同步处理一批事件（批内按顺序；批与批之间网关保证不并发、不乱序） */
  events(events: RunnerEvent[]): void
  finish(request: FinishRequest): void
  /**
   * runner 的协议版本和服务端不一致（bootstrap 兑换时被拒；`runnerVersion` 为 null = 没带，老镜像）。
   * 编排层据此让这一轮以 `runner_protocol_mismatch` 收尾，不再把它当成 runner 崩溃
   */
  protocolMismatch(info: { runnerVersion: number | null; serverVersion: number }): void
  /** 每次模型请求之前：判 `llm:invoke`，不过就抛 RunAuthorityError（revoked / expired 时这一轮已被叫停） */
  authorizeLlm(): Promise<void>
  /**
   * 判过 `llm:invoke` 之后、调上游之前：这个 agent 能不能再请求一次（服务端分配过、还没结束；没有在途的；没超步数）。
   * 一次请求 = 一步（docs/22 §4.3「步数与请求上限」），计数在这里
   */
  modelRequest(agentId: string): ModelRequestDecision | Promise<ModelRequestDecision>
  /**
   * 这一轮的一次模型请求在开流之前被拒了（任何原因：形状、大小、`llm:invoke`、编排层的判定）：`message` 是回给 runner 的那句。
   * 编排层据此判这个 agent 为什么没走完（服务端自己的说法，不用 runner 拿这句话拼出的报错，docs/22 §4.3 第 3 步）
   */
  modelRefused?(agentId: string, status: number, message: string): void
  /** 续期之前：Grant 还活着才续（同样抛 RunAuthorityError） */
  authorizeRenewal(): Promise<void>
}

export interface GatewayRegistration {
  runId: string
  /** 发起人（令牌的 `sub`） */
  userId: string
  grantId: string
  /** 给人看的 scope 串，写进令牌（网关不读它） */
  scope: string
  /** 这一轮被叫停 / 结束时 abort：在途的上游模型请求随之掐断（`runAbort`） */
  signal: AbortSignal
  handlers: GatewayRunHandlers
}

export interface GatewayRun {
  /** 一次性 bootstrap token 的原文：交给驱动注入沙箱，网关自己只留哈希 */
  readonly bootstrapToken: string
  /** 作废这一轮：之后它的任何令牌、没兑换的 bootstrap token 一律 401。幂等 */
  close(): void
  /**
   * 这一轮在网关上的活动（docs/20 §3.10.8「空闲上限」）：`inflight` = 还没处理完的请求数（模型请求算到服务端的流结束为止，
   * 长时间流式输出不算空闲）；`lastActivityAt` = 最近一次请求开始或结束的时刻，还没来过任何请求（没兑换 bootstrap）为 null。
   */
  activity(): { inflight: number; lastActivityAt: number | null }
}

/** 真实的上游模型（地址 + key 只在这里） */
export interface ModelUpstream {
  model: Model<Api>
  apiKey: string
}

export interface AgentGatewayOptions {
  /** 签 run 短令牌的密钥（只在服务端） */
  secret: string | Uint8Array
  /** null = 没配模型（模型请求一律 503） */
  upstream: ModelUpstream | null
  /** 打上游用的 fetch（pi-ai 的 `ProviderRequestOptions.fetch`）；不给用 SDK 默认的全局 fetch（测试注入脚本化的上游） */
  fetch?: typeof fetch
  /** 输出 token 的上限（`AGENT_MAX_OUTPUT_TOKENS`）；实际取 min(模型的 maxTokens, 它)，不给按 16384 */
  maxOutputTokens?: number
  /** 上游请求的重试次数 / 服务端要求的最长等待；不给 2 次 / 60 秒（同 SDK） */
  maxRetries?: number
  maxRetryDelayMs?: number
  /** 一次工具调用的参数累计超过这么多字就掐断（#9265）；只测试注入，不给用 `MAX_TOOL_ARGUMENT_CHARS` */
  maxToolArgumentChars?: number
  now?: () => number
  /** 服务端的构建 id（`build-id.ts`）；只测试注入，不给用编译期注入的那个 */
  buildId?: string
  tokenTtlMs?: number
  bootstrapTtlMs?: number
}

export interface AgentGateway {
  /** 宿主的路由把整个请求交进来（路径里带不带 `AGENT_GATEWAY_PATH` 前缀都认） */
  handle(request: Request): Promise<Response>
  /** 登记一轮，拿到它的一次性 bootstrap token */
  open(registration: GatewayRegistration): GatewayRun
}

interface Entry {
  registration: GatewayRegistration
  bootstrapHash: string
  bootstrapExpiresAt: number
  redeemed: boolean
  closed: boolean
  /** 下一批事件的序号 */
  nextSeq: number
  /** 在途请求数（{@link GatewayRun.activity}） */
  inflight: number
  /** 最近一次请求开始 / 结束的时刻；还没来过请求为 null */
  lastActivityAt: number | null
}

class GatewayHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const UNAUTHORIZED_MESSAGE = '令牌无效、已过期，或这一轮已经结束'

function errorResponse(status: number, message: string) {
  const error = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'bad_request'
  return json({ error, message }, status)
}

/** 模型请求开流之前的拒绝：`streamProxy` 只认字符串的 `error`（拼成 `Proxy error: …`） */
function modelError(status: number, message: string) {
  const body: ModelStreamErrorBody = { error: message }
  return json(body, status)
}

const sseFrame = (frame: ProxyAssistantMessageEvent) => `data: ${JSON.stringify(frame)}\n\n`

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }

const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** 读请求体，超过上限就拒（不信 content-length，边读边数） */
async function readText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > limit) throw new GatewayHttpError(413, '请求体太大')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new GatewayHttpError(413, '请求体太大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(request: Request, limit = BODY_LIMIT): Promise<unknown> {
  const text = await readText(request, limit)
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GatewayHttpError(400, '请求体不是合法的 JSON')
  }
}

/** 路径去掉挂载前缀：宿主可能交进来完整路径，也可能已经截掉 */
function routeOf(pathname: string): string {
  return pathname.startsWith(`${AGENT_GATEWAY_PATH}/`) ? pathname.slice(AGENT_GATEWAY_PATH.length) : pathname
}

export function createAgentGateway(options: AgentGatewayOptions): AgentGateway {
  const now = options.now ?? Date.now
  const serverBuildId = options.buildId ?? BUILD_ID
  const tokenTtlMs = options.tokenTtlMs ?? RUN_TOKEN_TTL_MS
  const bootstrapTtlMs = options.bootstrapTtlMs ?? BOOTSTRAP_TOKEN_TTL_MS
  /** runId → 这一轮在网关上的登记（进程内存：令牌只在发起它的那个副本上有效） */
  const runs = new Map<string, Entry>()
  /** bootstrap token 的哈希 → runId（兑换即删） */
  const bootstraps = new Map<string, string>()

  function issue(entry: Entry): StsTokenResponse {
    const at = now()
    const { runId, userId, grantId, scope } = entry.registration
    const claims = runTokenClaims({ runId, userId, grantId, scope, now: at, ttlMs: tokenTtlMs })
    return { token: signRunToken(claims, options.secret), expiresAt: claims.exp * 1000 }
  }

  /** 令牌 → 这一轮；任何一处不对都是 401（原因进日志，不回给调用方） */
  function authenticate(token: string | null): Entry {
    if (!token) throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    const verdict = verifyRunToken(token, options.secret, now())
    if (!verdict.ok) {
      console.warn(`[agent-gateway] 拒绝令牌：${verdict.reason}`)
      throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    }
    const entry = runs.get(verdict.runId)
    if (!entry || entry.closed) {
      console.warn(`[agent-gateway] run=${verdict.runId} 拒绝令牌：这一轮不在本进程或已结束`)
      throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    }
    if (entry.registration.grantId !== verdict.claims.grant_id || entry.registration.userId !== verdict.userId) {
      console.warn(`[agent-gateway] run=${verdict.runId} 拒绝令牌：Grant / 发起人对不上`)
      throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    }
    return entry
  }

  /** 一个请求开始了：在途 +1；返回「结束了」（幂等），在途 -1 —— 空闲上限据此判断 */
  function begin(entry: Entry): () => void {
    entry.inflight += 1
    entry.lastActivityAt = now()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      entry.inflight -= 1
      entry.lastActivityAt = now()
    }
  }

  /** 判权失败 → 状态码：失效（这一轮已被叫停）401，不在授予范围 / 暂时判不了 403 */
  function authorityStatus(err: unknown): number | null {
    if (!isRunAuthorityError(err)) return null
    return err.kind === 'denied' ? 403 : 401
  }

  async function token(request: Request): Promise<Response> {
    const body = parseStsTokenRequest(await readJson(request))
    if (!body) throw new GatewayHttpError(400, '换令牌的请求不对')
    if (body.grantType === 'bootstrap') {
      const hash = hashBootstrapToken(body.bootstrapToken)
      const runId = bootstraps.get(hash)
      // 兑换一次即废：先删，再判其余条件（失败的兑换同样作废它）
      bootstraps.delete(hash)
      const entry = runId ? runs.get(runId) : undefined
      if (!entry || entry.closed || entry.redeemed || entry.bootstrapHash !== hash || now() > entry.bootstrapExpiresAt) {
        console.warn(`[agent-gateway] 拒绝 bootstrap token${runId ? `（run=${runId}）` : ''}：已兑换、已过期或不存在`)
        throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
      }
      // 协议版本是硬校验：放在令牌本身有效之后判（没拿到有效 bootstrap 的人看不到版本号）；
      // bootstrap 上面已经删了，所以不一致的这一次同样作废它
      if (body.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
        const mismatch: ProtocolMismatchBody = {
          error: PROTOCOL_MISMATCH_ERROR,
          message: `runner 的协议版本 ${body.protocolVersion ?? '未声明'} 和服务端的 ${RUNNER_PROTOCOL_VERSION} 不一致，请重建沙箱镜像`,
          runnerVersion: body.protocolVersion,
          serverVersion: RUNNER_PROTOCOL_VERSION,
        }
        console.warn(
          `[agent-gateway] run=${entry.registration.runId} 拒绝 bootstrap token：runner 协议版本 ${body.protocolVersion ?? '未声明'}，服务端 ${RUNNER_PROTOCOL_VERSION}`,
        )
        entry.registration.handlers.protocolMismatch({ runnerVersion: body.protocolVersion, serverVersion: RUNNER_PROTOCOL_VERSION })
        return json(mismatch, PROTOCOL_MISMATCH_STATUS)
      }
      // 软提示：协议兼容但不是同一次构建（镜像可能旧了），只记一条日志
      if (buildsDiffer(serverBuildId, body.buildId)) {
        console.warn(
          `[agent-gateway] run=${entry.registration.runId} 沙箱镜像和服务端不是同一次构建（runner ${body.buildId}，服务端 ${serverBuildId}），协议版本一致，继续`,
        )
      }
      entry.redeemed = true
      begin(entry)()
      return json(issue(entry))
    }
    const entry = authenticate(bearerOf(request.headers))
    const end = begin(entry)
    try {
      await entry.registration.handlers.authorizeRenewal()
    } catch (err) {
      const status = authorityStatus(err)
      if (status === null) throw err
      throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    } finally {
      end()
    }
    if (entry.closed) throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
    return json(issue(entry))
  }

  /** `/model/<agentId>/api/stream`：判权、判这个 agent 能不能请求，然后服务端调上游、SSE 下发 */
  async function modelStream(request: Request, agentId: string): Promise<Response> {
    const upstream = options.upstream
    if (!upstream) return modelError(503, '服务端没有配置模型')
    let entry: Entry
    try {
      entry = authenticate(bearerOf(request.headers))
    } catch (err) {
      if (err instanceof GatewayHttpError) return modelError(err.status, err.message)
      throw err
    }
    // 在途到服务端的流结束为止（长时间流式输出不算空闲）；开流之前的拒绝在 finally 里结束
    const end = begin(entry)
    let handedOff = false
    const refused = (status: number, message: string) => {
      try {
        entry.registration.handlers.modelRefused?.(agentId, status, message)
      } catch (err) {
        console.warn(`[agent-gateway] run=${entry.registration.runId} agent=${agentId} 编排层记录模型请求被拒失败`, err)
      }
      return modelError(status, message)
    }
    try {
      let body: unknown
      try {
        body = await readJson(request, MODEL_BODY_LIMIT)
      } catch (err) {
        if (err instanceof GatewayHttpError) return refused(err.status, err.message)
        throw err
      }
      // 只认得是个 JSON 对象：内容（模型、上下文、选项）一个字段都不用
      if (!isModelStreamRequest(body)) return refused(400, '模型请求的形状不对')
      try {
        await entry.registration.handlers.authorizeLlm()
      } catch (err) {
        const status = authorityStatus(err)
        if (status === null) throw err
        return refused(status, (err as Error).message)
      }
      if (entry.closed) return refused(401, UNAUTHORIZED_MESSAGE)
      const decision = await entry.registration.handlers.modelRequest(agentId)
      if (decision.kind === 'refuse') return refused(decision.status, decision.message)
      if (decision.kind === 'fail') {
        // 不调上游，只发一帧 error（streamProxy 据此给 pi 一条出错的 assistant 消息）
        return new Response(sseFrame({ type: 'error', reason: 'error', errorMessage: decision.message, usage: ZERO_USAGE }), {
          status: 200,
          headers: SSE_HEADERS,
        })
      }
      if (entry.closed) {
        decision.release(null)
        return refused(401, UNAUTHORIZED_MESSAGE)
      }
      handedOff = true
      // 上下文用编排层给的服务端 transcript（docs/22 §4.3 第 2 步），请求体里的不看
      return serveModel(request, entry, upstream, agentId, decision, end)
    } finally {
      if (!handedOff) end()
    }
  }

  function serveModel(
    request: Request,
    entry: Entry,
    upstream: ModelUpstream,
    agentId: string,
    decision: Extract<ModelRequestDecision, { kind: 'stream' }>,
    end: () => void,
  ): Response {
    const { runId } = entry.registration
    /** 服务端自己掐断（参数过长、runner 断开） */
    const cutoff = new AbortController()
    const signal = AbortSignal.any([entry.registration.signal, request.signal, cutoff.signal])
    const stopped = () => entry.closed || entry.registration.signal.aborted
    /** 交回定稿（只一次）：终止帧写出去之前 */
    let settled = false
    const settle = (result: ModelTurnResult | null) => {
      if (settled) return
      settled = true
      decision.release(result)
    }
    /** 没有定稿时（上游流抛错 / 没给终止事件）按终止帧补一条出错的回复 */
    const failedReply = (frame: ProxyAssistantMessageEvent): ModelTurnResult => ({
      message: {
        role: 'assistant',
        content: [],
        api: upstream.model.api,
        provider: upstream.model.provider,
        model: upstream.model.id,
        usage: frame.type === 'error' ? frame.usage : ZERO_USAGE,
        stopReason: frame.type === 'error' ? frame.reason : 'error',
        ...(frame.type === 'error' && frame.errorMessage !== undefined ? { errorMessage: frame.errorMessage } : {}),
        timestamp: now(),
      },
      cut: new Map(),
    })
    let ended = false
    const finish = (terminal: ProxyAssistantMessageEvent | null) => {
      if (ended) return
      ended = true
      settle(null)
      end()
      const usage = terminal && (terminal.type === 'done' || terminal.type === 'error') ? terminal.usage : ZERO_USAGE
      const outcome = terminal?.type === 'done' ? terminal.reason : terminal?.type === 'error' ? terminal.reason : 'disconnected'
      // 用量是服务端拿到的，可信（runner 报的不看）；累计落库的是 release 交回的定稿里的同一个数（docs/22 §4.3「用量」）
      console.info(
        `[agent-gateway] run=${runId} agent=${agentId} step=${decision.step} 模型请求结束（${outcome}）：` +
          `输入 ${usage.input} / 输出 ${usage.output} / 缓存读 ${usage.cacheRead} / 缓存写 ${usage.cacheWrite} token，费用 ${usage.cost.total}`,
      )
    }

    let cancelled = false
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: ProxyAssistantMessageEvent) => {
          if (cancelled) return
          try {
            controller.enqueue(encoder.encode(sseFrame(frame)))
          } catch {
            cancelled = true
          }
        }
        void (async () => {
          let terminal: ProxyAssistantMessageEvent | null = null
          let reported: ModelTurnResult | null = null
          try {
            const stream = streamUpstream(upstream.model, decision.context, {
              apiKey: upstream.apiKey,
              signal,
              maxTokens: outputTokenLimit(upstream.model, options.maxOutputTokens),
              sessionId: decision.sessionId,
              identity: AGENT_CLIENT_IDENTITY,
              maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
              maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
              ...(options.fetch ? { fetch: options.fetch } : {}),
            })
            const frames = proxyFramesOf(stream, {
              ...(options.maxToolArgumentChars !== undefined ? { maxToolArgumentChars: options.maxToolArgumentChars } : {}),
              onArgumentsTooLong(name, chars) {
                console.warn(`[agent-gateway] run=${runId} agent=${agentId} 工具 ${name || '?'} 的参数已累计 ${chars} 字，掐断这次模型请求`)
                cutoff.abort()
              },
              onResult(result) {
                reported = result
              },
            })
            for await (const frame of frames) {
              // 这一轮被叫停：pi-ai 以 aborted 收尾，原因换成我们的
              const out: ProxyAssistantMessageEvent =
                frame.type === 'error' && frame.reason === 'aborted' && stopped() ? { ...frame, errorMessage: STOPPED_MESSAGE } : frame
              if (out.type === 'done' || out.type === 'error') {
                terminal = out
                // 先记进 transcript，再让 runner 看到终止帧
                settle((reported as ModelTurnResult | null) ?? failedReply(out))
              } else if (decision.frame) {
                // 界面上的文字流从服务端自己的流来（不信 runner 上报的）：先交给编排层，再下发
                try {
                  decision.frame(out)
                } catch (err) {
                  console.warn(`[agent-gateway] run=${runId} agent=${agentId} 编排层处理模型流的一帧失败`, err)
                }
              }
              write(out)
            }
          } catch (err) {
            console.warn(`[agent-gateway] run=${runId} agent=${agentId} 模型请求失败`, err)
            terminal = {
              type: 'error',
              reason: signal.aborted ? 'aborted' : 'error',
              errorMessage: stopped() ? STOPPED_MESSAGE : `模型请求失败：${err instanceof Error ? err.message : String(err)}`,
              usage: ZERO_USAGE,
            }
            settle(failedReply(terminal))
            write(terminal)
          }
          if (!terminal) {
            // pi-ai 没给终止帧就结束了（不该发生）：补一帧，别让 runner 等一个不会来的结果
            terminal = { type: 'error', reason: 'error', errorMessage: '模型的响应流没有正常结束', usage: ZERO_USAGE }
            settle(failedReply(terminal))
            write(terminal)
          }
          finish(terminal)
          if (!cancelled) {
            try {
              controller.close()
            } catch {
              // 已经被取消
            }
          }
        })()
      },
      cancel() {
        // runner 断开：掐断上游（pi-ai 以 aborted 收尾，流结束时 finish）
        cancelled = true
        cutoff.abort()
      },
    })
    return new Response(body, { status: 200, headers: SSE_HEADERS })
  }

  async function route(request: Request): Promise<Response> {
    const path = routeOf(new URL(request.url).pathname)
    if (request.method !== 'POST') return errorResponse(405, '只接受 POST')
    if (path === GATEWAY_ROUTES.model || path.startsWith(`${GATEWAY_ROUTES.model}/`)) {
      const agentId = modelStreamAgentOf(path)
      return agentId === null ? modelError(404, `网关没有 ${path}`) : modelStream(request, agentId)
    }
    if (path === GATEWAY_ROUTES.token) return token(request)

    const entry = authenticate(bearerOf(request.headers))
    const end = begin(entry)
    try {
      return await dispatch(request, path, entry)
    } finally {
      end()
    }
  }

  async function dispatch(request: Request, path: string, entry: Entry): Promise<Response> {
    const { handlers } = entry.registration
    switch (path) {
      case GATEWAY_ROUTES.input:
        return json(await handlers.input())
      case GATEWAY_ROUTES.tool: {
        const body = parseToolCallRequest(await readJson(request))
        if (!body) throw new GatewayHttpError(400, '工具调用的请求不对')
        return json(await handlers.tool(body))
      }
      case GATEWAY_ROUTES.delegate: {
        const body = parseAgentTaskStartRequest(await readJson(request))
        if (!body) throw new GatewayHttpError(400, '派子任务的请求不对')
        return json(await handlers.delegate(body))
      }
      case GATEWAY_ROUTES.agentFinish: {
        const body = parseAgentTaskFinishRequest(await readJson(request))
        if (!body) throw new GatewayHttpError(400, '子任务收尾的请求不对')
        return json(await handlers.agentFinish(body))
      }
      case GATEWAY_ROUTES.events: {
        const body = parseEventsRequest(await readJson(request))
        if (!body) throw new GatewayHttpError(400, '事件的形状不对')
        // 读请求体期间这一轮可能已被叫停：叫停之后的事件不收
        if (entry.closed) throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
        if (body.seq !== entry.nextSeq) throw new GatewayHttpError(409, `事件批次序号应为 ${entry.nextSeq}，收到 ${body.seq}`)
        entry.nextSeq += 1
        handlers.events(body.events)
        return json({ ok: true })
      }
      case GATEWAY_ROUTES.finish: {
        const body = parseFinishRequest(await readJson(request))
        if (!body) throw new GatewayHttpError(400, '收尾的请求不对')
        if (entry.closed) throw new GatewayHttpError(401, UNAUTHORIZED_MESSAGE)
        handlers.finish(body)
        return json({ ok: true })
      }
      default:
        return errorResponse(404, `网关没有 ${path}`)
    }
  }

  return {
    async handle(request) {
      try {
        return await route(request)
      } catch (err) {
        if (err instanceof GatewayHttpError) return errorResponse(err.status, err.message)
        const status = authorityStatus(err)
        if (status !== null) return errorResponse(status, (err as Error).message)
        console.error('[agent-gateway] 处理请求失败', err)
        return errorResponse(500, err instanceof Error ? err.message : String(err))
      }
    },

    open(registration) {
      const existing = runs.get(registration.runId)
      if (existing) throw new Error(`run=${registration.runId} 已经登记过网关`)
      const { token: bootstrapToken, hash } = createBootstrapToken()
      const entry: Entry = {
        registration,
        bootstrapHash: hash,
        bootstrapExpiresAt: now() + bootstrapTtlMs,
        redeemed: false,
        closed: false,
        nextSeq: 0,
        inflight: 0,
        lastActivityAt: null,
      }
      runs.set(registration.runId, entry)
      bootstraps.set(hash, registration.runId)
      return {
        bootstrapToken,
        close() {
          if (entry.closed) return
          entry.closed = true
          bootstraps.delete(hash)
          runs.delete(registration.runId)
        },
        activity: () => ({ inflight: entry.inflight, lastActivityAt: entry.lastActivityAt }),
      }
    },
  }
}
