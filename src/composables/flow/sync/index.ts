import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue"
import { useOnline } from "@vueuse/core"
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { Awareness } from "y-protocols/awareness"
import { nodesMap } from "@/lib/flow-doc"
import { useAuth } from "@/lib/auth"
import type { FlowMode } from "@/types/flow"
import { createCollabTransport } from "./collab"
import { createSoloTransport } from "./solo"
import type { FatalClose, FlowTransport } from "./types"

export { classifyClose } from "./collab"
export type { FatalClose, FlowTransport } from "./types"

/**
 * 画布内容的同步层 —— **文档的生命周期在这里，传输是可换的**。
 *
 * 一张画布 = 一个 `Y.Doc` + 一份 IndexedDB 本地缓存 + 一条传输通道。
 * 前两样两种画布完全一样，只有第三样按 `mode` 分叉（见 `./types.ts`）：
 * 项目画布走 WebSocket，个人画布走 HTTP 增量推拉。
 *
 * **文档立刻建，传输等 `mode` 到了再挂。** `mode` 得先向服务端问一次
 * （`GET /api/flows/:id`），而文档和传输本来就是解耦的 —— 这样「先从本地缓存
 * 把上次看到的画出来」不用等网络，也不必把编辑器拆成「外层先取元信息、内层才渲染」
 * 的两层组件。`mode` 未知的那一小段时间里状态是「连接中」。
 *
 * 同一个 `Y.Doc` 上挂的 **IndexedDB 缓存**带来两件事：打开画布时先从本地渲染，
 * 以及**断网时改的东西不会随刷新丢掉** —— 恢复后由各自的传输补发出去
 * （协同靠 CRDT 重连补发，个人画布靠状态向量重算差量）。
 */

/**
 * 测试环境（jsdom）里没有真的服务端，连上去只会无限重连刷日志 ——
 * 和 `src/test/setup.ts` 把 fetch 换成必然 reject 的桩是同一个用意：测试不碰网络。
 * 本地缓存同理：jsdom 没有可用的 IndexedDB。
 */
const CAN_CONNECT = typeof window !== "undefined" && import.meta.env.MODE !== "test"

/** 一次连接。换画布、重建传输都会换一个新的 */
export interface FlowSyncSession {
  /** yjs 的客户端号；同一个人开两个标签页也是两个号 */
  clientId: number
  /** 画布内容就住在这里；`stores/flow` 接管它 */
  doc: Y.Doc
  /** 在场用的 awareness；个人画布没有这一层，为 null */
  awareness: Awareness | null
  /** 和**服务端**的首次同步是否完成。到这一刻文档才保证是最新的 */
  synced: Ref<boolean>
  /**
   * **本地缓存**（IndexedDB）是否已经灌进文档。
   *
   * 和 `synced` 分开是因为两者回答的是不同的问题：`cached` 说的是「有没有东西可以
   * 先画出来」，`synced` 说的是「画出来的是不是最新的」。断网打开一张来过的画布时，
   * 只有前者会为真 —— 这正是离线可用的意思。
   */
  cached: Ref<boolean>
  /** 文档里到底有没有内容 —— 用来区分「缓存是空的」和「这张画布本来就是空的」 */
  hasContent: Ref<boolean>
}

/**
 * @param mode 这张画布走哪条通道；`null` = 还不知道（元信息没回来 / 换画布中）
 */
