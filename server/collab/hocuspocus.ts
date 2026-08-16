import type { ServerType } from '@hono/node-server'
import { Hocuspocus, type Connection, type Document } from '@hocuspocus/server'
import crossws from 'crossws/adapters/node'
import * as Y from 'yjs'

import { authorizeCollab, type CollabIdentity } from '../auth/ws.ts'
import { dropForeignClients, enforceIdentity, forgetClaims, releaseSocket } from './awareness.ts'
import { pruneDanglingEdges } from './flow-doc.ts'
import { flowIdOf, forgetFlow, loadFlowState, recordUpdate, roomOf, storeFlowState } from './persistence.ts'
import { checkQuota, forgetQuota, quotaLocked, COLLAB_LIMITS } from './quota.ts'

/**
 * 协同服务端 —— [Hocuspocus](https://tiptap.dev/docs/hocuspocus) 挂在应用自己的 HTTP server 上。
 *
 * **不调 `hocuspocus.listen()`**：那会自己起一个 WebSocket 服务、另占一个端口，
 * 而我们是单进程单端口。走官方的「接管已有 server」路径：自己监听 `upgrade`，
 * 判断路径后交给 crossws，由它调 `hocuspocus.handleConnection()`。
 *
 * **和 Vite HMR 共存**：只接管 `/ws`。其余 upgrade（HMR 的 `vite-hmr`，路径 `/`）
 * 我们不碰 —— Node 的 `upgrade` 是多监听器事件，我们不处理，Vite 自己那个监听器就会收到。
 * crossws 的 node adapter 不自注册监听器，`handleUpgrade` 只在被调用时才动手，
 * 所以「不管」是真的不管，不会把别人的握手吃掉。（已实测：改文件能热更新，且不整页刷新。）
 *
 * 房间名（= 文档名）**不在 URL 里**，而是由 HocuspocusProvider 写进每条消息 ——
 * 这也是它和 y-websocket 线协议不兼容的地方，所以前端必须用 `@hocuspocus/provider`。
 */

/** WebSocket 挂载点。房间名走消息，不走路径 */
export const COLLAB_PATH = '/ws'

/** 连接上下文：`onConnect` 认定的身份。后续 hook（审计、awareness 改写）都读它 */
export interface CollabContext {
  /** 服务端在握手时认定的用户；客户端伪造不了。未启用登录时为 null */
  identity: CollabIdentity | null
}

export interface CollabOptions {
  /**
   * 非 `/ws` 的 upgrade 要不要直接断开。
   * dev 下必须是 false —— Vite 的 HMR 走同一个事件，掐了就没有热更新了。
   */
  destroyUnmatchedUpgrades?: boolean
}

/** 这个 upgrade 请求是冲协同来的吗 */
function isCollabUpgrade(url: string): boolean {
  const { pathname } = new URL(url, 'http://localhost')
  return pathname === COLLAB_PATH || pathname.startsWith(`${COLLAB_PATH}/`)
}

/** 当前进程的协同实例；监控端点要读它，没必要一路把引用传下去 */
let instance: Hocuspocus | null = null

/**
 * 成员资格复验的间隔。
 *
 * `onConnect` 只在握手时跑一次 —— 没有这道复验的话，被移出项目、或已在 Keycloak
 * 登出的用户，只要 WebSocket 不断就能无限期继续读写（老 REST 路径每次写都会过
 * `requireFlowMember`，这个保证得有人接替）。每分钟对**开着的房间**重查一遍，
 * 量级是「在线协作者数」，很小。
 */
const REAUTH_INTERVAL = 60_000

/** 这一条消息超限、临时被置为 readOnly 的连接 —— `afterHandleMessage` 里恢复 */
const oversizedFrame = new WeakSet<Connection>()

/** 把一个房间的所有连接锁成只读（顶到配额硬限时用） */
function lockConnections(document: Document): void {
  document.connections.forEach((_clients, connection) => {
    connection.readOnly = true
  })
}

