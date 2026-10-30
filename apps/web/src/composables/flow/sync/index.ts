import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type Ref } from "vue"
import { useOnline } from "@vueuse/core"
import { toast } from "vue-sonner"
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { Awareness } from "y-protocols/awareness"
import { nodesMap } from "@shadecn/shared/flow-doc"
import { useAuth } from "@/lib/auth"
import type { FlowMode } from "@shadecn/shared/canvas"
import { createCollabTransport } from "./collab"
import { createStatelessRouter } from "./stateless"
import type { FatalClose, FlowTransport } from "./types"

export { classifyClose, parseStoreState } from "./collab"
export { statelessTypeOf, type StatelessHandler } from "./stateless"
export type { FatalClose, FlowTransport } from "./types"

/**
 * 画布内容的同步层 —— **文档的生命周期在这里，传输挂在它上面**。
 *
 * 一张画布 = 一个 `Y.Doc` + 一份 IndexedDB 本地缓存 + 一条 WebSocket（见 `./types.ts`）。
 * 两种画布在这一层**完全一样**：个人画布也走协同房间，只是房间只对所有者开放、
 * 没有在场层（在场层按 `mode` 开关，见 `useFlowPresence`）。`mode` 在这里只当
 * 「元信息到了没有」用 —— 它决定的是「画布是什么」，不再决定「内容走哪条路」。
 *
 * **文档立刻建，传输等元信息到了再挂。** 元信息得先向服务端问一次
 * （`GET /api/flows/:id`），而文档和传输本来就是解耦的 —— 这样「先从本地缓存
 * 把上次看到的画出来」不用等网络，也不必把编辑器拆成「外层先取元信息、内层才渲染」
 * 的两层组件。不等元信息直接连也连得上，但一张进不去的画布就会同时冒出两种报错
 * （页面的加载失败 + 房间握手被拒的终局框）；等它回来，没权限的画布只报一次。
 *
 * 同一个 `Y.Doc` 上挂的 **IndexedDB 缓存**带来两件事：打开画布时先从本地渲染，
 * 以及**断网时改的东西不会随刷新丢掉** —— 恢复后重连，Hocuspocus 按状态向量双向补差量。
 */

/**
 * 测试环境（jsdom）里没有真的服务端，连上去只会无限重连刷日志 ——
 * 和 `apps/web/src/test/setup.ts` 把 fetch 换成必然 reject 的桩是同一个用意：测试不碰网络。
 * 本地缓存同理：jsdom 没有可用的 IndexedDB。
 */
const CAN_CONNECT = typeof window !== "undefined" && import.meta.env.MODE !== "test"

