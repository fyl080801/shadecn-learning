import type { Api, Model } from '@mariozechner/pi-ai'
import { isRunAuthorityError } from './authority.ts'
import { BUILD_ID, buildsDiffer } from './build-id.ts'
import {
  AGENT_GATEWAY_PATH,
  GATEWAY_ROUTES,
  PROTOCOL_MISMATCH_ERROR,
  PROTOCOL_MISMATCH_STATUS,
  RUNNER_PROTOCOL_VERSION,
  parseEventsRequest,
  parseFinishRequest,
  parseStsTokenRequest,
  parseToolCallRequest,
  type CanvasChangesResponse,
  type FinishRequest,
  type ProtocolMismatchBody,
  type RunnerEvent,
  type RunnerInput,
  type StsTokenResponse,
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
 *   请求体的大小与形状、`/events` 的批次顺序、模型代理（注入真实 key、只放行这个模型的那一个接口）；
 * - 不管：判权与执行。画布工具、改动通知、事件、收尾交给这一轮登记的 {@link GatewayRunHandlers}
 *   （编排层 `session.ts` 实现，判权走这一轮的 `authorize`，执行走服务端的 `tools.ts`）。
 *   **令牌里的 scope 从来不读**：每一次调用都按 Grant 实时判（docs/22 §2 第 4 条）。
 *
 * ## 令牌什么时候失效
 *
 * 过期、签名不对、这一轮不在本进程（已结束 / 别的副本上 / 从没有过）、Grant id 对不上、
 * 这一轮已被 {@link GatewayRun.close}（叫停 / 收尾）—— 一律 401，原因只记服务端日志。
 * 所以「中止 / 超时 / 失权」时编排层先 `close()` 再杀沙箱：杀之前那几毫秒里漏网的请求也进不来。
 *
 * ## 模型代理
 *
 * runner 的模型配置是 `baseUrl = <网关>/llm`、`apiKey = run 短令牌`，用的是 pi 自带的 provider（OpenAI / Anthropic SDK）。
 * 这里把请求原样转给真实上游：换掉鉴权头（注入真实 key）、去掉逐跳头、校验请求体里的 `model` 就是配置的那个，
 * 响应流式透传；这一轮被叫停时在途的上游请求随之掐断。每次请求之前判 `llm:invoke`。
 * 支持的线协议见 {@link PROXIED_MODEL_APIS}（按协议决定放行哪个路径、怎么注入 key）；
 * 其余协议（Bedrock 的 SigV4、Vertex 的 ADC、Google 的 key 头…）这一期不支持，宿主据此把 agent 标成未启用。
 */

/** 每个线协议放行的上游路径（相对模型的 `baseUrl`）和 key 的注入方式 */
const LLM_PROXY: Record<string, { paths: readonly string[]; auth: 'bearer' | 'x-api-key' }> = {
  'openai-completions': { paths: ['/chat/completions'], auth: 'bearer' },
  'openai-responses': { paths: ['/responses'], auth: 'bearer' },
  'anthropic-messages': { paths: ['/v1/messages'], auth: 'x-api-key' },
}

/** 模型代理支持的线协议 */
export const PROXIED_MODEL_APIS = Object.keys(LLM_PROXY)

export function isProxiedModelApi(api: string): boolean {
  return Object.hasOwn(LLM_PROXY, api)
}

/** 叫停时在途的模型流怎么收尾：按协议发一帧错误再正常结束（SDK 认得出是失败，而不是一段被截断的「成功」） */
const STOPPED_MESSAGE = '这一轮已经停止，模型请求已取消'
function stoppedFrame(api: string): string {
  const message = JSON.stringify(STOPPED_MESSAGE)
  return api === 'anthropic-messages'
    ? `event: error\ndata: {"type":"error","error":{"type":"api_error","message":${message}}}\n\n`
    : `data: {"error":{"message":${message},"type":"agent_gateway_error"}}\n\n`
}

/**
 * 上游的响应体原样转出去；这一轮被叫停（或 runner 断开）导致上游流中断时，补一帧协议内的错误再正常结束 ——
 * 不让中断变成 HTTP 层的流错误（那会被当成服务端故障记一条 error 日志，而这是预期内的结局）。
 * 上游自己出错（不是我们叫停的）照样按流错误抛出去。
 */
function guardedBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, api: string): ReadableStream<Uint8Array> | null {
  if (!body) return null
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        if (!signal.aborted) {
          controller.error(err)
          return
        }
        controller.enqueue(new TextEncoder().encode(stoppedFrame(api)))
        controller.close()
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

/** 包一层响应流：读完、出错、被取消时调一次 `onEnd`（模型请求的「在途」算到这里） */
function endsWith(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          onEnd()
          controller.close()
        } else controller.enqueue(value)
      } catch (err) {
        onEnd()
        controller.error(err)
      }
    },
    cancel(reason) {
      onEnd()
      return reader.cancel(reason)
    },
  })
}

/** 请求体上限：事件一批、工具参数都远到不了；模型请求是整段上下文（120 条消息 × 工具结果）给足余量 */
const BODY_LIMIT = 4 * 1024 * 1024
const LLM_BODY_LIMIT = 32 * 1024 * 1024

/** 不转发给上游的请求头：逐跳头、凭据、浏览器那套、压缩（让 fetch 自己协商并解压） */
const DROP_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'upgrade',
  'accept-encoding',
  'forwarded',
  'origin',
  'referer',
])
/** 不回给 runner 的响应头：fetch 已经解压过了，长度和编码都不再对 */
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'])

