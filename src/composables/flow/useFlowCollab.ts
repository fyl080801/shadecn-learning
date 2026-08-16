import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue"
import { useOnline } from "@vueuse/core"
import * as Y from "yjs"
import { HocuspocusProvider } from "@hocuspocus/provider"
import { IndexeddbPersistence } from "y-indexeddb"
import { nodesMap } from "@/lib/flow-doc"

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
const COLLAB_PATH = "/ws"

/** 房间名前缀；服务端靠它认出「这是某张画布的房间」并去查项目成员身份 */
const FLOW_ROOM_PREFIX = "flow:"

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

    provider = new HocuspocusProvider({
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
      }
    })

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
  onBeforeUnmount(teardown)

  return { connected, session }
}

export type FlowCollab = ReturnType<typeof useFlowCollab>