/** 一次连接。换画布、重建传输都会换一个新的 */
export interface FlowSyncSession {
  /** yjs 的客户端号；同一个人开两个标签页也是两个号 */
  clientId: number
  /** 画布内容就住在这里；`stores/flow` 接管它 */
  doc: Y.Doc
  /** 在场用的 awareness；传输挂上之前为 null（个人画布也有，只是在场层不用它） */
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
 * @param mode 这张画布是什么；`null` = 还不知道（元信息没回来 / 换画布中）。
 *   传输一律是协同的，这里只等它从 `null` 变成有值再挂上去
 */
export function useFlowSync(flowId: Ref<string>, mode: Ref<FlowMode | null>) {
  let doc: Y.Doc | null = null
  let offline: IndexeddbPersistence | null = null
  let transport: FlowTransport | null = null
  let stopMirror: (() => void) | null = null

  /** 传输自己报的状态，镜像到这里，这样上层不用关心当前挂的是哪一种 */
  const synced = ref(false)
  const linked = ref(false)
  const saveFailed = ref(false)

  const cached = ref(false)
  const hasContent = ref(false)
  /** 本地缓存（IndexedDB）用不了 —— 「断网不丢」这个承诺在这台浏览器上不成立 */
  const cacheFailed = ref(false)

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

  /**
   * 服务端 stateless 旁路消息的订阅表，整个 `useFlowSync` 一份 —— 跨传输重建、跨换画布都不变，
   * 订阅方只订一次。同步层只按 `type` 分发，不认识载荷（agent 的任务列表等由订阅方自己解析、自己比对 flowId）。
   */
  const stateless = createStatelessRouter()

  /**
   * 本地缓存（IndexedDB）用不了。
   *
   * 无痕模式、浏览器策略禁用、配额写满都会走到这里。**在线时它不影响任何事** ——
   * 内容照样同步给服务器和协作者；它拿掉的是**断网那一档**的兜底，
   * 以及「关掉页面再打开，没发出去的改动还在」这个保证。
   *
   * 所以处理方式也分两档：进场时 toast 一次（否则一个从不断网的人永远不知道
   * 自己少了这层保护），断网时状态栏换一句更重的话（见 `useFlowDocument`）。
   */
  function noteCacheFailure(error: unknown) {
    if (cacheFailed.value) return
    cacheFailed.value = true
    console.warn("[flow] 本地缓存不可用，断网期间的改动将无法保留", error)
    toast.warning("本地缓存不可用", {
      description: "这台浏览器存不下离线草稿：断网或关闭页面时，还没同步出去的改动会丢失。"
    })
  }

  function dropTransport() {
    stopMirror?.()
    stopMirror = null
    transport?.destroy()
    transport = null
    synced.value = false
    linked.value = false
    /*
     * 换传输就把这个状态清掉：它说的是「**那台**服务器存不进去」，
     * 而重连之后是一次全新的判断 —— 服务端会在新连接接入时补发当前状态。
     * 留着旧值的话，一次普通重连就能让界面永久停在「无法保存」。
     */
    saveFailed.value = false
  }

  function teardown() {
    dropTransport()
    // 顺序要紧：先拆传输、再摘本地缓存、最后才销毁文档 ——
    // 反过来的话缓存那边还挂着已销毁文档的 update 监听
    // 只 destroy 不 clearData：缓存留着，下次打开还能离线用
    void offline?.destroy().catch(() => undefined)
    offline = null
    doc?.destroy()
    doc = null
    cached.value = false
    hasContent.value = false
    /*
     * 换画布时重置：缓存能不能用是**这台浏览器**的属性，理论上换一张画布也一样坏。
     * 但重置掉才能让下一张画布重新判一次、也重新提示一次 —— 与其记住一个可能
     * 已经变了的结论（用户退出了无痕模式、清理出了空间），不如每张画布各判各的。
     */
    cacheFailed.value = false
    session.value = null
  }

  /**
   * 本窗口正在**主动**离开这张画布（删除它）。
   *
   * 删画布的请求会让服务端把这张画布的所有连接当场掐掉（`revokeCollabAccess`）——
   * 包括**发起删除的这一条**，而且服务端是先踢人再回 204，所以关闭信号往往比响应先到。
   * 不打这个标记的话，删完自己会先看到一个「已失去这张画布的访问权限，请联系项目管理员
   * 重新邀请你」的模态框，然后才被路由带走：一件自己刚做完的事，被报成了一场事故。
   *
   * 只压提示，不改别的：连接照样断、内容照样不再同步 —— 那本来就是删除的应有之义。
   */
  let leaving = false

  /** 开一张画布：建文档、接上本地缓存。此时还不知道要走哪条通道 */
  function openDocument(id: string) {
    teardown()
    fatal.value = null
    // 换了一张画布 = 上一次的「主动离开」翻篇了
    leaving = false
    if (!id || !CAN_CONNECT) return

    doc = new Y.Doc()
    const target = doc
    const refreshHasContent = () => {
      hasContent.value = nodesMap(target).size > 0
    }

    /*
     * 本地缓存：构造即开始加载，加载完把内容合进同一个文档。
     *
     * **两处都要接住异常**，而且这不是防御性编程的客套 —— 这一层是整个「断网不丢」
     * 承诺的地基：无痕模式、浏览器禁用 IndexedDB、存储配额写满时它会失败，
     * 而失败一旦静默，用户就会在一个**没有本地兜底**的画布上照常编辑，
     * 断网时以为「改动存在本地」，刷新之后才发现什么都没有。
     *
     * 构造函数本身可能同步抛（没有 `indexedDB` 这个全局），`whenSynced` 也可能 reject，
     * 所以 try/catch 和 `.catch()` 缺一不可。
     */
    try {
      const cache = new IndexeddbPersistence(`flow:${id}`, doc)
      offline = cache
      void cache.whenSynced
        .then(() => {
          if (doc !== target) return
          refreshHasContent()
          cached.value = true
        })
        .catch((error: unknown) => {
          if (doc === target) noteCacheFailure(error)
        })
    } catch (error) {
      offline = null
      noteCacheFailure(error)
    }
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

  /** 元信息回来了 —— 挂上协同传输（重新登录之后就地重连也走这里） */
  function attachTransport() {
    if (!doc || !CAN_CONNECT) return
    dropTransport()

    const target = doc
    const context = {
      flowId: flowId.value,
      doc: target,
      onFatal: (reason: FatalClose) => {
        // 自己把这张画布删了，之后被服务端掐掉是预期之内的，不是新闻
        if (leaving) return
        fatal.value = reason
      },
      onStateless: stateless.dispatch
    }

    transport = createCollabTransport(context)

    const current = transport
    stopMirror = watchEffect(() => {
      synced.value = current.synced.value
      linked.value = current.linked.value
      saveFailed.value = current.saveFailed.value
    })

    // 在场层是靠 session 的变化重挂钩子的，所以换一个新对象把 awareness 交出去
    const opened = session.value
    if (opened) {
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
      if (mode.value) attachTransport()
    },
    { immediate: true }
  )

  // 元信息到达（或换了画布之后重新到达）：挂上传输。
  // `null` 表示「这张画布的元信息还没回来」，此时不该猜，等着就是。
  // 只看「有没有」：同一张画布的 mode 不会在 collab / solo 之间变
  watch(
    () => mode.value !== null,
    (known) => {
      if (known) attachTransport()
      else dropTransport()
    }
  )

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
    if (mode.value) attachTransport()
  })

