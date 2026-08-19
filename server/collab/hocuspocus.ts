import type { ServerType } from '@hono/node-server'
import { Hocuspocus, type Connection, type Document, type Extension } from '@hocuspocus/server'
import crossws from 'crossws/adapters/node'
import * as Y from 'yjs'

import {
  authorizeCollab,
  isAllowedCollabOrigin,
  type CollabAuthorization,
  type CollabDenialReason,
  type CollabIdentity,
} from '../auth/ws.ts'
import { instanceId, isClustered, redisKeyPrefix, redisUrl } from '../config.ts'
import { dropForeignClients, enforceIdentity, forgetClaims, releaseSocket } from './awareness.ts'
import { CLOSE_REVOKED, CLOSE_UNAUTHORIZED, closeForGood, denialError } from './close.ts'
import {
  EXCLUSIVE_SWEEP_INTERVAL,
  claimExclusive,
  enforceExclusive,
  forgetExclusive,
  releaseExclusive,
  type ExclusiveDocument,
} from './exclusive.ts'
import { pruneDanglingEdges } from './flow-doc.ts'
import {
  REVOCATION_POLL_INTERVAL,
  announceRevocation,
  createRevocationWatcher,
} from './revocation.ts'
import { flowIdOf, forgetFlow, loadFlowState, recordUpdate, roomOf, storeFlowState } from './persistence.ts'
import { checkQuota, forgetQuota, quotaLocked, COLLAB_LIMITS } from './quota.ts'
import { scopedSocketId } from './socket-id.ts'

/**
 * 协同服务端 —— [Hocuspocus](https://tiptap.dev/docs/hocuspocus) 挂在应用自己的 HTTP server 上。
 *
 * **不调 `hocuspocus.listen()`**：那会自己起一个 WebSocket 服务、另占一个端口，
 * 而我们是单进程单端口。走官方的「接管已有 server」路径：自己监听 `upgrade`，
 * 判断路径后交给 crossws，由它调 `hocuspocus.handleConnection()`。
 *
 * **和 Vite HMR 共存**：只接管 `/ws/collaboration`。其余 upgrade（HMR 的 `vite-hmr`，路径 `/`）
 * 我们不碰 —— Node 的 `upgrade` 是多监听器事件，我们不处理，Vite 自己那个监听器就会收到。
 * crossws 的 node adapter 不自注册监听器，`handleUpgrade` 只在被调用时才动手，
 * 所以「不管」是真的不管，不会把别人的握手吃掉。（已实测：改文件能热更新，且不整页刷新。）
 *
 * 房间名（= 文档名）**不在 URL 里**，而是由 HocuspocusProvider 写进每条消息 ——
 * 这也是它和 y-websocket 线协议不兼容的地方，所以前端必须用 `@hocuspocus/provider`。
 */

/** WebSocket 挂载点。房间名走消息，不走路径 */
export const COLLAB_PATH = '/ws/collaboration'

/** 连接上下文：`onConnect` 认定的身份。后续 hook（审计、awareness 改写）都读它 */
export interface CollabContext {
  /** 服务端在握手时认定的用户；客户端伪造不了。未启用登录时为 null */
  identity: CollabIdentity | null
}

export interface CollabOptions {
  /**
   * 非 `/ws/collaboration` 的 upgrade 要不要直接断开。
   * dev 下必须是 false —— Vite 的 HMR 走同一个事件，掐了就没有热更新了。
   */
  destroyUnmatchedUpgrades?: boolean
}

/**
 * 这条更新该不该记一行审计。
 *
 * Hocuspocus 的 `transactionOrigin` 说明这条更新是打哪儿来的：
 * `connection`（这个实例上的客户端发来的）、`redis`（别的实例经 pub/sub 转发过来的）、
 * `local`（服务端自己改的，比如 DirectConnection）。
 *
 * **`redis` 的不记**：多副本下同一条更新会转发到每个持有这个房间的实例，
 * 每个都触发一次 `onChange`。照单全收的话审计表就成了实例数的倍数
 * （两个实例、11 次改动，实测写出 22 行），而且转发来的那条手里没有作者的
 * `context`，`actorId` 只能是 null —— 记下来也没有信息量。
 * 谁收到客户端的消息，谁负责记这一笔。
 */
export function shouldRecordUpdate(transactionOrigin: unknown): boolean {
  const source = (transactionOrigin as { source?: string } | undefined)?.source
  return source !== 'redis'
}

/** 这个 upgrade 请求是冲协同来的吗 */
function isCollabUpgrade(url: string): boolean {
  const { pathname } = new URL(url, 'http://localhost')
  return pathname === COLLAB_PATH || pathname.startsWith(`${COLLAB_PATH}/`)
}

