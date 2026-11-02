import { randomUUID } from 'node:crypto'
import type { SharedChannel, SharedMap } from './shared-state.js'

/** 请求令牌：只带名字和类型，两边 import 同一个常量 */
export interface RequestToken<Req, Res> {
  readonly name: string
  /** 只为类型推导，运行时不存在 */
  readonly __types?: (req: Req) => Res
}

export function defineRequest<Req, Res>(name: string): RequestToken<Req, Res> {
  return { name }
}

export interface ScatterResult<Res> {
  /** 按回话先后 */
  readonly replies: readonly { instance: string; value: Res }[]
  /** 处理函数抛了错的实例 */
  readonly failures: readonly { instance: string; error: string }[]
  /** 登记了却没在超时内回话的实例 */
  readonly missing: readonly string[]
}

export type BusEnvelope =
  | { kind: 'request'; id: string; name: string; from: string; payload: unknown }
  | { kind: 'reply'; id: string; from: string; ok: true; value: unknown }
  | { kind: 'reply'; id: string; from: string; ok: false; error: string }

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
/** 提供方登记的 TTL；续期按它的 1/3 */
const RESPONDER_TTL_MS = 30_000

type Handler = (payload: unknown) => unknown
type HandlerResult = { ok: true; value: unknown } | { ok: false; error: string }

interface Pending {
  waiting: Set<string>
  replies: { instance: string; value: unknown }[]
  failures: { instance: string; error: string }[]
  finish: () => void
}

