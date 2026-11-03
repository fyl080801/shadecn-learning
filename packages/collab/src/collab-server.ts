import { AccessRevocation, CANVAS_FLUSH_CONTENT, REVOCATION_POLL_INTERVAL_MS } from '@learning/canvas'
import { Cluster } from '@learning/cluster'
import { CLOSE_QUOTA_LOCKED, CLOSE_REVOKED, CLOSE_UNAUTHORIZED, STORE_STATE_MESSAGE } from '@learning/contracts/collab'
import { type Connection, type Document, type Extension, Hocuspocus } from '@hocuspocus/server'
import { setTimeout as sleep } from 'node:timers/promises'
import { type BeforeApplicationShutdown, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import * as Y from 'yjs'
import { AwarenessClaims, enforceIdentity } from './awareness.js'
import { closeForGood, denialError } from './close.js'
import { COLLAB_EXTENSIONS } from './collab-extensions.js'
import { type CollabAuthorization, type CollabDenialReason, CollabAuth, type CollabIdentity } from './collab-auth.js'
import { EXCLUSIVE_SWEEP_INTERVAL, ExclusiveConnections, type ExclusiveDocument } from './exclusive.js'
import { pruneDanglingEdges } from './flow-doc.js'
import { flowIdOf, FlowPersistence, roomOf } from './flow-persistence.js'
import { COLLAB_LIMITS, CollabQuota } from './quota.js'
import { createWriteGate, isWriteSync, type WriteGate } from './write-gate.js'

/** 连接上下文：`onConnect` 认定的身份。direct connection（生成任务、将来的 agent）没有它 */
export interface CollabContext {
  identity?: CollabIdentity | null
  /** 个人画布的房间：awareness 整帧丢弃 */
  personal?: boolean
}

/**
 * 成员资格复验的间隔：权限收回却没收到事件（跨进程广播失败）时还能写多久的上限。
 * 主路径是 {@link AccessRevocation} 的事件，这是兜底。一轮的成本是每个房间、每个不同 cookie 几次查询。
 */
const REAUTH_INTERVAL = 20_000
/** 欠账重试的间隔：数据库恢复之后最晚多久把没落库的内容补上。平时一次库都不碰 */
const STORE_RETRY_INTERVAL = 30_000
/** 汇总日志的间隔，这段时间什么都没发生就不打 */
const SUMMARY_INTERVAL = 60_000
/** 退出时收尾的上限。配 k8s 的 `terminationGracePeriodSeconds: 60`。超时就认了，内容还在客户端的 IndexedDB 里 */
const SHUTDOWN_TIMEOUT_MS = 20_000
/**
 * 退出时等房间散场的上限。断开钩子（放掉 awareness 和互斥的登记）在散场之前跑，没跑完就退的话，重连到别的副本的人要等登记过期才看得到光标；
 * Redis 扩展要在散场前等 1 秒（`disconnectDelay`），所以至少要比它长。落库失败的房间散不了场，到点就不等了：内容已经由 `flushRooms` 尽力写过。
 */
const ROOMS_SETTLE_TIMEOUT_MS = 3_000
const ROOMS_SETTLE_POLL_MS = 20
/** 关 Redis 扩展的上限：Redis 这时可能已经挂了，它的 `quit` 会在离线队列里一直等 */
const EXTENSIONS_CLOSE_TIMEOUT_MS = 2_000

/**
 * 同一条更新会在每个持有房间的副本上触发 `onChange`。按条计的副作用要跳过 redis 转发来的那份，否则一条更新记 N 次。
 * 认不出形状的 origin 算「要处理」。
 */
export function isRelayedUpdate(origin: unknown): boolean {
  return typeof origin === 'object' && origin !== null && (origin as { source?: unknown }).source === 'redis'
}

/** 落库状态的广播。走 stateless：是通知不是内容，不进 Y.Doc、不进撤销栈 */
function storeStatePayload(ok: boolean): string {
  return JSON.stringify({ type: STORE_STATE_MESSAGE, ok })
}

const closeEventOf = (reason: CollabDenialReason) => (reason === 'unauthorized' ? CLOSE_UNAUTHORIZED : CLOSE_REVOKED)

const cookieOf = (connection: Connection): string | null => connection.request?.headers?.get?.('cookie') ?? null

/** 关掉底层 socket，由接 WebSocket 的那一层提供。`force` = 不等对方回关闭帧 */
export type SocketCloser = (force: boolean) => void

/**
 * 进程里的 Hocuspocus 实例，以及围绕它的业务钩子：鉴权、落库、配额、awareness、单连接互斥、写闸门、复验、退出。
 * **不接 WebSocket**：那是 `CollabGateway` 的事。只 import `CollabModule` 的进程（平台上的生成任务、将来的 agent 进程）经 direct connection 开房间，落库和复验照常。
 *
 * 关闭顺序（docs/30 §5），每一步都是因为下一步要依赖它：
 * - `onModuleDestroy`：停定时器和撤权订阅，撤掉总线上的落库登记（入口由 `CollabGateway` 在同一阶段停）；
 * - `beforeApplicationShutdown`：关连接和 socket、逐房间落库、排空、等房间散场、关 Redis 扩展。**此时 ORM 和共享层还开着**，它们在 `onApplicationShutdown`；
 * - 然后 Nest 才关 HTTP：upgrade 之后的 socket 也算 server 的连接，不关的话 `app.close()` 一直不返回（实测），ORM 也就关不掉。
 */
@Injectable()
export class CollabServer implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  readonly hocuspocus: Hocuspocus
  /** 写闸门和复验是同一件事的两个粒度：复验踢连接（也是让前端重新登录、推上攒着的改动的触发点），闸门在那之前把每个写帧挡在 Y.Doc 外 */
  private readonly writeGate: WriteGate
  /** 这一条消息超限、临时置为 readOnly 的连接，`afterHandleMessage` 恢复 */
  private readonly oversizedFrame = new WeakSet<Connection>()
  /** 正在跑的那轮复验：房间多、库慢时下一轮不能叠上来 */
  private revalidating: Promise<void> | null = null
  /** 排在它后面的一轮，见 {@link revalidateConnections} */
  private nextRevalidation: Promise<void> | null = null
  private timers: NodeJS.Timeout[] = []
  private stopRevocation: (() => void) | undefined
  private stopFlushHandler: (() => Promise<void>) | undefined
  private socketCloser: SocketCloser | undefined
  private readonly instanceId: string
  /** 只算这个副本收到的更新，见 {@link isRelayedUpdate} */
  private window = { updates: 0, bytes: 0, completed: 0, failed: 0 }

  constructor(
    @Inject(CollabAuth) private readonly auth: CollabAuth,
    @Inject(FlowPersistence) private readonly persistence: FlowPersistence,
    @Inject(CollabQuota) private readonly quota: CollabQuota,
    @Inject(AwarenessClaims) private readonly awareness: AwarenessClaims,
    @Inject(ExclusiveConnections) private readonly exclusive: ExclusiveConnections,
    @Inject(AccessRevocation) private readonly revocation: AccessRevocation,
    @Inject(Cluster) private readonly cluster: Cluster,
    @Inject(COLLAB_EXTENSIONS) extensions: Extension[],
  ) {
    this.instanceId = cluster.instanceId
    this.writeGate = createWriteGate({
      // refresh: false：背后没有用户动作，让它续期等于一直编辑就永不登出。续期归真实的 HTTP 请求
      authorize: async (cookie, room) => {
        const result = await this.auth.authorize(cookie, room, { refresh: false })
        return result.ok ? null : result.reason
      },
    })
    this.hocuspocus = this.createInstance(extensions)
  }

  /** socketId 只在进程内唯一，awareness 归属会跨实例比对，要带实例前缀 */
  private scopedSocketId(socketId: string): string {
    return `${this.instanceId}:${socketId}`
  }

  private createInstance(extensions: Extension[]): Hocuspocus {
    return new Hocuspocus({
      name: 'flow-collab',
      // 业务钩子排在所有扩展之后：Redis 扩展（priority 1000）的 redlock 没抢到时，下面的 onStoreDocument 不跑，也就不算一次落库
      extensions,

      /** 握手鉴权。身份靠 httpOnly cookie，所以走这里而不是 `onAuthenticate`。抛错就是拒绝，原因挂在 `reason` 上 */
      onConnect: async (data) => {
        const result = await this.auth.authorize(data.requestHeaders.get('cookie'), data.documentName)
        if (!result.ok) {
          console.warn(`[collab] 拒绝连接（${result.reason}）：${data.documentName}`)
          throw denialError(closeEventOf(result.reason))
        }
        return { identity: result.identity, personal: result.personal === true } satisfies CollabContext
      },

      /** 连接真正建起来了。互斥放这里不放 `onConnect`：那时连接对象还没建，拿不到要踢的对象 */
      connected: async (data) => {
        const document: ExclusiveDocument = data.connection.document
        this.writeGate.prime(data.connection.socketId)
        await this.exclusive.claim(data.documentName, data.connection)
        await this.exclusive.enforce([document])
        // 状态广播只在翻转时发，后进来的人错过了那一次，要补发
        if (this.persistence.isStoreFailing(data.documentName)) data.connection.document.broadcastStateless(storeStatePayload(false))
      },

      /**
       * 写闸门，见 `write-gate.ts`。拦下之后**还要关连接**：provider 收到 NACK 什么都不做也不重发，只有重连的同步才带得上那些改动。
       * 关连接挪到微任务：此刻还在 `readSyncMessage` 的调用栈上。
       */
      beforeSync: async (data) => {
        if (!isWriteSync(data.type)) return
        const { connection, documentName } = data

        // 房间顶到硬限：清场之后新连进来的人不在 lockRoom 那一轮的名单里。落在写帧上：只看不写的人该继续读得到
        const quotaReason = this.quota.locked(documentName)
        if (quotaReason) {
          connection.readOnly = true
          console.warn(`[collab] ${documentName} 拒绝写入（${quotaReason}）`)
          queueMicrotask(() => closeForGood(connection, CLOSE_QUOTA_LOCKED))
          return
        }

        const denial = await this.writeGate.check(connection.socketId, documentName, cookieOf(connection))
        if (!denial) return
        // 这一帧、以及关连接落地之前排在队列里的，都会被 Hocuspocus 的 readOnly 检查 NACK 掉
        connection.readOnly = true
        console.warn(`[collab] ${documentName} 拒绝写入（${denial}）`)
        queueMicrotask(() => closeForGood(connection, closeEventOf(denial)))
      },

      /** 配额的拦截点。**绝不抛错**：抛错连接被关，provider 重连重发同一条，房间对所有人不可达。拒绝走 readOnly：NACK 但不断连 */
      beforeHandleMessage: async (data) => {
        if (data.update.byteLength > COLLAB_LIMITS.message) {
          console.warn(`[collab] ${data.documentName} 收到 ${data.update.byteLength} 字节的超限消息，拒绝这一条`)
          this.oversizedFrame.add(data.connection)
          data.connection.readOnly = true
          return
        }
        if (this.quota.locked(data.documentName)) data.connection.readOnly = true
      },

      afterHandleMessage: async (data) => {
        if (!this.oversizedFrame.delete(data.connection)) return
        if (!this.quota.locked(data.documentName)) data.connection.readOnly = false
      },

      /** awareness 的两道防线。超限帧整帧丢：readOnly 拦不住 awareness */
      beforeHandleAwareness: async (data) => {
        const context = data.context as CollabContext | undefined
        if (context?.personal || (data.connection && this.oversizedFrame.has(data.connection))) {
          data.states.clear()
          return
        }
        if (data.connection) await this.awareness.dropForeignClients(data.documentName, this.scopedSocketId(data.socketId), data.states)
        enforceIdentity(data.states, context?.identity ?? null)
      },

      onLoadDocument: async (data) => {
        const state = await this.persistence.load(data.documentName)
        if (state) Y.applyUpdate(data.document, state, 'persistence')
        return data.document
      },

      /** 落库前清掉悬空边。人走光了才顺带写投影 */
      onStoreDocument: async (data) => {
        const pruned = pruneDanglingEdges(data.document)
        if (pruned > 0) console.log(`[collab] ${data.documentName} 清理了 ${pruned} 条悬空连线`)
        try {
          await this.persistence.store(data.documentName, data.document, { projection: data.clientsCount === 0 })
        } catch (error) {
          // 抛错钩子链就断了，Redis 扩展放锁的 afterStoreDocument 不会跑。不放的话锁要占满 10 秒，所有副本这段时间的落库都被当成「别的实例在存」跳过，补上欠账之后的新内容也进不了库
          await this.hocuspocus.hooks('afterStoreDocument', data).catch(() => undefined)
          throw error
        }
      },

      /**
       * 投影的兜底写入点：最后一个人离开时，Hocuspocus 只在还有挂起的防抖时才补一次 store，「改完等两秒再关页面」走不到上面。
       * 也是多副本下的兜底：redlock 没抢到时 `onStoreDocument` 被跳过，这里不看锁，读 → 合并 → CAS 保证不丢。
       */
      beforeUnloadDocument: async (data) => {
        await this.persistence.store(data.documentName, data.document, { projection: true })
      },

      /** 配额不跳过 redis 转发的更新：每个副本持有完整文档，各自都要量 */
      onChange: async (data) => {
        if (!isRelayedUpdate(data.transactionOrigin)) {
          this.window.updates += 1
          this.window.bytes += data.update.byteLength
        }
        const locked = this.quota.check(data.documentName, data.document, data.update.byteLength)
        if (locked) this.lockRoom(data.document, locked)
      },

      onDisconnect: async (data) => {
        this.writeGate.forget(data.socketId)
        await this.awareness.releaseSocket(data.documentName, this.scopedSocketId(data.socketId))
        await this.exclusive.release(data.documentName, data.socketId)
      },

      /** 房间散场：清掉这个房间的进程内缓存，否则按打开过的画布数无限攒 */
      afterUnloadDocument: async (data) => {
        this.quota.forget(data.documentName)
        this.exclusive.forgetRoom(data.documentName)
        this.awareness.forgetRoom(data.documentName)
        await this.persistence.forget(data.documentName)
      },

      /**
       * 多久没收到消息就掐掉连接。它不是 ping 间隔：服务端不发心跳，靠客户端每 15 秒的 awareness 重播和回显撑住两个方向。
       * 30 秒 = 容忍连丢两拍，和 provider 的 `messageReconnectTimeout` 对齐；压在反代的 60 秒以下，真断了是我们先发现、先释放互斥和光标。
       */
      timeout: 30_000,
      /** 攒够一小段时间再广播，压消息数 */
      flushDelay: 30,
      /** 有改动后最多攒 2 秒落一次库；持续编辑时最长 10 秒一定落一次 */
      debounce: 2000,
      maxDebounce: 10000,
    })
  }

  /**
   * 房间顶到硬限：锁写，并把所有人请出去。两步都不能少：锁只读同步生效，排在队列里的帧才会被 NACK；
   * 关连接是因为 NACK 是无声的（用户会对着「已同步」继续画），而且房间不散场锁就解不了，所有人都删不了东西。
   * 关连接挪到微任务：此刻还在 `onChange` 的调用栈上。
   */
  private lockRoom(document: Document, reason: string): void {
    const doomed: Connection[] = []
    document.connections.forEach((_clients, connection) => {
      connection.readOnly = true
      doomed.push(connection)
    })
    console.warn(`[collab] ${document.name} 锁写并清场（${reason}），共 ${doomed.length} 条连接`)
    queueMicrotask(() => {
      for (const connection of doomed) closeForGood(connection, CLOSE_QUOTA_LOCKED)
    })
  }

  private async revalidateDocument(document: Document): Promise<void> {
    // 同一份 cookie 在一轮里只查一次
    const verdicts = new Map<string, Promise<CollabAuthorization | null>>()
    const doomed: { connection: Connection; reason: CollabDenialReason }[] = []
    const checks: Promise<void>[] = []

    document.connections.forEach((_clients, connection) => {
      const cookie = cookieOf(connection) ?? ''
      let verdict = verdicts.get(cookie)
      if (!verdict) {
        // 抛异常 = 基础设施出问题，证明不了任何事：当作通过，下一轮再查
        verdict = this.auth.authorize(cookie, document.name, { refresh: false }).catch(() => null)
        verdicts.set(cookie, verdict)
      }
      checks.push(
        verdict.then((result) => {
          if (result && !result.ok) doomed.push({ connection, reason: result.reason })
        }),
      )
    })

    await Promise.all(checks)
    for (const { connection, reason } of doomed) {
      console.warn(`[collab] ${document.name} 的连接复验未通过（${reason}），断开`)
      closeForGood(connection, closeEventOf(reason))
    }
  }

  /**
   * 对所有在线连接重查会话 + 成员身份，查不过的踢下线。主动撤权和定时兜底都汇到这里，所以判定缓存也在这里作废。
   * 调用方等到的是「**调用之后才开始**的一轮复验跑完了」，路由 204 的保证靠它。已经有一轮在跑时不能直接复用：它可能已经查完库了，撤权落在这之后就看不到，要等定时兜底。
   * 所以排一轮接着跑，这期间再来的共用排着的那一轮：不叠着跑，最多多一轮。房间之间并行：串行的话最后一个房间的窗口是「间隔 + 前面所有房间的耗时」。
   */
  revalidateConnections(): Promise<void> {
    if (!this.revalidating) {
      this.revalidating = this.runRevalidation()
      return this.revalidating
    }
    this.nextRevalidation ??= this.revalidating
      .catch(() => undefined)
      .then(() => {
        this.nextRevalidation = null
        return this.revalidateConnections()
      })
    return this.nextRevalidation
  }

  private async runRevalidation(): Promise<void> {
    try {
      this.writeGate.clear()
      await Promise.all([...this.hocuspocus.documents.values()].map((document) => this.revalidateDocument(document)))
    } finally {
      this.revalidating = null
    }
  }

  private every(intervalMs: number, label: string, task: () => void | Promise<unknown>): void {
    const timer = setInterval(() => {
      void Promise.resolve()
        .then(task)
        .catch((err: unknown) => console.error(`[collab] ${label}失败`, err))
    }, intervalMs)
    timer.unref()
    this.timers.push(timer)
  }

  private summarize(): void {
    const store = this.persistence.storeStats()
    const completed = store.completed - this.window.completed
    const failed = store.failed - this.window.failed
    const { updates, bytes } = this.window
    this.window = { updates: 0, bytes: 0, completed: store.completed, failed: store.failed }
    if (completed === 0 && failed === 0 && updates === 0) return
    const line = `[collab] 最近一分钟：落库 ${completed} 次，失败 ${failed} 次，更新 ${updates} 次（${bytes} 字节），房间 ${this.hocuspocus.documents.size} 个`
    if (failed > 0) console.warn(line)
    else console.log(line)
  }

  async onModuleInit(): Promise<void> {
    // 落库状态一翻转就告诉房间里的人：内容进了内存也广播了，连接看不出异常，不说一声界面会一直写着「已同步」
    this.persistence.onStoreStateChange((documentName, ok) => {
      const document = this.hocuspocus.documents.get(documentName)
      if (!document) return
      console.warn(`[collab] ${documentName} 落库${ok ? '恢复' : '失败'}，已通知房间`)
      document.broadcastStateless(storeStatePayload(ok))
    })

    this.every(REAUTH_INTERVAL, '连接复验', () => this.revalidateConnections())
    this.every(EXCLUSIVE_SWEEP_INTERVAL, '单连接巡检', () => this.exclusive.enforce(this.hocuspocus.documents.values()))
    this.every(STORE_RETRY_INTERVAL, '落库重试', () => this.retryFailedStores())
    this.every(SUMMARY_INTERVAL, '汇总日志', () => this.summarize())

    /*
     * 权限被收回 → 当场复验、断掉失权的连接。路由 await 它，所以 204 回去时人已经下线了。
     * 不靠定时兜底：那段时间里被移除的人改的东西会被合并、落库，其他人撤销不回来（UndoManager 只跟踪自己的 origin）。
     */
    this.stopRevocation = this.revocation.onRevoked(() => this.revalidateConnections())

    /*
     * 别的进程（平台、别的副本）撤了权，这里只看得到世代号变了。变了就转成本进程的通知，上面的订阅者当场复验。
     * 启动时就记下当前值，不等第一拍：第一次只记不报，等到第一拍才记的话，启动后三秒内的撤权就漏了。
     */
    const watcher = this.revocation.createWatcher()
    await watcher.changed()
    this.every(REVOCATION_POLL_INTERVAL_MS, '撤权轮询', async () => {
      if (await watcher.changed()) await this.revocation.notify()
    })

    this.stopFlushHandler = await this.cluster.bus.handle(CANVAS_FLUSH_CONTENT, async ({ flowId }) => {
      await this.flushRoom(flowId)
      return null
    })
  }

  /**
   * 把这张画布还开着的房间落一次库，给 `CANVAS_FLUSH_CONTENT`（复制画布之前）。房间不在本实例上就什么也不做，照样回话：请求方据此知道不用再等。
   * 带投影：复制出来的画布，计数读的是投影，不写就是上一轮的样子。不看 redlock：请求方在等这份内容，CAS 兜得住并发。
   */
  async flushRoom(flowId: string): Promise<void> {
    const document = this.hocuspocus.documents.get(roomOf(flowId))
    if (document) await this.persistence.store(document.name, document, { projection: true })
  }

  /**
   * 补欠账，并卸载补上之后已经没人的房间。人走时落库失败，Hocuspocus 把文档留在内存，而它只在自己的落库成功后才卸载；
   * 这里的重试绕开了它，不补这一步，文档要等下次有人进出才释放。还有人或还有挂起的落库时 `unloadDocument` 自己不会动。
   */
  async retryFailedStores(): Promise<void> {
    for (const documentName of await this.persistence.retryFailed()) {
      const document = this.hocuspocus.documents.get(documentName)
      if (document) await this.hocuspocus.unloadDocument(document)
    }
  }

  /** 房间到了容量上限的原因；没到是 null。经 direct connection 往房间写的模块（生成任务）写之前判，它们不过写闸门和 `beforeHandleMessage` */
  quotaLocked(documentName: string): string | null {
    return this.quota.locked(documentName)
  }

  /** 接 WebSocket 的那一层登记怎么关 socket。关连接和落库的顺序只写在这里 */
  useSocketCloser(closer: SocketCloser): void {
    this.socketCloser = closer
  }

  stats() {
    const rooms = [...this.hocuspocus.documents.entries()].map(([name, document]) => ({
      name,
      connections: document.getConnectionsCount(),
      awarenessClients: document.awareness.getStates().size,
      flowId: flowIdOf(name),
    }))
    return { rooms, totalRooms: rooms.length, totalConnections: rooms.reduce((sum, room) => sum + room.connections, 0) }
  }

  /** 先撤登记再关连接：之后到的落库请求不会再等一个马上要走的实例 */
  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.stopRevocation?.()
    this.stopRevocation = undefined
    await this.stopFlushHandler?.()
    this.stopFlushHandler = undefined
  }

  async beforeApplicationShutdown(): Promise<void> {
    // 只调 closeConnections 不关 socket 的话 app.close() 一直不返回（实测）
    this.hocuspocus.closeConnections()
    this.socketCloser?.(false)

    let timeout: NodeJS.Timeout | undefined
    const expired = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS)
      timeout.unref()
    })
    const gaveUp = await Promise.race([this.flushRooms().then(() => false), expired])
    clearTimeout(timeout)
    if (gaveUp) console.error(`[collab] 退出收尾超过 ${SHUTDOWN_TIMEOUT_MS} 毫秒，放弃等待，未落库的内容还在客户端`)

    // 对方不回关闭帧的 socket（断网、挂起的标签页）也不能挡住退出。收尾期间才完成握手的连接一起带走
    this.hocuspocus.closeConnections()
    this.socketCloser?.(true)
    await this.roomsSettled()
    await this.closeExtensions()
    this.summarize()
  }

  /** 等没人的房间走完散场，见 {@link ROOMS_SETTLE_TIMEOUT_MS}。direct connection 撑着的房间不散场，不等 */
  private async roomsSettled(): Promise<void> {
    const deadline = Date.now() + ROOMS_SETTLE_TIMEOUT_MS
    const leaving = () => [...this.hocuspocus.documents.values()].some((document) => document.getConnectionsCount() === 0)
    while (leaving() && Date.now() < deadline) await sleep(ROOMS_SETTLE_POLL_MS)
  }

  /** 散场之后才关：扩展在散场的钩子里还要退订。Redis 连接不关的话进程退不干净，也不算漏数据，所以出错只记一笔 */
  private async closeExtensions(): Promise<void> {
    await Promise.race([
      this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus }).catch((err: unknown) => console.warn('[collab] 关闭 Hocuspocus 扩展失败', err)),
      sleep(EXTENSIONS_CLOSE_TIMEOUT_MS, undefined, { ref: false }),
    ])
  }

  /**
   * 把所有还开着的房间落一次库并排空。直接对每个房间存并 await，**不走 `flushPendingStores()`**：它到真正入队隔着一段微任务链，采样时队列还是空的，最后一个防抖窗口就丢了。
   * `allSettled`：一个房间失败不能放弃其余房间的收尾。
   */
  private async flushRooms(): Promise<void> {
    const documents = [...this.hocuspocus.documents.values()]
    const results = await Promise.allSettled(documents.map((document) => this.persistence.store(document.name, document, { projection: true })))
    const failed = results.filter((result) => result.status === 'rejected').length
    if (failed > 0) console.error(`[collab] 退出前有 ${failed}/${results.length} 张画布没能落库`)
    await this.persistence.drain()
  }
}
