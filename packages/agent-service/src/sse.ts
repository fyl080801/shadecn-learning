import type { ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import type { StartRunResult } from '@learning/agent-core/session'
import type { AgentStreamEvent } from '@learning/contracts/agent'
import { Injectable } from '@nestjs/common'

/**
 * SSE 心跳间隔。一次 ffmpeg 可能跑一分钟，这期间没有任何事件，而反代（nginx / Ingress）的空闲超时默认 60 秒，会把流掐掉。
 * 掐掉不会中止这一轮，但前端就得重新接回、白白补发一遍。发一行注释撑住，SSE 解析器都忽略注释行。
 */
export const SSE_HEARTBEAT_MS = 15_000

/** 退出时等收尾帧写出去的上限。到了还没写完的（客户端不读了）不等了：响应已经 `end`，接下来的 `server.close()` 会把它断开 */
export const SSE_CLOSE_GRACE_MS = 1_000

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }

/** 控制器 `@Res()` 拿到的 Fastify reply，这里只用这两样 */
export interface SseReply {
  hijack(): unknown
  raw: ServerResponse
}

/**
 * 一轮的事件在开流之前先攒着。订阅必须在开流**之前**做（状态码只能在响应头之前定：忙 409、接不回 404 / 410），
 * 而订阅那一刻就会收到帧（接回时是同步补发的整段缓冲），所以先进 `backlog`，流就绪后按顺序补发。
 */
export class SseRelay {
  private readonly backlog: AgentStreamEvent[] = []
  private sink: ((event: AgentStreamEvent) => void) | null = null

  readonly emit = (event: AgentStreamEvent): void => {
    if (this.sink) this.sink(event)
    else this.backlog.push(event)
  }

  attach(sink: (event: AgentStreamEvent) => void): void {
    for (const event of this.backlog.splice(0)) sink(event)
    this.sink = sink
  }
}

interface OpenStream {
  raw: ServerResponse
  end(): void
}

/**
 * 进程里所有开着的面板 SSE，和退出时的收口。
 *
 * **hijack 之后的响应没结束，`server.close()` 就不返回**，`app.close()` 也就卡在 ORM 和 Redis 关闭之前（`docs/31` §8.2）。Fastify 的 `forceCloseConnections` 默认只断空闲连接，管不到这里。
 * 大多数流在 `abortAll` 之后自己就结束了，例外是**跟着别的副本上那一轮**的订阅（`subscribeShared`）：这一轮不在本进程，`abortAll` 碰不到它，而它卡在 `SharedLog.wait` 上，`Cluster` 又在 HTTP 关闭之后才关，等不到。
 * 所以由持有者（这里）在 `AgentModule.onModuleDestroy` 里统一退订并结束，不依赖下层。退订也是读日志那个循环唯一的出口：不退订的话它在共享层关闭后每秒重试一次，永远不停。
 */
@Injectable()
export class AgentSseStreams {
  private readonly streams = new Set<OpenStream>()
  private readonly starts = new Set<Promise<unknown>>()
  private closed = false
  /** 退出已经开始：不放行新的一轮和新的接回 */
  draining = false

  /**
   * 放行一轮（退出期间给 null，控制器回 503）。判断和 `start()` 之间没有 await：`abortAll` 要么看得到这一轮，要么这一轮根本不开始。
   *
   * 还要记下来：续聊时 `start()` 要先到共享层占槽位，这期间 `abortAll` 只能把它标成已叫停，而它的 `done` 这时还是占位的，等不到它真正收尾。
   */
  admit(start: () => Promise<StartRunResult>): Promise<StartRunResult> | null {
    if (this.draining) return null
    const started = start()
    const settled = started
      .then((result) => (result.ok ? result.done : undefined))
      .catch(() => undefined)
      .finally(() => this.starts.delete(settled))
    this.starts.add(settled)
    return started
  }

  beginDrain(): void {
    this.draining = true
  }

  /** {@link admit} 放行的那些都收完尾了 */
  async startsSettled(): Promise<void> {
    await Promise.allSettled([...this.starts])
  }

  /**
   * 开流：补发攒下的、接着推后续的，`until` 兑现后关流。**只有状态码已经定了才能调**：这里一 hijack 就是 200。
   * **客户端断开只退订**：这一轮不随连接中止，照常跑完、照常落库，之后经 `GET …/events` 接回。
   */
  open(reply: SseReply, relay: SseRelay, until: Promise<void>, unsubscribe: () => void): void {
    reply.hijack()
    const raw = reply.raw
    // 写失败等于断开，由 close 那条路收尾。没有监听者时 error 事件会让进程崩掉
    raw.on('error', () => undefined)
    raw.writeHead(200, SSE_HEADERS)
    raw.flushHeaders()

    const write = (chunk: string) => {
      if (!raw.destroyed && !raw.writableEnded) raw.write(chunk)
    }
    relay.attach((event) => write(`data: ${JSON.stringify(event)}\n\n`))
    const heartbeat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS)
    heartbeat.unref()

    const stop = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    const stream: OpenStream = {
      raw,
      end() {
        stop()
        if (!raw.writableEnded) raw.end()
      },
    }
    const closed = () => {
      this.streams.delete(stream)
      stop()
    }
    this.streams.add(stream)
    // 等 `start()` / `subscribe()` 的时候客户端就断开了：`close` 已经过去，不会再来，这里不收拾的话要挂到这一轮结束
    if (raw.destroyed) closed()
    else raw.once('close', closed)
    void until.then(stream.end, stream.end)
    // 排在收口之后才开的流（`subscribe` 等得比收口久）：把已有的帧发完就结束，不能再挂上去
    if (this.closed) stream.end()
  }

  /**
   * 全部结束，等写出去。到这里 `abortAll` 已经收完尾，发起者的流最后一帧都写了。
   * 不用自己断开：`end()` 之后 Node 就当这个连接空闲了，`server.close()` 连同没写完的一起断（实测），而这一步之后不远就是它，所以这里要等一下，别把收尾帧断掉。
   */
  async closeAll(): Promise<void> {
    this.closed = true
    const open = [...this.streams]
    if (open.length === 0) return
    const ended = Promise.all(open.map(({ raw }) => new Promise<void>((resolve) => raw.once('close', () => resolve()))))
    for (const stream of open) stream.end()
    await Promise.race([ended, sleep(SSE_CLOSE_GRACE_MS, undefined, { ref: false })])
  }
}