export interface GatewayRunHandlers {
  input(): Promise<RunnerInput>
  tool(request: ToolCallRequest): Promise<ToolCallResponse>
  changes(): Promise<CanvasChangesResponse>
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
  /** 这一轮被叫停 / 结束时 abort：在途的上游模型请求随之掐断 */
  signal: AbortSignal
  handlers: GatewayRunHandlers
}

export interface GatewayRun {
  /** 一次性 bootstrap token 的原文：交给驱动注入沙箱，网关自己只留哈希 */
  readonly bootstrapToken: string
  /** 作废这一轮：之后它的任何令牌、没兑换的 bootstrap token 一律 401。幂等 */
  close(): void
  /**
   * 这一轮在网关上的活动（docs/20 §3.10.8「空闲上限」）：`inflight` = 还没处理完的请求数（模型请求算到响应流结束为止，
   * 长时间流式输出不算空闲）；`lastActivityAt` = 最近一次请求开始或结束的时刻，还没来过任何请求（没兑换 bootstrap）为 null。
   */
  activity(): { inflight: number; lastActivityAt: number | null }
}

/** 真实的上游模型（地址 + key 只在这里） */
export interface LlmUpstream {
  model: Model<Api>
  apiKey: string
}

export interface AgentGatewayOptions {
  /** 签 run 短令牌的密钥（只在服务端） */
  secret: string | Uint8Array
  /** null = 没配模型（代理一律 503） */
  upstream: LlmUpstream | null
  /** 打上游用的 fetch；不给用**调用那一刻**的 `globalThis.fetch`（测试注入脚本化的上游） */
  fetch?: typeof fetch
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

/** 模型代理的错误用 OpenAI 的形状：两家 SDK 都从 `error.message` 里取原因给 pi */
function llmError(status: number, message: string) {
  return json({ error: { message, type: 'agent_gateway_error' } }, status)
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

  async function llm(request: Request, route: string): Promise<Response> {
    const upstream = options.upstream
    if (!upstream) return llmError(503, '服务端没有配置模型')
    const proxy = LLM_PROXY[upstream.model.api]
    const rest = route.slice(GATEWAY_ROUTES.llm.length)
    if (!proxy || !proxy.paths.includes(rest)) return llmError(404, `模型代理不提供 ${rest || '/'}`)

    let entry: Entry
    try {
      entry = authenticate(bearerOf(request.headers) ?? request.headers.get('x-api-key'))
    } catch (err) {
      if (err instanceof GatewayHttpError) return llmError(err.status, err.message)
      throw err
    }

    // 在途到响应流结束为止（长时间流式输出不算空闲）；提前返回的错误在 finally 里结束
    const end = begin(entry)
    let streaming = false
    try {
      const response = await proxyLlm(request, entry, upstream, proxy, rest)
      // 只有上游的成功响应（流式输出）算到读完为止；错误响应（网关自己的、上游的）就地结束
      if (!response.ok || !response.body) return response
      streaming = true
      return new Response(endsWith(response.body, end), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      if (!streaming) end()
    }
  }

  async function proxyLlm(
    request: Request,
    entry: Entry,
    upstream: LlmUpstream,
    proxy: { paths: readonly string[]; auth: 'bearer' | 'x-api-key' },
    rest: string,
  ): Promise<Response> {
    let text: string
    try {
      text = await readText(request, LLM_BODY_LIMIT)
    } catch (err) {
      if (err instanceof GatewayHttpError) return llmError(err.status, err.message)
      throw err
    }
    let requested: unknown
    try {
      requested = (JSON.parse(text) as { model?: unknown } | null)?.model
    } catch {
      return llmError(400, '请求体不是合法的 JSON')
    }
    // 只能用服务端配置的那个模型：拿着真实 key 换个更贵的模型、或别的接口，都不行
    if (requested !== upstream.model.id) return llmError(403, '只能调用服务端配置的模型')

    try {
      await entry.registration.handlers.authorizeLlm()
    } catch (err) {
      const status = authorityStatus(err)
      if (status === null) throw err
      return llmError(status, (err as Error).message)
    }
    if (entry.closed) return llmError(401, UNAUTHORIZED_MESSAGE)

    const headers = new Headers()
    for (const [name, value] of request.headers) {
      if (!DROP_REQUEST_HEADERS.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('proxy-')) {
        headers.set(name, value)
      }
    }
    for (const [name, value] of Object.entries(upstream.model.headers ?? {})) headers.set(name, value)
    if (proxy.auth === 'x-api-key') headers.set('x-api-key', upstream.apiKey)
    else headers.set('authorization', `Bearer ${upstream.apiKey}`)

    const target = `${upstream.model.baseUrl.replace(/\/+$/, '')}${rest}${new URL(request.url).search}`
    const signal = AbortSignal.any([entry.registration.signal, request.signal])
    const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    let response: Response
    try {
      response = await fetchImpl(target, { method: 'POST', headers, body: text, signal })
    } catch (err) {
      if (signal.aborted) return llmError(499, STOPPED_MESSAGE)
      console.warn(`[agent-gateway] run=${entry.registration.runId} 上游模型请求失败`, err)
      return llmError(502, `上游模型请求失败：${err instanceof Error ? err.message : String(err)}`)
    }
    const out = new Headers()
    for (const [name, value] of response.headers) if (!DROP_RESPONSE_HEADERS.has(name)) out.set(name, value)
    return new Response(guardedBody(response.body, signal, upstream.model.api), {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    })
  }

  async function route(request: Request): Promise<Response> {
    const path = routeOf(new URL(request.url).pathname)
    if (request.method !== 'POST') return errorResponse(405, '只接受 POST')
    if (path === GATEWAY_ROUTES.llm || path.startsWith(`${GATEWAY_ROUTES.llm}/`)) return llm(request, path)
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
      case GATEWAY_ROUTES.changes:
        return json(await handlers.changes())
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