/**
 * 对所有在线连接重查一遍会话 + 项目成员身份，查不过的踢下线。
 *
 * 只有**确凿的拒绝**（会话没了、被移出项目）才踢 —— `authorizeCollab` 抛异常
 * 说明基础设施出了问题（数据库、Keycloak 连不上），证明不了任何事，连接留着，
 * 下一轮再查。和 `auth/session.ts` 对刷新失败的态度是同一条：没有证据不杀会话。
 *
 * 被踢的 provider 会自动重连，但重连的握手会在 `onConnect` 被同一套检查拒掉。
 */
async function revalidateConnections(hocuspocus: Hocuspocus): Promise<void> {
  for (const document of hocuspocus.documents.values()) {
    // 同一份 cookie 在一轮里只查一次 —— 同一个人开多个标签页很常见
    const verdicts = new Map<string, Promise<boolean>>()
    const doomed: Connection[] = []
    const checks: Promise<void>[] = []

    document.connections.forEach((_clients, connection) => {
      const cookie = connection.request?.headers?.get?.('cookie') ?? ''
      let verdict = verdicts.get(cookie)
      if (!verdict) {
        verdict = authorizeCollab(cookie, document.name).then(
          (result) => result.ok,
          () => true,
        )
        verdicts.set(cookie, verdict)
      }
      checks.push(
        verdict.then((ok) => {
          if (!ok) doomed.push(connection)
        }),
      )
    })

    await Promise.all(checks)
    for (const connection of doomed) {
      console.warn(`[collab] ${document.name} 的连接复验未通过，断开`)
      connection.close({ code: 4403, reason: 'permission-revoked' })
    }
  }
}

