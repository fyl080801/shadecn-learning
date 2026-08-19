import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue"
import { useOnline } from "@vueuse/core"
import * as Y from "yjs"
import { HocuspocusProvider } from "@hocuspocus/provider"
import { IndexeddbPersistence } from "y-indexeddb"
import { nodesMap } from "@/lib/flow-doc"
import { requestReLogin, useAuth } from "@/lib/auth"

/**
 * 画布协同的**连接层**：一张画布一个房间、一个 `Y.Doc`、一条 WebSocket。
 *
 * 这个 `Y.Doc` 就是**画布内容的事实源**：
 * - 内容 —— `stores/flow` 直接把它接过去，节点和边是它的响应式投影；
 * - 在场 —— `useFlowPresence` 用它的 awareness（谁在线、鼠标在哪、选中了谁）。
 *
 * 两者共用同一条连接，所以连接的建立 / 销毁只写在这里一处。上层不直接碰 provider，
 * 而是 `watch(session)`：换画布、断线重连都会给出一个新的 session，
 * 上层照着重新挂钩子即可，不用自己管生命周期。
 *
 * 没有「保存」这一步：改动进 Y.Doc 就会自动同步给同房间的人，
 * 服务端订阅同一条流并落库（`server/collab/persistence.ts`）。
 *
 * 同一个 `Y.Doc` 还挂了一份 **IndexedDB 本地缓存**（`y-indexeddb`）。它带来两件事：
 * 打开画布时先从本地渲染（不用等网络），以及**断网时改的东西不会随刷新丢掉** ——
 * 重连后本地那些改动会自动补发出去，CRDT 负责合并，不需要用户做任何事。
 *
 * 服务端是 Hocuspocus，所以这里必须用 `@hocuspocus/provider` 而不是 y-websocket ——
 * 两者线协议不兼容：Hocuspocus 的每条消息以文档名开头，房间名走消息不走 URL。
 * 身份也不走 `token`：我们用的是 httpOnly 的 sid cookie，握手时浏览器自动带上，
 * 服务端在 `onConnect` 里读它（见 `server/auth/ws.ts`）。
 */

/** WebSocket 挂载点，和后端 `COLLAB_PATH` 一致。房间名不在路径里 */
const COLLAB_PATH = "/ws/collaboration"

/** 房间名前缀；服务端靠它认出「这是某张画布的房间」并去查项目成员身份 */
const FLOW_ROOM_PREFIX = "flow:"

/**
 * **终局关闭**：这条连接不会自己好，重连也只会被同样地拒掉。
 *
 * 三种原因、三条出路，所以必须分得开 —— 一律显示「已离线，恢复连接后自动同步」
 * 是最坏的一种处理：provider 默认无限重连（`maxAttempts: 0`），用户会对着一句
 * 「稍后自动同步」继续画，而那些改动只进得了本地 IndexedDB，永远发不出去。
 */
export type FatalClose =
  /** 自己在别处开了新窗口，这一条被顶下线（`server/collab/exclusive.ts`）。刷新即可接管回来 */
  | "superseded"
  /** 登录态没了。走全站那套「会话过期」确认框，登录完原地重连 */
  | "unauthorized"
  /** 还登着，但已经不是这个项目的成员了（复验踢的）。没有自救路径 */
  | "forbidden"

/**
 * 判断一个终局信号是哪一种；不是终局的返回 `null`。
 *
 * **服务端有两条完全不同的路把这件事告诉我们**，而且都得认：
 *
 * 1. **连接已经建起来之后被关掉** —— 顶下线、复验没过。服务端两条腿一起发
 *    （见 `server/collab/close.ts`）：CLOSE **消息**只带 reason（code 被 provider
 *    填成 1000），随后的 WebSocket **关闭帧**才带真正的 4xxx。
 * 2. **握手当场被拒** —— `onConnect` 抛异常。这条路**既不关 socket 也没有关闭码**：
 *    Hocuspocus 只回一条 `PermissionDenied` 消息，provider 把它变成
 *    `onAuthenticationFailed({ reason })`。所以这里只有 reason 可用。
 *
 * 两条路共用同一套 reason 字符串，正是为了这个函数能同时服务两边 —— 不然就要维护
 * 两张映射表。**reason 才是通用判据，code 只在关闭帧上有效**。
 *
 * 认错的代价不对称：漏认 → 无限重连（被顶下线的话还会反过来踢掉用户真正在用的窗口）；
 * 错认 → 本来能自动恢复的普通断线被判了死刑。所以只认明确的信号，1006 之类一律不算。
 */
