import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue"
import * as Y from "yjs"
import { WebsocketProvider } from "y-websocket"

/**
 * 画布协同的**连接层**：一张画布一个房间、一个 `Y.Doc`、一条 WebSocket。
 *
 * 上面驮着两件互不相干的事，各自一个 composable：
 * - `useFlowPresence` —— awareness：谁在线、鼠标在哪、选中了谁（断线即消失，不落库）；
 * - `useFlowSync` —— 编辑操作广播：本地每条 `FlowTransaction` 发一份给同房间的人。
 *
 * 它们共用同一条连接，所以连接的建立 / 销毁只写在这里一处。上层不直接碰 provider，
 * 而是 `watch(session)`：换画布、断线重连都会给出一个新的 session，
 * 上层照着重新挂钩子即可，不用自己管生命周期。
 */

/** WebSocket 挂载点，和后端 `COLLAB_PATH` 一致 */
const COLLAB_PATH = "/ws"

/** 房间名前缀；服务端靠它认出「这是某张画布的房间」并去查项目成员身份 */
const FLOW_ROOM_PREFIX = "flow:"

/** 事务广播通道在 Y.Doc 里的名字 */
const CHANNEL_NAME = "ops"

/**
 * 测试环境（jsdom）里没有真的服务端，连上去只会无限重连刷日志 ——
 * 和 `src/test/setup.ts` 把 fetch 换成必然 reject 的桩是同一个用意：测试不碰网络。
 */
const CAN_CONNECT = typeof window !== "undefined" && import.meta.env.MODE !== "test"

/** 一次连接。换房间或重建连接都会换一个新的 */
export interface CollabSession {
  /** yjs 的客户端号；同一个人开两个标签页也是两个号 */
  clientId: number
  awareness: WebsocketProvider["awareness"]
  /** 事务广播通道：同一张画布上所有人的编辑操作在这里排成同一个顺序 */
  channel: Y.Array<unknown>
  /**
   * 首次同步是否已完成。
   *
   * 用来区分「通道里的历史」和「刚发生的新操作」：刚进房间时整条通道会作为
   * 一次批量插入到达，那些是别人早就提交过、并且已经包含在我拉到的快照里的操作，
   * 重放一遍只会把画布搞乱。所以同步完成之前收到的一律不理。
   */
  synced: Ref<boolean>
}

/** 从当前页面推导 ws 地址：前后端同源同端口，不能硬编码 host */
function collabUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}${COLLAB_PATH}`
}

export function useFlowCollab(flowId: Ref<string>) {
  let doc: Y.Doc | null = null
  let provider: WebsocketProvider | null = null

  const connected = ref(false)
  const session = shallowRef<CollabSession | null>(null)

  function teardown() {
    // destroy 会断开连接并广播「我走了」，对面的头像和光标随之消失
    provider?.destroy()
    provider = null
    doc?.destroy()
    doc = null
    connected.value = false
    session.value = null
  }

  function connect(id: string) {
    teardown()
    if (!id || !CAN_CONNECT) return

    doc = new Y.Doc()
    provider = new WebsocketProvider(collabUrl(), `${FLOW_ROOM_PREFIX}${id}`, doc)

    const synced = ref(false)
    provider.on("status", (event) => {
      connected.value = event.status === "connected"
    })
    provider.on("sync", (state) => {
      // 断线重连会再同步一次，此时不能退回未同步状态：那之后到达的都是我真的漏掉的
      if (state) synced.value = true
    })

    session.value = {
      clientId: provider.awareness.clientID,
      awareness: provider.awareness,
      channel: doc.getArray(CHANNEL_NAME),
      synced
    }
  }

  // 路由在画布之间跳（`/flows/:flowId` 换 id）时换房间，不是重建组件
  watch(flowId, connect, { immediate: true })
  onBeforeUnmount(teardown)

  return { connected, session }
}

export type FlowCollab = ReturnType<typeof useFlowCollab>