  onBeforeUnmount(teardown)

  return {
    connected,
    session,
    fatal,
    /**
     * 订阅某一类 stateless 消息（按载荷的 `type`），返回退订函数。
     * 回调收到原文、自己防御着解析；抛出的异常被分发层兜住，不会打断连接的消息循环。
     */
    onStateless: stateless.on,
    /**
     * 服务端收到了但**存不进库**。
     *
     * 不是断线、也不是终局失败：连接好好的、改动也到了服务端（项目画布还同步给了同房间的人），
     * 只是服务器写库失败、字节悬在它的内存里。服务器恢复后会再广播一次，自己变回 false。
     */
    saveFailed,
    /**
     * 本地缓存用不上（无痕模式、禁用 IndexedDB、配额写满）。
     *
     * 在线时无影响；它拿掉的是**断网那一档**的兜底 —— 所以只在断线时才改变状态栏文案。
     */
    cacheFailed,
    /** 删这张画布之前打个招呼：接下来那次断开是自己招来的，别弹框（见上面 `leaving`） */
    leave: () => {
      leaving = true
    },
    /**
     * 说好的离开没成行（删除失败），人还在这张画布上 —— 把标记撤回来。
     *
     * 不撤的话，这一整次打开剩下的时间里，**真**被踢（被移出项目、被顶下线）都会一声不响：
     * 画布看着正常、状态栏写着「已同步」，而改动只进本地。正是这个模块存在的那类坑。
     */
    stay: () => {
      leaving = false
    }
  }
}

export type FlowSync = ReturnType<typeof useFlowSync>