export function classifyClose(
  event: { code?: number; reason?: string } | undefined
): FatalClose | null {
  if (!event) return null
  const { code, reason } = event
  if (code === 4409 || reason === "session-superseded") return "superseded"
  // "Unauthorized" 同时是 Hocuspocus 内置的 4401 和我们握手拒绝时送的 reason
  if (code === 4401 || reason === "Unauthorized") return "unauthorized"
  // 4403 / "permission-revoked"：复验踢人，以及握手时判定「不是这个项目的成员」
  if (code === 4403 || reason === "permission-revoked") return "forbidden"
  return null
}

/**
 * 测试环境（jsdom）里没有真的服务端，连上去只会无限重连刷日志 ——
 * 和 `src/test/setup.ts` 把 fetch 换成必然 reject 的桩是同一个用意：测试不碰网络。
 * 本地缓存同理：jsdom 没有可用的 IndexedDB。
 */
const CAN_CONNECT = typeof window !== "undefined" && import.meta.env.MODE !== "test"

/** 一次连接。换房间或重建连接都会换一个新的 */
export interface CollabSession {
  /** yjs 的客户端号；同一个人开两个标签页也是两个号 */
  clientId: number
  /** 画布内容就住在这里；`stores/flow` 接管它 */
  doc: Y.Doc
  awareness: NonNullable<HocuspocusProvider["awareness"]>
  /**
   * 和**服务端**的首次同步是否完成。到这一刻文档才保证是最新的。
   */
  synced: Ref<boolean>
  /**
   * **本地缓存**（IndexedDB）是否已经灌进文档。
   *
   * 和 `synced` 分开是因为两者回答的是不同的问题：`cached` 说的是「有没有东西可以先画出来」，
   * `synced` 说的是「画出来的是不是最新的」。断网打开一张来过的画布时，
   * 只有前者会为真 —— 这正是离线可用的意思。
   */
  cached: Ref<boolean>
  /** 文档里到底有没有内容 —— 用来区分「缓存是空的」和「这张画布本来就是空的」 */
  hasContent: Ref<boolean>
}