/** 当前进程的协同实例；监控端点要读它，没必要一路把引用传下去 */
let instance: Hocuspocus | null = null

/**
 * 成员资格复验的间隔 —— 也就是**权限被收回后还能继续写多久**的上限。
 *
 * `onConnect` 只在握手时跑一次，没有这道复验的话，被移出项目、或已在 Keycloak
 * 登出的用户，只要 WebSocket 不断就能无限期继续读写（老 REST 路径每次写都会过
 * `requireFlowMember`，这个保证得有人接替）。
 *
 * 这个数就是在「窗口期」和「查询量」之间挑一个点，两头都是线性的：
 * 一轮的成本是**每个房间、每个不同 cookie** 三次数据库查询（会话 + 画布归属 + 成员角色，
 * `refresh: false` 所以不碰 Keycloak），量级是「在线协作者数」；把间隔减半，
 * 窗口期减半、查询量翻倍。
 *
 * 取 20 秒：被移出项目的人最多再写 20 秒，而不是一分钟。没有取更小的值，是因为再往下
 * 收益已经很薄 —— 内容是 CRDT、每条改动都进审计表（带服务端认定的 `actorId`）、
 * 想要「立刻」得换成登出时主动广播踢线，那是另一套机制，不是把这个数调小能得到的。
 */
const REAUTH_INTERVAL = 20_000

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
 * **`refresh: false` 是这里的关键**：复验只「看」，不给会话续命。它背后没有任何
 * 用户动作，每分钟续一次的话，开着画布不动的人就永远不会空闲超时 —— 长连接
 * 自己把自己续活了。续期归真实的 HTTP 请求管：有人真的动了画布，
 * `stores/flow` 的 `noteLocalEdit()` 会 PATCH 一次视图状态，那一趟才重置空闲计时。
 * 于是「在编辑 = 会话续着」「只挂着不动 = 该超时就超时」。
 *
 * 被踢的 provider 会自动重连，但重连的握手会在 `onConnect` 被同一套检查拒掉。
 */
async function revalidateDocument(document: Document): Promise<void> {
  // 同一份 cookie 在一轮里只查一次 —— 同一个人开多个标签页很常见
  const verdicts = new Map<string, Promise<CollabAuthorization>>()
  const doomed: { connection: Connection; reason: CollabDenialReason }[] = []
  const checks: Promise<void>[] = []

  document.connections.forEach((_clients, connection) => {
    const cookie = connection.request?.headers?.get?.('cookie') ?? ''
    let verdict = verdicts.get(cookie)
    if (!verdict) {
      verdict = authorizeCollab(cookie, document.name, { refresh: false }).catch(
        // 抛异常 = 基础设施出问题，证明不了任何事：当作通过，下一轮再查
        (): CollabAuthorization => ({ ok: true, identity: null }),
      )
      verdicts.set(cookie, verdict)
    }
    checks.push(
      verdict.then((result) => {
        if (!result.ok) doomed.push({ connection, reason: result.reason })
      }),
    )
  })

  await Promise.all(checks)
  for (const { connection, reason } of doomed) {
    console.warn(`[collab] ${document.name} 的连接复验未通过（${reason}），断开`)
    /*
     * **按原因分别关**，别一律当成「被移出项目」。只看不编辑的人本来就会空闲超时
     * （复验故意不续期，见上），那种人该收到的是「登录态过期，请重新登录」——
     * 前端据此弹全站的会话过期确认框，登录完就地重连，画布连刷新都不用。
     * 一律发 `permission-revoked` 的话，他看到的是「你已不是这个项目的成员」，纯属冤枉。
     *
     * 两条腿一起关：只发 CLOSE 消息的话 socket 还开着，客户端要等到下一次心跳
     * 被重新鉴权时才知道自己没了 —— 那期间它以为一切正常。
     */
    closeForGood(connection, reason === 'unauthorized' ? CLOSE_UNAUTHORIZED : CLOSE_REVOKED)
  }
}

/** 上一轮还没跑完 —— 重入保护和「跑完了吗」都读它 */
let revalidating: Promise<void> | null = null

