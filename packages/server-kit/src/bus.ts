import { randomUUID } from 'node:crypto'
import { sharedChannel, sharedMap, stringCodec } from './cluster/index.ts'
import type { SharedChannel, SharedMap } from './cluster/shared.ts'

/**
 * 跨角色 / 跨副本的请求-应答（docs/28 §3.7）：建在共享层上，单副本是进程内存，多副本是 Redis。
 *
 * 模块之间不互相 import 内部文件，要对方做事就经这里：调用方拿着对方包导出的**令牌**
 * （`defineRequest<Req, Res>('collab.flush-room')`）发请求，提供方用同一个令牌 `handle`。
 *
 * ## scatter-gather，不是点对点
 *
 * 一个请求发给**所有**登记了这个令牌的实例，等它们**全部**回话（或超时）。
 * 这正是「把这张画布还开着的房间落库」要的语义：房间可能同时开在好几个副本上，调用方不知道是哪几个。
 *
 * - **谁会回话**：`handle()` 在共享表 `bus-responder` 里登记 `<令牌>:<实例>`（TTL，定时续期），
 *   请求方先读这张表，就知道要等几个回复。一个都没有 = 立刻返回空结果 —— 不会因为「没人管」白等一个超时。
 * - **本实例的处理函数直接调**，不绕共享层；单进程（全部角色）时整个请求不碰频道。
 * - **超时不是错误**：回来的放在 `replies`，没回来的实例列在 `missing`。频道本来就不保证送达
 *   （`.claude/rules/cluster.md`），调用方**必须**有退路，不能把正确性押在全员回话上。
 * - 实例崩了留下的登记最多活一个 TTL：那段时间里请求会等满超时，然后在 `missing` 里看到它。
 *
 * 处理函数抛错 = 那个实例回一个失败（`failures`），不影响别的实例。
 */

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

