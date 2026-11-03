import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { COLLAB_PATH } from '@learning/contracts/collab'
import { RequestOrigins } from '@learning/session'
import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import crossws from 'crossws/adapters/node'
import { isAllowedCollabOrigin } from './collab-auth.js'
import { CollabServer } from './collab-server.js'
import { COLLAB_LIMITS } from './quota.js'

/** 退出时的关闭帧：1012 Service Restart。前端 `classifyClose` 认不出它，走普通重连，正好接到别的副本或重启后的自己 */
const CLOSE_RESTARTING = { code: 1012, reason: 'server-restarting' }

/** Hocuspocus 连接里 crossws 要转发的那几下，收窄后不用 cast 到底 */
interface ClientLink {
  handleMessage(data: Uint8Array): void
  handleClose(event: { code: number; reason: string }): void
}

interface FastifyContentTypes {
  hasContentTypeParser(type: string): boolean
  addContentTypeParser(type: string, options: { parseAs: 'buffer'; bodyLimit: number }, parser: (request: unknown, body: Buffer, done: (err: null, body: Buffer) => void) => void): void
}

/**
 * WebSocket 入口。Hocuspocus 挂在应用自己的 HTTP server 上（**不调 `listen()`**，那会另占一个端口），由 crossws 交给 `handleConnection`。房间名走消息不走路径，所以前端必须用 `@hocuspocus/provider`。
 *
 * `upgrade` 是裸的 Node 事件：Nest 的守卫、Fastify 的钩子都管不到这里，所以 `Origin` 手工查（{@link isAllowedCollabOrigin}），身份在 `onConnect` 里查。
 * 只处理 {@link COLLAB_PATH}。别的路径有别的监听者（Vite HMR）就不管，没有才销毁，否则这条连接一直挂着。
 */
@Injectable()
export class CollabGateway implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly links = new WeakMap<object, ClientLink>()
  private server: Server | undefined
  private accepting = true
  /** 交给别的监听者的 upgrade 连接。Vite 不认的路径它既不接也不关，这样的 socket 会挡住 HTTP server 关闭，退出时要由这里收掉 */
  private readonly foreignSockets = new Set<Duplex>()
  private readonly adapter

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(CollabServer) private readonly collab: CollabServer,
    @Inject(RequestOrigins) private readonly origins: RequestOrigins,
  ) {
    this.adapter = crossws({
      hooks: {
        open: (peer) => {
          this.links.set(peer, this.collab.hocuspocus.handleConnection(peer.websocket as never, peer.request as never))
        },
        message: (peer, message) => {
          this.links.get(peer)?.handleMessage(message.uint8Array())
        },
        close: (peer, event) => {
          this.links.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' })
        },
      },
    })
    this.collab.useSocketCloser((force) => this.adapter.closeAll(CLOSE_RESTARTING.code, CLOSE_RESTARTING.reason, force))
  }

  /**
   * 个人画布的 `POST /doc` 是二进制。Fastify 不认识的 content-type 回 415，所以要登记解析器，在路由注册之前。
   * 解析在路由之前跑：超过上限的请求体在这里就是 413，轮不到守卫（和 canvas 的坏 JSON 一样）。
   */
  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyContentTypes>()
    if (fastify.hasContentTypeParser('application/octet-stream')) return
    fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: COLLAB_LIMITS.message }, (_request, body, done) => done(null, body))
  }

  /** 这个阶段 server 还没 `listen`（实测），不会漏掉第一条连接 */
  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server
    this.server.on('upgrade', this.onUpgrade)
  }

  /**
   * 停接入，不摘监听：摘了之后 upgrade 请求会被 Node 当普通 HTTP 交给 Fastify，落到页面回退上。
   * 已有的连接由 `CollabServer` 在下一个阶段关，那时它们的落库还要用 ORM。
   */
  onModuleDestroy(): void {
    this.accepting = false
  }

  /** `onModuleDestroy` 之后到达的已被 {@link onUpgrade} 当场销毁，所以这里收完就没有漏网的 */
  beforeApplicationShutdown(): void {
    for (const socket of this.foreignSockets) socket.destroy()
    this.foreignSockets.clear()
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(req.url ?? '/', 'http://collab.invalid').pathname !== COLLAB_PATH) {
      // 监听者里至少有自己。Vite 的 HMR 是别的监听者，平时轮不到这里销毁
      if (!this.accepting || (this.server?.listenerCount('upgrade') ?? 0) <= 1) {
        socket.destroy()
        return
      }
      this.foreignSockets.add(socket)
      socket.once('close', () => this.foreignSockets.delete(socket))
      return
    }
    // 还没握手，socket 上出错没人接就是进程级的 uncaughtException
    socket.on('error', () => socket.destroy())

    if (!this.accepting) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    if (!isAllowedCollabOrigin(req.headers.origin, req.headers.host, this.origins.list)) {
      console.warn(`[collab] 拒绝来自 ${req.headers.origin} 的跨站握手`)
      // 回一行 403 再断开：配错 server.origins 时，这比一个 TCP reset 好查得多
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    void this.adapter.handleUpgrade(req, socket, head)
  }
}