async function runHandler(handler: Handler, payload: unknown): Promise<HandlerResult> {
  try {
    return { ok: true, value: await handler(payload) }
  } catch (err) {
    console.error('[bus] 处理请求失败', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 跨进程的 scatter-gather 请求：发给**所有**登记了这个令牌的实例，等它们全部回话或超时。
 * 用在「把这张画布还开着的房间落库」：房间可能同时开在好几个副本上，调用方不知道是哪几个。
 *
 * - **谁会回话**：`handle()` 在共享表里登记 `<令牌>:<实例>`（TTL，定时续期），请求方读这张表就知道要等几个。一个都没有就立刻返回空结果。
 * - **本实例的处理函数直接调**，不绕共享层：单进程时整个请求不碰频道。
 * - **超时不是错误**：回来的在 `replies`，没回来的在 `missing`。频道不保证送达，调用方必须有退路。读不到登记表时只问本实例。
 * - 实例崩了留下的登记最多活一个 TTL：那段时间里请求会等满超时。
 */
export class Bus {
  private readonly handlers = new Map<string, Handler>()
  private readonly pending = new Map<string, Pending>()
  private unsubscribe: Promise<() => Promise<void>> | undefined
  private renewTimer: NodeJS.Timeout | undefined

  constructor(
    readonly instanceId: string,
    private readonly channel: SharedChannel<BusEnvelope>,
    private readonly responders: SharedMap<string>,
    private readonly responderTtlMs: number = RESPONDER_TTL_MS,
  ) {}

  private keyOf(name: string): string {
    return `${name}:${this.instanceId}`
  }

  /** 第一次用到才订阅：只发单进程请求的进程不必多一条连接。失败了下次重来 */
  private subscribed(): Promise<unknown> {
    this.unsubscribe ??= this.channel
      .subscribe(`inbox:${this.instanceId}`, (message) => void this.receive(message))
      .catch((err: unknown) => {
        this.unsubscribe = undefined
        throw err
      })
    return this.unsubscribe
  }

  private async receive(message: BusEnvelope): Promise<void> {
    if (message.kind === 'reply') {
      const entry = this.pending.get(message.id)
      if (!entry?.waiting.delete(message.from)) return
      if (message.ok) entry.replies.push({ instance: message.from, value: message.value })
      else entry.failures.push({ instance: message.from, error: message.error })
      if (entry.waiting.size === 0) entry.finish()
      return
    }

    const handler = this.handlers.get(message.name)
    // 登记表里有、处理函数已经撤了（正在退出）：不回话，请求方按超时算它 missing
    if (!handler) return
    const result = await runHandler(handler, message.payload)
    await this.channel
      .publish(`inbox:${message.from}`, { kind: 'reply', id: message.id, from: this.instanceId, ...result })
      .catch((err: unknown) => console.warn(`[bus] 回复 ${message.name} 失败`, err))
  }

  /** 注册处理函数并登记为提供方；返回撤销函数。同一个令牌在一个实例上只能有一个处理函数 */
  async handle<Req, Res>(token: RequestToken<Req, Res>, handler: (req: Req) => Res | Promise<Res>): Promise<() => Promise<void>> {
    if (this.handlers.has(token.name)) throw new Error(`[bus] ${token.name} 在本实例上已经有处理函数`)
    this.handlers.set(token.name, handler as Handler)
    await this.subscribed()
    await this.responders.set(this.keyOf(token.name), this.instanceId, this.responderTtlMs)
    this.renewTimer ??= setInterval(() => void this.renewAll(), Math.max(1_000, Math.floor(this.responderTtlMs / 3)))
    this.renewTimer.unref()
    return async () => {
      if (this.handlers.get(token.name) !== (handler as Handler)) return
      this.handlers.delete(token.name)
      await this.responders.deleteIfEquals(this.keyOf(token.name), this.instanceId).catch(() => undefined)
    }
  }

  private async renewAll(): Promise<void> {
    for (const name of this.handlers.keys()) {
      await this.responders.set(this.keyOf(name), this.instanceId, this.responderTtlMs).catch((err: unknown) => {
        console.warn(`[bus] 续期提供方登记 ${name} 失败`, err)
      })
    }
  }

  /** 发给全部提供方，等它们回话或超时。**永远不因为共享层故障而 reject** */
  async request<Req, Res>(token: RequestToken<Req, Res>, payload: Req, options: { timeoutMs?: number } = {}): Promise<ScatterResult<Res>> {
    const replies: { instance: string; value: unknown }[] = []
    const failures: { instance: string; error: string }[] = []

    const local = this.handlers.get(token.name)
    const localRun = local
      ? runHandler(local, payload).then((result) => {
          if (result.ok) replies.push({ instance: this.instanceId, value: result.value })
          else failures.push({ instance: this.instanceId, error: result.error })
        })
      : Promise.resolve()

    let remote: string[]
    try {
      remote = (await this.responders.entries(`${token.name}:`)).map(([, instance]) => instance).filter((instance) => instance !== this.instanceId)
      if (remote.length > 0) await this.subscribed()
    } catch (err) {
      // 读不到登记表或订阅不上：只能当没有别的提供方，调用方的退路兜着
      console.warn(`[bus] 问不到 ${token.name} 的其他提供方，只问本实例`, err)
      remote = []
    }

    const waiting = new Set(remote)
    if (waiting.size > 0) {
      const id = randomUUID()
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(() => finish(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
        const finish = () => {
          clearTimeout(timer)
          this.pending.delete(id)
          resolve()
        }
        this.pending.set(id, { waiting, replies, failures, finish })
      })
      const message: BusEnvelope = { kind: 'request', id, name: token.name, from: this.instanceId, payload }
      await Promise.all(
        remote.map((instance) =>
          this.channel.publish(`inbox:${instance}`, message).catch((err: unknown) => {
            console.warn(`[bus] 发给 ${instance} 的 ${token.name} 失败`, err)
          }),
        ),
      )
      await done
    }
    await localRun

    return { replies: replies as { instance: string; value: Res }[], failures, missing: [...waiting] }
  }

  /** 撤掉全部登记和订阅 */
  async close(): Promise<void> {
    clearInterval(this.renewTimer)
    this.renewTimer = undefined
    for (const name of [...this.handlers.keys()]) {
      await this.responders.deleteIfEquals(this.keyOf(name), this.instanceId).catch(() => undefined)
    }
    this.handlers.clear()
    for (const entry of [...this.pending.values()]) entry.finish()
    const off = this.unsubscribe
    this.unsubscribe = undefined
    if (off) await off.then((stop) => stop()).catch(() => undefined)
  }
}