async function revalidateConnections(hocuspocus: Hocuspocus): Promise<void> {
  /*
   * **重入保护**：这是个 async 回调挂在 `setInterval` 上，房间多、数据库慢的时候
   * 一轮可能超过一个间隔，下一轮就会叠上来 —— 数据库压力翻倍，同一批连接被重复查。
   * 立刻踢线那条路（`revokeCollabAccess`）也走这个函数，叠加的可能性只增不减。
   * 已经在跑就复用那一轮：调用方等到的是「有一轮完整的复验跑完了」，语义正好。
   */
  if (revalidating) return revalidating

  revalidating = (async () => {
    try {
      /*
       * 房间之间**并行**。以前是串行 await，于是第 N 个房间要等前 N-1 个查完，
       * `REAUTH_INTERVAL` 就只是个下界而不是上界 —— 房间一多，最后那个房间的实际
       * 窗口期是「间隔 + 前面所有房间的耗时」，而那正是我们想拿来当保证的数。
       */
      await Promise.all([...hocuspocus.documents.values()].map(revalidateDocument))
    } finally {
      revalidating = null
    }
  })()

  return revalidating
}

/**
 * **立刻**把权限已被收回的连接踢下线，本实例和其它实例都算。
 *
 * 改权限的路由（移除成员、删项目、删画布）在写库成功之后调它。不调也不会出错 ——
 * `REAUTH_INTERVAL` 的轮询终究会发现 —— 但那意味着被移除的人还有一整轮的时间继续编辑，
 * 而他在那段时间里改的东西会被 CRDT 合并、落库，**且其他人撤销不回来**
 * （`Y.UndoManager` 只跟踪自己的 origin）。所以这条路径是主路径，轮询降级为兜底。
 *
 * 两件事的顺序无所谓，但两件都要做：
 * - `announceRevocation()` —— 广播给别的实例，它们最迟一个巡检周期（3s）后跟上；
 * - 本地跑一轮完整复验 —— 本实例上的连接当场断掉。
 *
 * **是 await 而不是即发即忘**：这样 `DELETE …/members/:userId` 返回 204 的时候，
 * 「这个人已经不在画布上了」是成立的。权限变更本来就罕见，管理员那一个请求多等几毫秒
 * 换一个能讲清楚的契约，划算。
 */
export async function revokeCollabAccess(): Promise<void> {
  await announceRevocation()
  if (instance) await revalidateConnections(instance)
}

/**
 * 多副本模式下的房间同步。
 *
 * 单副本时房间的 `Y.Doc` 只活在这个进程的内存里 —— 两个 Pod 各持一份互不通信的副本，
 * 各自把**自己**那份全量写进同一行 `ydoc`，后写的把先写的整段盖掉（覆盖写，不是合并），
 * 那是真丢数据。官方的 redis extension 把三件事一起解决了：
 *
 * - 文档更新和 awareness 经 pub/sub 在实例间转发；
 * - `onStoreDocument` 用 redlock 去重，同一房间同一时刻只有一个实例真的落库；
 * - `afterLoadDocument` 会等别的实例把内存里的当前状态推过来（`awaitInitialSyncTimeout`），
 *   否则刚接手的实例会拿库里那份旧的去服务客户端。
 *
 * **动态 import**：单副本进程里这个包连加载都不会发生，构建产物也不带它。
 */
async function collabExtensions(): Promise<Extension[]> {
  if (!isClustered) return []

  const { Redis } = await import('@hocuspocus/extension-redis')
  const url = new URL(redisUrl)

  return [
    new Redis({
      host: url.hostname,
      port: Number(url.port || 6379),
      options: {
        password: url.password || undefined,
        db: Number(url.pathname.slice(1)) || 0,
      },
      // 实例名要真的唯一 —— 它是「这条消息是不是我自己发的」的判据
      identifier: instanceId,
      prefix: `${redisKeyPrefix}:hp`,
    }),
  ]
}