export function attachCollabServer(server: ServerType, options: CollabOptions = {}) {
  const { destroyUnmatchedUpgrades = true } = options

  const hocuspocus = new Hocuspocus({
    name: 'flow-collab',

    /**
     * 握手鉴权。对**每条**连接都跑（`onAuthenticate` 是 token 模型，只在客户端
     * 主动要求认证时才跑，我们用的是 httpOnly cookie，所以走这里）。
     * 抛异常就是拒绝；返回值成为 context，后面的 hook 都能读到。
     */
    async onConnect(data) {
      const result = await authorizeCollab(
        data.requestHeaders.get('cookie'),
        data.documentName,
      )
      if (!result.ok) {
        console.warn(`[collab] 拒绝无权限的连接：${data.documentName}`)
        throw new Error('Unauthorized')
      }
      return { identity: result.identity } satisfies CollabContext
    },

    /**
     * 内容配额的**拦截点** —— 消息还没应用，拦住就等于没发生；
     * 一旦应用并广播出去，Yjs 是收不回来的。
     *
     * **这里绝不 `throw`**：Hocuspocus 对被 throw 的消息直接关连接，而 provider
     * 会自动重连再发同一条消息 —— 超限的房间就此对所有人不可达，攒了大改动的
     * 离线客户端则陷入永久重连死循环。拒绝走 `readOnly`：Hocuspocus 对只读连接的
     * SyncStep2 / Update 回 NACK 但**不应用也不断连**，读和 awareness 照常。
     */
    async beforeHandleMessage(data) {
      if (data.update.byteLength > COLLAB_LIMITS.message) {
        // 只拒这一条：临时置只读，afterHandleMessage 里恢复。
        // awareness 帧不受 readOnly 约束，所以再做个标记，交给 beforeHandleAwareness 丢弃
        console.warn(
          `[collab] ${data.documentName} 收到 ${data.update.byteLength} 字节的超限消息，拒绝这一条`,
        )
        oversizedFrame.add(data.connection)
        data.connection.readOnly = true
        return
      }
      // 顶到硬限的房间：连接锁成只读，散场重开前不再接受写入
      if (quotaLocked(data.documentName)) data.connection.readOnly = true
    },

    /** 临时只读只管一条消息；房间没被锁的话这里恢复 */
    async afterHandleMessage(data) {
      if (!oversizedFrame.delete(data.connection)) return
      if (!quotaLocked(data.documentName)) data.connection.readOnly = false
    },

    /**
     * awareness 的两道防线（见 `awareness.ts`）：
     * 先把冒用别人 clientID 的条目整条丢掉，再把身份字段换成服务端认定的那份。
     * 超限帧（beforeHandleMessage 标记的）整帧丢弃 —— readOnly 拦不住 awareness。
     */
    async beforeHandleAwareness(data) {
      if (data.connection && oversizedFrame.has(data.connection)) {
        data.states.clear()
        return
      }
      if (data.connection) {
        dropForeignClients(data.documentName, data.socketId, data.states)
      }
      enforceIdentity(data.states, (data.context as CollabContext | undefined)?.identity ?? null)
    },

    /** 房间建起来时把库里的状态灌进去（`ydoc` 为空的老画布在这里迁移） */
    async onLoadDocument(data) {
      const state = await loadFlowState(data.documentName)
      if (state) Y.applyUpdate(data.document, state, 'persistence')
      return data.document
    },

    /**
     * 落库。Hocuspocus 自带防抖（下面的 `debounce` / `maxDebounce`），
     * 并且在最后一个人离开、以及 `destroy()` 时都会保证再存一次 ——
     * 这一整套时机以前是我们自己写的。
     */
    async onStoreDocument(data) {
      // 落库前先把并发产生的悬空边清掉，别让垃圾一路存进库里
      const pruned = pruneDanglingEdges(data.document)
      if (pruned > 0) {
        console.log(`[collab] ${data.documentName} 清理了 ${pruned} 条悬空连线`)
      }
      // 人走光了才顺带更新派生投影：那时的内容是这一轮编辑的最终态，
      // 而且没人会在别人编辑的同一秒去看列表页
      await storeFlowState(data.documentName, data.document, {
        projection: data.clientsCount === 0,
      })
    },

    /**
     * 房间要卸载了 —— **投影的兜底写入点**。
     *
     * 光靠 `onStoreDocument` 的 `clientsCount === 0` 不够：最后一个人离开时，
     * Hocuspocus 只在「还有挂起的防抖 store」时才补一次 store，否则直接卸载文档。
     * 也就是说「改完等两秒再关页面」这条最常见的路径根本不会再触发 onStoreDocument，
     * 投影就永远停在上一次散场时的样子。
     *
     * 这个 hook 在文档销毁**之前**触发，此时内容还读得到。
     */
    async beforeUnloadDocument(data) {
      await storeFlowState(data.documentName, data.document, { projection: true })
    },

    /**
     * 审计：每次客户端改动记一条（Yjs 增量 + 是谁改的）。
     * `context` 就是 `onConnect` 返回的那份，所以 actorId 是服务端认定的，伪造不了。
     */
    async onChange(data) {
      const context = data.context as CollabContext | undefined
      recordUpdate(data.documentName, data.update, context?.identity?.id ?? null)
      // 量一下规模。超软限只是标记（写入照常，删回去自动解除）；
      // 顶到硬限就把整个房间的连接锁成只读，新加入的由 beforeHandleMessage 锁
      if (checkQuota(data.documentName, data.document, data.update.byteLength)) {
        lockConnections(data.document)
      }
    },

    /** 有人离开：释放这条连接认领过的 awareness clientID，重连的新连接才接得上 */
    async onDisconnect(data) {
      releaseSocket(data.documentName, data.socketId)
    },

    /**
     * 房间散场：清掉这个房间的所有进程内缓存 —— 配额判定、awareness 归属登记、
     * 审计 seq 和上次落库的状态向量（`forgetFlow`）。最后那对不清的话，进程会按
     * 打开过的画布数量无限攒缓存；库要是被进程外改过（备份恢复、手工清理），
     * 过期的 seq 还会撞 `@@unique([flowId, seq])`，过期的状态向量会让下一轮
     * 误判「和上次一样」而跳过首次落库。
     */
    async afterUnloadDocument(data) {
      forgetQuota(data.documentName)
      forgetClaims(data.documentName)
      forgetFlow(data.documentName)
    },

    /** 攒够一小段时间再广播，重编辑时能把每连接每次变更的消息数压下来 */
    flushDelay: 30,

    /** 有改动后最多攒 2s 落一次库；持续编辑时最长 10s 一定落一次 */
    debounce: 2000,
    maxDebounce: 10000,
  })

  const ws = crossws({
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(
          peer.websocket as never,
          peer.request as never,
        )
        ;(peer as unknown as { _collab?: unknown })._collab = connection
      },
      message(peer, message) {
        const connection = (
          peer as unknown as { _collab?: { handleMessage(data: Uint8Array): void } }
        )._collab
        connection?.handleMessage(message.uint8Array())
      },
      close(peer, event) {
        const connection = (
          peer as unknown as {
            _collab?: { handleClose(event: { code: number; reason: string }): void }
          }
        )._collab
        connection?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' })
      },
    },
  })

  server.on('upgrade', (req, socket, head) => {
    if (!isCollabUpgrade(req.url ?? '/')) {
      // 不是我们的：dev 下留给 Vite 的 HMR 监听器，prod 下没人要就断开
      if (destroyUnmatchedUpgrades) socket.destroy()
      return
    }
    void ws.handleUpgrade(req, socket, head)
  })

  // 成员资格复验：被移出项目 / 会话已灭的人不能靠一条不断的 WebSocket 一直留在房间里
  const reauthTimer = setInterval(() => {
    void revalidateConnections(hocuspocus).catch((err: unknown) =>
      console.error('[collab] 连接复验失败', err),
    )
  }, REAUTH_INTERVAL)
  reauthTimer.unref()

  instance = hocuspocus
  return hocuspocus
}

