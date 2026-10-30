import { BUILD_ID } from '../build-id.ts'
import {
  GATEWAY_ROUTES,
  PROTOCOL_MISMATCH_ERROR,
  PROTOCOL_MISMATCH_STATUS,
  RUNNER_PROTOCOL_VERSION,
  type ProtocolMismatchBody,
  type CanvasChangesResponse,
  type EventsRequest,
  type FinishRequest,
  type RunnerEvent,
  type RunnerInput,
  type StsTokenResponse,
  type ToolCallRequest,
  type ToolCallResponse,
} from '../protocol.ts'

/**
 * runner 这一侧的网关客户端：带着 run 短令牌发 JSON 请求、快过期时续期、事件分批上报。
 * 协议见 `protocol.ts`。
 */

/** 网关回 401：令牌失效或这一轮已经结束 / 被叫停。runner 收到就停下退出，不重试 */
export class GatewayUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayUnauthorizedError'
  }
}

/** 网关回 409 protocol_mismatch：runner 和服务端的线协议版本不一致（镜像没重建）。runner 以独立退出码退出，不重试 */
export class RunnerProtocolMismatchError extends Error {
  readonly runnerVersion: number | null
  readonly serverVersion: number
  constructor(message: string, runnerVersion: number | null, serverVersion: number) {
    super(message)
    this.name = 'RunnerProtocolMismatchError'
    this.runnerVersion = runnerVersion
    this.serverVersion = serverVersion
  }
}

export interface GatewayClientOptions {
  /** 网关地址（含 `AGENT_GATEWAY_PATH`） */
  baseUrl: string
  /** 不给用调用那一刻的 `globalThis.fetch` */
  fetch?: typeof fetch
  /** 掐掉即中断所有在途请求（进程内驱动的「杀」） */
  signal?: AbortSignal
  /** 离过期还剩这么久就续期 */
  renewBeforeMs?: number
  now?: () => number
  /**
   * 兑换请求里报的协议版本；不给用 {@link RUNNER_PROTOCOL_VERSION}。`null` = 不带这个字段（**测试专用**，模拟老镜像）
   */
  protocolVersion?: number | null
  /** 兑换请求里报的构建 id；不给用编译期注入的那个（源码运行是 `source`） */
  buildId?: string
}

export interface GatewayClient {
  /** 模型代理的地址：runner 的模型 `baseUrl` */
  readonly llmBaseUrl: string
  redeem(bootstrapToken: string): Promise<void>
  /** 当前的 run 短令牌（快过期时先续期）—— 也是交给 pi 的 `apiKey` */
  token(): Promise<string>
  input(): Promise<RunnerInput>
  tool(request: ToolCallRequest): Promise<ToolCallResponse>
  changes(): Promise<CanvasChangesResponse>
  events(request: EventsRequest): Promise<void>
  finish(request: FinishRequest): Promise<void>
}

const RENEW_BEFORE_MS = 2 * 60_000

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const now = options.now ?? Date.now
  const renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS
  let current: StsTokenResponse | null = null
  let renewing: Promise<StsTokenResponse> | null = null

  async function post<T>(route: string, body: unknown, token: string | null): Promise<T> {
    const fetchImpl = options.fetch ?? globalThis.fetch
    const response = await fetchImpl(`${base}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    const message = (parsed as { message?: unknown } | null)?.message
    if (response.status === PROTOCOL_MISMATCH_STATUS && (parsed as { error?: unknown } | null)?.error === PROTOCOL_MISMATCH_ERROR) {
      const body = parsed as ProtocolMismatchBody
      throw new RunnerProtocolMismatchError(
        typeof message === 'string' ? message : '协议版本不一致',
        typeof body.runnerVersion === 'number' ? body.runnerVersion : null,
        body.serverVersion,
      )
    }
    if (response.status === 401) throw new GatewayUnauthorizedError(typeof message === 'string' ? message : '网关拒绝了令牌')
    if (!response.ok) {
      throw new Error(`网关 ${route} 回 ${response.status}：${typeof message === 'string' ? message : text.slice(0, 200)}`)
    }
    return parsed as T
  }

  async function token(): Promise<string> {
    if (!current) throw new GatewayUnauthorizedError('还没有兑换 bootstrap token')
    if (current.expiresAt - now() > renewBeforeMs) return current.token
    renewing ??= post<StsTokenResponse>(GATEWAY_ROUTES.token, { grantType: 'renew' }, current.token).finally(() => {
      renewing = null
    })
    current = await renewing
    return current.token
  }

  const authed = async <T>(route: string, body: unknown) => post<T>(route, body, await token())

  return {
    llmBaseUrl: `${base}${GATEWAY_ROUTES.llm}`,
    async redeem(bootstrapToken) {
      const protocolVersion = options.protocolVersion === undefined ? RUNNER_PROTOCOL_VERSION : options.protocolVersion
      current = await post<StsTokenResponse>(
        GATEWAY_ROUTES.token,
        {
          grantType: 'bootstrap',
          bootstrapToken,
          ...(protocolVersion === null ? {} : { protocolVersion }),
          buildId: options.buildId ?? BUILD_ID,
        },
        null,
      )
    },
    token,
    input: () => authed<RunnerInput>(GATEWAY_ROUTES.input, {}),
    tool: (request) => authed<ToolCallResponse>(GATEWAY_ROUTES.tool, request),
    changes: () => authed<CanvasChangesResponse>(GATEWAY_ROUTES.changes, {}),
    events: async (request) => {
      await authed(GATEWAY_ROUTES.events, request)
    },
    finish: async (request) => {
      await authed(GATEWAY_ROUTES.finish, request)
    },
  }
}

/** 一批事件最多多少字（序列化后）：远低于网关的请求体上限 */
const UPLINK_BATCH_CHARS = 1_000_000
const UPLINK_BATCH_EVENTS = 200

export interface Uplink {
  push(event: RunnerEvent): void
  /** 把攒着的发完、等在途的那批回来；之前任何一批失败都在这里抛出 */
  flush(): Promise<void>
}

/**
 * 事件分批上报：按顺序一批一批发（`seq` 逐批加一，网关只收下一批），攒到条数 / 字数上限或等 `delayMs` 就发。
 * 一批失败之后不再发（后面的序号也对不上了），`flush()` 把那个错误抛给调用方。
 */
export function createUplink(client: Pick<GatewayClient, 'events'>, delayMs = 40): Uplink {
  let queue: RunnerEvent[] = []
  let queuedChars = 0
  let seq = 0
  let chain: Promise<void> = Promise.resolve()
  let failure: unknown = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function send(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return chain
    const batch = queue
    queue = []
    queuedChars = 0
    const batchSeq = seq
    seq += 1
    chain = chain.then(async () => {
      if (failure) return
      try {
        await client.events({ seq: batchSeq, events: batch })
      } catch (err) {
        failure = err
      }
    })
    return chain
  }

  return {
    push(event) {
      queue.push(event)
      queuedChars += JSON.stringify(event).length
      if (queue.length >= UPLINK_BATCH_EVENTS || queuedChars >= UPLINK_BATCH_CHARS) void send()
      else timer ??= setTimeout(() => void send(), delayMs)
    },
    async flush() {
      await send()
      if (failure) throw failure
    },
  }
}