export async function attachCollabServer(server: ServerType, options: CollabOptions = {}) {
  const { destroyUnmatchedUpgrades = true } = options

  const hocuspocus = new Hocuspocus({
    name: 'flow-collab',
    extensions: await collabExtensions(),

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
        console.warn(`[collab] 拒绝连接（${result.reason}）：${data.documentName}`)
        // 原因要挂在错误的 `reason` 上带给客户端 —— 这条路不发关闭码，见 `close.ts`
        throw denialError(result.reason === 'unauthorized' ? CLOSE_UNAUTHORIZED : CLOSE_REVOKED)
      }
      return { identity: result.identity } satisfies CollabContext
    },

    /**
     * 连接真正建起来了（此时它已经挂在文档上，`context` 也定了）——
     * **单连接互斥**在这里落地：把持有者改成这条新连接，然后把这个房间里
     * 同一个人的旧连接顶下线（见 `exclusive.ts`）。
     *
     * 放在 `connected` 而不是 `onConnect`：那会儿连接对象还没建，也还没进
     * `document.connections`，既拿不到要踢的对象，也可能把自己一起踢了。
     */
    async connected(data) {
      const document: ExclusiveDocument = data.connection.document
      await claimExclusive(data.documentName, data.connection)
      // 本实例的那半当场生效；别的实例上的旧连接由巡检收敛
      await enforceExclusive([document])
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
        await dropForeignClients(data.documentName, scopedSocketId(data.socketId), data.states)
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
     * 别的实例转发过来的更新不重复记，判据见 {@link shouldRecordUpdate}。
     */
    async onChange(data) {
      if (shouldRecordUpdate(data.transactionOrigin)) {
        const context = data.context as CollabContext | undefined
        recordUpdate(data.documentName, data.update, context?.identity?.id ?? null)
      }
      // 量一下规模。超软限只是标记（写入照常，删回去自动解除）；
      // 顶到硬限就把整个房间的连接锁成只读，新加入的由 beforeHandleMessage 锁
      if (checkQuota(data.documentName, data.document, data.update.byteLength)) {
        lockConnections(data.document)
      }
    },

    /**
     * 有人离开：释放这条连接认领过的 awareness clientID（重连的新连接才接得上），
     * 以及它可能占着的单连接持有者登记。
     */
    async onDisconnect(data) {
      await releaseSocket(data.documentName, scopedSocketId(data.socketId))
      await releaseExclusive(data.documentName, data.socketId)
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
      forgetExclusive(data.documentName)
      await forgetClaims(data.documentName)
      await forgetFlow(data.documentName)
    },

    /**
     * 多久没收到客户端的消息就掐掉这条连接。
     *
     * **它不是 ping 间隔** —— Hocuspocus 服务端不发心跳，这个定时器只比对
     * 「最后一次收到消息」的时刻。真正的心跳是 y-protocols 的 awareness 重播：
     * 本地状态每 `outdatedTimeout / 2` = **15 秒**重发一次（`useFlowPresence` 一连上就
     * `setLocalStateField('user', …)`，所以这条一直在跑），而服务端的 awareness 广播
     * **不排除发送者** —— 于是一来一回，两个方向各有一趟 15 秒的流量。
     * 反代的空闲超时（nginx / k8s Ingress 默认都是 60s）由此被撑住，我们不用另外发包。
     *
     * 取 30 秒 = 容忍连丢两拍，正好和客户端的 `messageReconnectTimeout`（provider
     * 默认 30s）对齐：两边在同一时刻放弃，谁也不会长时间抱着一条已经死掉的连接。
     * 默认的 60s 太松 —— 那条连接还占着单连接互斥的持有者位置、在场栏里还挂着一个
     * 幽灵光标。压到反代的 60s 以下还有一个用处：真断了是**我们**先发现、先跑
     * `onDisconnect`（释放持有者、清 awareness 归属），而不是等中间层悄悄掐掉。
     */
    timeout: 30_000,

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
    /*
     * 跨站握手在这里就挡掉，进不到 `onConnect`。
     * upgrade 是裸的 node 事件，Hono 那条中间件链（CORS、页面守卫）一个都没经过，
     * 所以 CSWSH 这道只能自己判 —— 见 `auth/ws.ts` 的 `isAllowedCollabOrigin`。
     * 回一行 403 再断开：配错 `APP_ORIGIN` 时，这比一个 TCP reset 好查得多。
     */
    if (!isAllowedCollabOrigin(req.headers.origin, req.headers.host)) {
      console.warn(`[collab] 拒绝来自 ${req.headers.origin} 的跨站握手`)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
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

  /*
   * 单连接互斥的巡检。新连接接入时 `connected` 已经把**本实例**的旧连接踢掉了，
   * 这个定时器管的是另外两件事：把连在别的实例上的旧连接收敛掉（多副本），
   * 以及给活着的持有者续期、补回丢失的登记。
   */
  const exclusiveTimer = setInterval(() => {
    void enforceExclusive(
      hocuspocus.documents.values(),
    ).catch((err: unknown) => console.error('[collab] 单连接巡检失败', err))
  }, EXCLUSIVE_SWEEP_INTERVAL)
  exclusiveTimer.unref()

  /*
   * 别的实例上有人被移除权限了吗。只读共享层的一个键（内存模式下就是一次 Map 查询），
   * 变了才跑复验 —— 权限变更罕见，所以这个定时器平时什么都不做。
   * 它管的是**跨实例**那半：写权限的那个实例当场就把本地的踢了（`revokeCollabAccess`），
   * 人挂在别的 Pod 上时就靠这里，延迟一个轮询周期。
   */
  const watcher = createRevocationWatcher()
  const revocationTimer = setInterval(() => {
    void watcher
      .changed()
      .then((changed) => (changed ? revalidateConnections(hocuspocus) : undefined))
      .catch((err: unknown) => console.error('[collab] 权限撤销广播处理失败', err))
  }, REVOCATION_POLL_INTERVAL)
  revocationTimer.unref()

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