/** 监控端点用：现在有哪些房间、各自几条连接 */
export function collabStats() {
  if (!instance) return { rooms: [], totalRooms: 0, totalConnections: 0 }

  const rooms = [...instance.documents.entries()].map(([name, document]) => ({
    name,
    connections: document.getConnectionsCount(),
    awarenessClients: document.awareness.getStates().size,
    flowId: flowIdOf(name),
  }))
  return {
    rooms,
    totalRooms: rooms.length,
    totalConnections: rooms.reduce((sum, room) => sum + room.connections, 0),
  }
}

/**
 * 把某张画布**还开着的房间**立刻落一次库。
 *
 * 内容的事实源是内存里的 Y.Doc，库里那份 `ydoc` 只在防抖窗口和散场时更新。
 * 凡是要**读库里的内容**再做事的接口（复制画布…），都得先叫一次这个，
 * 否则拿到的是上一次写入时的样子。房间没开着就什么也不用做。
 */
export async function flushRoomToDatabase(flowId: string): Promise<void> {
  const document = instance?.documents.get(roomOf(flowId))
  // 带上投影：调用方（复制画布）读的正是 `graph` 那份，不写就会拿到上一轮的样子
  if (document) await storeFlowState(document.name, document, { projection: true })
}

/**
 * 把**所有**还开着的房间落一次库 —— 进程退出前用。
 *
 * 不走 `flushPendingStores()`：它只是把防抖中的 `onStoreDocument` 掐点执行，
 * 触发到真正入队之间隔着一段微任务链，退出流程同步往下走就会在入队**之前**
 * 采样到空队列，最后一个防抖窗口（最多 2–10 秒）的编辑就这样丢在内存里 ——
 * 每次滚动部署都可能踩到。这里直接对每个房间 `storeFlowState` 并 await 到写完，
 * 没有中间层，没有竞态。
 */
export async function flushAllRoomsToDatabase(): Promise<void> {
  if (!instance) return
  await Promise.all(
    [...instance.documents.values()].map((document) =>
      storeFlowState(document.name, document, { projection: true }),
    ),
  )
}