export function useFlowSync(flowId: Ref<string>, mode: Ref<FlowMode | null>) {
  let doc: Y.Doc | null = null
  let offline: IndexeddbPersistence | null = null
  let transport: FlowTransport | null = null
  let stopMirror: (() => void) | null = null

  /** 传输自己报的状态，镜像到这里，这样上层不用关心当前挂的是哪一种 */
  const synced = ref(false)
  const linked = ref(false)
  const pending = ref(false)

  const cached = ref(false)
  const hasContent = ref(false)

  /**
   * 这条通道被**终局**掐掉了，以及为什么（`null` = 没有）。
   *
   * 和「断线」是两回事，所以绝不能混进 `connected`：断线会自动重连 / 重试、
   * 改动会补发，用户什么都不用做；终局失败则是这个窗口不再同步，而且不会自己好。
   */
  const fatal = ref<FatalClose | null>(null)

  /**
   * 网卡说自己通不通。
   *
   * 单看传输的状态不够：拔网线之后 WebSocket 要等心跳超时（默认几十秒）才察觉，
   * 这期间界面会一直显示「已同步」，而用户改的东西其实只落在本地。
   * `navigator.onLine` 的反应是即时的 —— 反过来它也不可靠（网卡通不代表连得上服务器），
   * 所以两者**都要为真**才算连着。
   */
  const online = useOnline()

  const connected = computed(() => linked.value && online.value)
  const session = shallowRef<FlowSyncSession | null>(null)

  function dropTransport() {
    stopMirror?.()
    stopMirror = null
    transport?.destroy()
    transport = null
    synced.value = false
    linked.value = false
    pending.value = false
  }

  function teardown() {
    dropTransport()
    // 顺序要紧：先拆传输、再摘本地缓存、最后才销毁文档 ——
    // 反过来的话缓存那边还挂着已销毁文档的 update 监听
    // 只 destroy 不 clearData：缓存留着，下次打开还能离线用
    void offline?.destroy()
    offline = null
    doc?.destroy()
    doc = null
    cached.value = false
    hasContent.value = false
    session.value = null
  }

  /** 开一张画布：建文档、接上本地缓存。此时还不知道要走哪条通道 */
  function openDocument(id: string) {
    teardown()
    fatal.value = null
    if (!id || !CAN_CONNECT) return

    doc = new Y.Doc()
    const target = doc
    const refreshHasContent = () => {
      hasContent.value = nodesMap(target).size > 0
    }

    // 本地缓存：构造即开始加载，加载完把内容合进同一个文档
    offline = new IndexeddbPersistence(`flow:${id}`, doc)
    void offline.whenSynced.then(() => {
      if (doc !== target) return
      refreshHasContent()
      cached.value = true
    })
    target.on("update", refreshHasContent)

    session.value = {
      clientId: target.clientID,
      doc: target,
      awareness: null,
      synced,
      cached,
      hasContent
    }
  }

  /** 元信息回来了，知道该走哪条通道 —— 挂上去 */
  function attachTransport(kind: FlowMode) {
    if (!doc || !CAN_CONNECT) return
    dropTransport()

    const target = doc
    const context = {
      flowId: flowId.value,
      doc: target,
      onFatal: (reason: FatalClose) => {
        fatal.value = reason
      }
    }

    transport = kind === "solo" ? createSoloTransport(context) : createCollabTransport(context)

    const current = transport
    stopMirror = watchEffect(() => {
      synced.value = current.synced.value
      linked.value = current.linked.value
      pending.value = current.pending.value
    })

    // 协同才有 awareness，而在场层是靠 session 的变化重挂钩子的，所以换一个新对象
    const opened = session.value
    if (current.awareness && opened) {
      session.value = {
        ...opened,
        clientId: current.awareness.clientID,
        awareness: current.awareness
      }
    }
  }

  // 路由在画布之间跳（`/flows/:flowId` 换 id）时换文档，不是重建组件
  watch(
    flowId,
    (id) => {
      openDocument(id)
      if (mode.value) attachTransport(mode.value)
    },
    { immediate: true }
  )

  // 元信息到达（或换了画布之后重新到达）：挂上对应的通道。
  // `null` 表示「这张画布的元信息还没回来」，此时不该猜，等着就是
  watch(mode, (next) => {
    if (next) attachTransport(next)
    else dropTransport()
  })

  /**
   * 重新登录成功之后就地重连 —— 用户不用刷新，画布上的东西一样不动。
   *
   * 两个条件缺一不可。**必须真的登上了**：确认框还能被关掉（× / Esc / 点遮罩，
   * `dismissReLogin`），那一路 `sessionExpired` 也会变假，此时重连只会再被拒一次、
   * 再弹一次框，来回空转。**必须是 `unauthorized`**：被顶下线、被移出项目、画布太大
   * 跟登录都没关系，重连解决不了，只会把用户正在用的另一个窗口踢掉。
   */
  const { sessionExpired, isAuthenticated } = useAuth()
  watch(sessionExpired, (expired) => {
    if (expired || fatal.value !== "unauthorized" || !isAuthenticated.value) return
    fatal.value = null
    if (mode.value) attachTransport(mode.value)
  })

  onBeforeUnmount(teardown)

  return {
    connected,
    session,
    fatal,
    /** 有没有还没送出去的本地改动（只有个人画布会为真） */
    pending,
    /** 离开前把攒着的送走；协同一直是同步的，这是个空动作 */
    flush: () => transport?.flush() ?? Promise.resolve()
  }
}

export type FlowSync = ReturnType<typeof useFlowSync>