export interface RequestOptions {
  /** 等回话的上限（毫秒），默认 {@link DEFAULT_REQUEST_TIMEOUT_MS} */
  timeoutMs?: number
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

/** 派给一个提供方（{@link Bus.dispatch}）的结果 */
export type DispatchResult<Res> =
  | { ok: true; instance: string; value: Res }
  /** 没有任何实例登记了这个令牌（比如 agent 角色一个副本都没起） */
  | { ok: false; reason: 'no-responder' }
  /** 选中的实例没在超时内回话。**它可能已经开始做了** —— 调用方不能拿同一个请求换个实例重发 */
  | { ok: false; reason: 'timeout'; instance: string }
  /** 选中的实例的处理函数抛了错 */
  | { ok: false; reason: 'failed'; instance: string; error: string }

/** 登记的 TTL；续期按它的 1/3 */
export const RESPONDER_TTL_MS = 30_000

type Envelope =
  | { kind: 'request'; id: string; name: string; from: string; payload: unknown }
  | { kind: 'reply'; id: string; from: string; ok: true; value: unknown }
  | { kind: 'reply'; id: string; from: string; ok: false; error: string }

type Handler = (payload: unknown) => unknown

interface Pending {
  waiting: Set<string>
  replies: { instance: string; value: unknown }[]
  failures: { instance: string; error: string }[]
  finish: () => void
}

export interface Bus {
  /** 这个实例的身份（和 `INSTANCE_ID` 一致） */
  readonly instanceId: string
  /** 注册处理函数并登记为提供方；返回撤销函数。同一个令牌在一个实例上只能有一个处理函数 */
  handle<Req, Res>(token: RequestToken<Req, Res>, handler: (req: Req) => Res | Promise<Res>): Promise<() => Promise<void>>
  /** 发给全部提供方，等它们回话或超时 */
  request<Req, Res>(token: RequestToken<Req, Res>, payload: Req, options?: RequestOptions): Promise<ScatterResult<Res>>
  /**
   * 派给**一个**提供方（负载分摊：发起一轮 agent）。本实例登记了就交给本实例（不绕共享层），否则在登记的实例里随机挑一个。
   * **只发一次，不自动换实例重试**：超时不代表没做（回话丢了），重发可能让同一件事做两遍。
   */
  dispatch<Req, Res>(token: RequestToken<Req, Res>, payload: Req, options?: RequestOptions): Promise<DispatchResult<Res>>
  /** 撤掉全部登记和订阅（进程退出、测试收尾） */
  close(): Promise<void>
}

export interface BusOptions {
  instanceId: string
  /** 测试注入；默认用共享层的懒代理 */
  channel?: SharedChannel<Envelope>
  responders?: SharedMap<string>
  responderTtlMs?: number
}

const INBOX = (instance: string) => `inbox:${instance}`

export function createBus(options: BusOptions): Bus {
  const { instanceId } = options
  const channel = options.channel ?? sharedChannel<Envelope>('bus')
  const responders = options.responders ?? sharedMap<string>('bus-responder', stringCodec)
  const ttl = options.responderTtlMs ?? RESPONDER_TTL_MS

  const handlers = new Map<string, Handler>()
  const pending = new Map<string, Pending>()
  let unsubscribe: Promise<() => Promise<void>> | undefined
  let renewTimer: NodeJS.Timeout | undefined

  const keyOf = (name: string) => `${name}:${instanceId}`

  /** 第一次 handle / request 时才订阅 —— 必须在宿主 `initCluster()` 之后，订阅不会随 backend 迁移 */
  function ensureSubscribed(): Promise<unknown> {
    unsubscribe ??= channel.subscribe(INBOX(instanceId), (message) => void receive(message))
    return unsubscribe
  }

  async function receive(message: Envelope) {
    if (message.kind === 'reply') {
      const entry = pending.get(message.id)
      if (!entry || !entry.waiting.delete(message.from)) return
      if (message.ok) entry.replies.push({ instance: message.from, value: message.value })
      else entry.failures.push({ instance: message.from, error: message.error })
      if (entry.waiting.size === 0) entry.finish()
      return
    }

    const handler = handlers.get(message.name)
    // 登记表里有、处理函数已经撤了（正在退出）：不回话，请求方按超时算它 missing
    if (!handler) return
    const reply = await runHandler(handler, message.payload)
    await channel
      .publish(INBOX(message.from), { kind: 'reply', id: message.id, from: instanceId, ...reply })
      .catch((err: unknown) => console.warn(`[bus] 回复 ${message.name} 失败`, err))
  }

  async function renewAll() {
    for (const name of handlers.keys()) {
      await responders.set(keyOf(name), instanceId, ttl).catch((err: unknown) => {
        console.warn(`[bus] 续期提供方登记 ${name} 失败`, err)
      })
    }
  }

  return {
    instanceId,

    async handle(token, handler) {
      if (handlers.has(token.name)) throw new Error(`[bus] ${token.name} 在本实例上已经有处理函数`)
      handlers.set(token.name, handler as Handler)
      await ensureSubscribed()
      await responders.set(keyOf(token.name), instanceId, ttl)
      if (!renewTimer) {
        renewTimer = setInterval(() => void renewAll(), Math.max(1_000, Math.floor(ttl / 3)))
        renewTimer.unref()
      }
      return async () => {
        if (handlers.get(token.name) !== handler) return
        handlers.delete(token.name)
        await responders.deleteIfEquals(keyOf(token.name), instanceId).catch(() => undefined)
      }
    },

    async request(token, payload, requestOptions = {}) {
      const replies: { instance: string; value: unknown }[] = []
      const failures: { instance: string; error: string }[] = []

      // 本实例的处理函数直接调：单进程时整个请求不碰共享层
      const local = handlers.get(token.name)
      const localRun = local
        ? runHandler(local, payload).then((result) => {
            if (result.ok) replies.push({ instance: instanceId, value: result.value })
            else failures.push({ instance: instanceId, error: result.error })
          })
        : Promise.resolve()

      let remote: string[] = []
      try {
        remote = (await responders.entries(`${token.name}:`))
          .map(([, instance]) => instance)
          .filter((instance) => instance !== instanceId)
      } catch (err) {
        // 读不到登记表：只能当没有别的提供方。调用方的退路兜着（missing 为空不代表全员到齐，这里记一笔）
        console.warn(`[bus] 读取 ${token.name} 的提供方失败，只问本实例`, err)
      }

      const waiting = new Set(remote)
      if (waiting.size > 0) {
        await ensureSubscribed()
        const id = randomUUID()
        let timer: NodeJS.Timeout | undefined
        const done = new Promise<void>((resolve) => {
          const finish = () => {
            if (timer) clearTimeout(timer)
            pending.delete(id)
            resolve()
          }
          pending.set(id, { waiting, replies, failures, finish })
          timer = setTimeout(finish, requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
        })
        const message: Envelope = { kind: 'request', id, name: token.name, from: instanceId, payload }
        await Promise.all(
          [...remote].map((instance) =>
            channel.publish(INBOX(instance), message).catch((err: unknown) => {
              console.warn(`[bus] 发给 ${instance} 的 ${token.name} 失败`, err)
            }),
          ),
        )
        await done
      }
      await localRun

      return {
        replies: replies as { instance: string; value: never }[],
        failures,
        missing: [...waiting],
      }
    },

    async dispatch(token, payload, requestOptions = {}) {
      const local = handlers.get(token.name)
      if (local) {
        const result = await runHandler(local, payload)
        return result.ok
          ? { ok: true as const, instance: instanceId, value: result.value as never }
          : { ok: false as const, reason: 'failed' as const, instance: instanceId, error: result.error }
      }

      let candidates: string[]
      try {
        candidates = (await responders.entries(`${token.name}:`)).map(([, instance]) => instance)
      } catch (err) {
        console.warn(`[bus] 读取 ${token.name} 的提供方失败`, err)
        candidates = []
      }
      if (candidates.length === 0) return { ok: false, reason: 'no-responder' }
      const instance = candidates[Math.floor(Math.random() * candidates.length)]!

      await ensureSubscribed()
      const id = randomUUID()
      const replies: { instance: string; value: unknown }[] = []
      const failures: { instance: string; error: string }[] = []
      const waiting = new Set([instance])
      let timer: NodeJS.Timeout | undefined
      const done = new Promise<void>((resolve) => {
        const finish = () => {
          if (timer) clearTimeout(timer)
          pending.delete(id)
          resolve()
        }
        pending.set(id, { waiting, replies, failures, finish })
        timer = setTimeout(finish, requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      })
      await channel
        .publish(INBOX(instance), { kind: 'request', id, name: token.name, from: instanceId, payload })
        .catch((err: unknown) => console.warn(`[bus] 派给 ${instance} 的 ${token.name} 失败`, err))
      await done

      if (replies[0]) return { ok: true, instance, value: replies[0].value as never }
      if (failures[0]) return { ok: false, reason: 'failed', instance, error: failures[0].error }
      return { ok: false, reason: 'timeout', instance }
    },

    async close() {
      if (renewTimer) clearInterval(renewTimer)
      renewTimer = undefined
      for (const name of [...handlers.keys()]) {
        await responders.deleteIfEquals(keyOf(name), instanceId).catch(() => undefined)
      }
      handlers.clear()
      for (const entry of pending.values()) entry.finish()
      const off = unsubscribe
      unsubscribe = undefined
      if (off) await (await off)().catch(() => undefined)
    },
  }
}

async function runHandler(
  handler: Handler,
  payload: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await handler(payload) }
  } catch (err) {
    console.error('[bus] 处理请求失败', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------- 进程级实例

let current: Bus | undefined

/** 宿主在 `initCluster()` 之后调一次，定下实例身份（`apps/server/boot.ts`）。没调过（测试）就按随机身份懒建 */
export function configureBus(options: { instanceId: string }): Bus {
  current = createBus(options)
  return current
}

/** 进程里的那一个总线 */
export function bus(): Bus {
  current ??= createBus({ instanceId: `local-${randomUUID().slice(0, 8)}` })
  return current
}

/** 测试用：换一个总线，返回还原函数 */
export function useBusForTesting(next: Bus): () => void {
  const previous = current
  current = next
  return () => {
    current = previous
  }
}
