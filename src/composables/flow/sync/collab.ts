import { ref } from "vue"
import { HocuspocusProvider } from "@hocuspocus/provider"
import { requestReLogin } from "@/lib/auth"
import type { FatalClose, FlowTransport, TransportContext } from "./types"

/**
 * 项目画布的传输：一张画布一个房间、一条 WebSocket（REQ-COLLAB）。
 *
 * 这条连接上驮着两件互不相干的事 —— 内容（Y.Doc）和在场（awareness），
 * 所以连接的建立 / 销毁只写在这一处。
 *
 * 没有「保存」这一步：改动进 Y.Doc 就会自动同步给同房间的人，
 * 服务端订阅同一条流并落库（`server/collab/persistence.ts`）。
 *
 * 服务端是 Hocuspocus，所以必须用 `@hocuspocus/provider` 而不是 y-websocket ——
 * 两者线协议不兼容：Hocuspocus 的每条消息以文档名开头，房间名走消息不走 URL。
 * 身份也不走 `token`：我们用的是 httpOnly 的 sid cookie，握手时浏览器自动带上，
 * 服务端在 `onConnect` 里读它（见 `server/auth/ws.ts`）。
 */

/** WebSocket 挂载点，和后端 `COLLAB_PATH` 一致。房间名不在路径里 */
const COLLAB_PATH = "/ws/collaboration"

/** 房间名前缀；服务端靠它认出「这是某张画布的房间」并去查项目成员身份 */
const FLOW_ROOM_PREFIX = "flow:"

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

/** 从当前页面推导 ws 地址：前后端同源同端口，不能硬编码 host */
function collabUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${COLLAB_PATH}`
}

export function createCollabTransport(context: TransportContext): FlowTransport {
  const synced = ref(false)
  const linked = ref(false)
  /** 协同没有「未保存」这回事：改动一进 Y.Doc 就顺着连接走了 */
  const pending = ref(false)

  let provider: HocuspocusProvider | null = null

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
    context.onFatal(reason)
    queueMicrotask(() => provider?.disconnect())
    /*
     * 登录态没了：交给全站那套「会话过期」确认框（`requestReLogin` → `SessionExpiredDialog`）。
     * 它能在**不离开这一页**的前提下重新登录（内嵌 iframe），所以画布上还没同步出去的
     * 改动不会被一次跳转带走 —— 登录完由 `useFlowSync` 那个 watch 就地重连，
     * Y.Doc 里攒着的自动补发。
     */
    if (reason === "unauthorized") requestReLogin()
  }

  provider = new HocuspocusProvider({
    url: collabUrl(),
    name: `${FLOW_ROOM_PREFIX}${context.flowId}`,
    document: context.doc,
    onStatus: ({ status }) => {
      linked.value = status === "connected"
    },
    onSynced: () => {
      // 断线重连会再同步一次，此时不能退回未同步状态：那之后到达的都是我真的漏掉的
      synced.value = true
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

  const awareness = provider.awareness
  if (!awareness) throw new Error("协同连接没有 awareness，在场状态无法工作")

  return {
    synced,
    linked,
    pending,
    awareness,
    // 内容一直是同步的，没有「攒着没发」的东西可以 flush
    flush: () => Promise.resolve(),
    destroy: () => {
      provider?.destroy()
      provider = null
    }
  }
}