/** 从当前页面推导 ws 地址：前后端同源同端口，不能硬编码 host */
function collabUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${COLLAB_PATH}`
}

export function useFlowCollab(flowId: Ref<string>) {
  let doc: Y.Doc | null = null
  let provider: HocuspocusProvider | null = null
  let offline: IndexeddbPersistence | null = null

  /** provider 自己报的连接状态 */
  const linked = ref(false)

  /**
   * 这条连接被服务端**终局**关掉了，以及为什么（`null` = 没有）。
   *
   * 和「断线」是两回事，所以绝不能混进 `connected`：断线会自动重连、改动会补发，
   * 用户什么都不用做；终局关闭则是这个窗口不再同步，而且不会自己好。
   * 界面按原因给出不同的出路 —— 刷新 / 重新登录 / 离开，见 `useFlowDocument` 的
   * `syncText` 和 `FlowConnectionEndedDialog.vue`。
   */
  const fatal = ref<FatalClose | null>(null)

  /**
   * 网卡说自己通不通。
   *
   * 单看 provider 的状态不够：拔网线之后它要等心跳超时（默认几十秒）才察觉，
   * 这期间界面会一直显示「已同步」，而用户改的东西其实只落在本地。
   * `navigator.onLine` 的反应是即时的 —— 反过来它也不可靠（网卡通不代表连得上服务器），
   * 所以两者**都要为真**才算连着。
   */
  const online = useOnline()

  const connected = computed(() => linked.value && online.value)
  const session = shallowRef<CollabSession | null>(null)

  function teardown() {
    // 顺序要紧：先断网络、再摘本地缓存、最后才销毁文档 ——
    // 反过来的话缓存那边还挂着已销毁文档的 update 监听
    provider?.destroy()
    provider = null
    // 只 destroy 不 clearData：缓存留着，下次打开还能离线用
    void offline?.destroy()
    offline = null
    doc?.destroy()
    doc = null
    linked.value = false
    session.value = null
  }

  function connect(id: string) {
    teardown()
    fatal.value = null
    if (!id || !CAN_CONNECT) return

    doc = new Y.Doc()
    const synced = ref(false)
    const cached = ref(false)
    const hasContent = ref(false)
    const room = `${FLOW_ROOM_PREFIX}${id}`

    const target = doc
    const refreshHasContent = () => {
      hasContent.value = nodesMap(target).size > 0
    }

    // 本地缓存：构造即开始加载，加载完把内容合进同一个文档
    offline = new IndexeddbPersistence(room, doc)
    void offline.whenSynced.then(() => {
      refreshHasContent()
      cached.value = true
    })
    target.on("update", refreshHasContent)

    let created: HocuspocusProvider | null = null

    /**
     * 收到终局信号：记下原因、停掉重连、按原因给出路。两条路（连接被关 / 握手被拒）
     * 都汇到这里，所以行为只写一份。
     *
     * **停重连是必须的**。provider 默认对任何断开都退避重连（`maxAttempts: 0`，无限次），
     * 而这三种原因重连一次都好不了：被顶下线时，重连的握手在服务端看来就是「又开了一个
     * 新窗口」，会把用户真正在用的那个顶掉，两个窗口从此互相踢；另外两种则是每次握手
     * 被同一套检查原样拒回来。握手被拒那条路更要停 —— 它连 socket 都不关，
     * 不管的话会一直挂着一条**连着但没通过认证**的 socket 空转，直到服务端 30 秒超时
     * 掐掉，然后再重连、再空转，无限循环，而界面上一直是「同步中…」。
     *
     * `disconnect()` 只停连接，文档和 awareness 都留着（画面还在，只是不再同步）。
     * 挪到微任务里执行：此刻正在 provider 自己的回调里，不在它的调用栈上拆它。
     */
    function endConnection(reason: FatalClose) {
      fatal.value = reason
      queueMicrotask(() => created?.disconnect())
      /*
       * 登录态没了：交给全站那套「会话过期」确认框（`requestReLogin` → `SessionExpiredDialog`）。
       * 它能在**不离开这一页**的前提下重新登录（内嵌 iframe），所以画布上还没同步出去的
       * 改动不会被一次跳转带走 —— 登录完由下面那个 watch 就地重连，Y.Doc 里攒着的自动补发。
       */
      if (reason === "unauthorized") requestReLogin()
    }

    created = new HocuspocusProvider({
      url: collabUrl(),
      name: room,
      document: doc,
      onStatus: ({ status }) => {
        linked.value = status === "connected"
      },
      onSynced: () => {
        // 断线重连会再同步一次，此时不能退回未同步状态：那之后到达的都是我真的漏掉的
        synced.value = true
        refreshHasContent()
      },
      /** 连接建起来之后被服务端关掉：顶下线、复验没过。普通断线在这里被 `classifyClose` 滤掉 */
      onClose: ({ event }) => {
        const reason = classifyClose(event)
        if (reason) endConnection(reason)
      },
      /**
       * **握手当场被拒**（`onConnect` 抛异常）—— 这条路没有 close 事件，只有这个回调。
       *
       * 「被移出项目后重新打开这张画布」「会话过期后重连」走的都是它，是最常见的
       * 拒绝路径，漏接的代价前面说了：socket 挂着空转、界面永远停在「同步中…」。
       *
       * 认不出的 reason 归为 `forbidden`：Hocuspocus 自己那些拒绝路径会送
       * `permission-denied` 之类，「你进不去」是它们确定的含义，而「你该重新登录」
       * 是更强的断言 —— 猜错了会让一个登录得好好的人对着会话过期框发愣。
       */
      onAuthenticationFailed: ({ reason }) => {
        endConnection(classifyClose({ reason }) ?? "forbidden")
      }
    })
    provider = created

    const awareness = provider.awareness
    if (!awareness) throw new Error("协同连接没有 awareness，在场状态无法工作")

    session.value = {
      clientId: awareness.clientID,
      doc,
      awareness,
      synced,
      cached,
      hasContent
    }
  }

  // 路由在画布之间跳（`/flows/:flowId` 换 id）时换房间，不是重建组件
  watch(flowId, connect, { immediate: true })

  /**
   * 重新登录成功之后就地重连 —— 用户不用刷新，画布上的东西一样不动。
   *
   * 两个条件缺一不可。**必须真的登上了**：确认框还能被关掉（× / Esc / 点遮罩，
   * `dismissReLogin`），那一路 `sessionExpired` 也会变假，此时重连只会再被拒一次、
   * 再弹一次框，来回空转。**必须是 `unauthorized`**：被顶下线和被移出项目跟登录没关系，
   * 重连解决不了，只会把用户正在用的另一个窗口踢掉。
   */
  const { sessionExpired, isAuthenticated } = useAuth()
  watch(sessionExpired, (expired) => {
    if (expired || fatal.value !== "unauthorized" || !isAuthenticated.value) return
    connect(flowId.value)
  })

  onBeforeUnmount(teardown)

  return { connected, session, fatal }
}

export type FlowCollab = ReturnType<typeof useFlowCollab>
