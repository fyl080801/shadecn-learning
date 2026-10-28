import { computed, shallowRef, watch, type Ref } from "vue"
import { useThrottleFn } from "@vueuse/core"

import { useAuth } from "@/lib/auth"
import {
  elementKey,
  elementIdOf,
  feedbackThrottle,
  lockOwner,
  lockedKeys as computeLockedKeys,
  occupies,
  presenceColor,
  readPeers,
  remoteTransforms,
  type ElementKind,
  type PresenceConnection,
  type PresenceCursor,
  type PresencePeer,
  type PresencePoint
} from "@/lib/presence"
import type { FlowMode } from "@shadecn/shared/canvas"
import type { FlowSync } from "./sync"

/**
 * 画布的**反馈层** —— 跑在 yjs 的 awareness 协议上。
 *
 * 这一层只管「谁在、在哪、在动谁」：光标、选中、拖动中的几何、正在拉的线。
 * 它们全都易失、断线即消失、丢一帧无所谓（下一帧覆盖），因此**绝不落库**。
 * 画布内容是另一层，直接住在 Y.Doc 里（见 `apps/web/src/lib/presence.ts` 顶部的两层对照表）。
 *
 * 这个 composable **不认识 selection、也不认识 Vue Flow**：它只提供
 * 「上报」和「读别人」两组能力，本地状态怎么接进来由 `useFlowCanvas` 负责。
 * 这样加一种新的反馈信号（正在输入标题、框选范围…）只要在这里加一对 set/computed，
 * 不用动选中态和画布那两坨。
 *
 * awareness 的内容完全由客户端自己写、服务端只做转发，因此对收到的数据一律当
 * 不可信输入解析（`readPeer`），颜色也在本地按 id 重算而不是照抄对方上报的。
 * 真正的边界在握手那一步：`apps/server/auth/ws.ts` 只放项目成员进这个房间。
 */

export function useFlowPresence(sync: FlowSync, mode?: Ref<FlowMode | null>) {
  const { user, displayName } = useAuth()

  const peers = shallowRef<PresencePeer[]>([])
  const localClientId = shallowRef(-1)

  /**
   * 在场这一层开不开，看的是**画布类型**，不是传输。
   *
   * 个人画布也走 WebSocket（docs/16），于是手里也有 awareness ——
   * 但它仍是一张个人画布：没有协作者可看，也不该把自己的光标广播出去。
   * 只看「有没有 awareness」的话，同一个人的另一个窗口、连同自己，都会被当成协作者
   * 摆进左上角的头像堆和节点的占用标签里。
   *
   * 不传 `mode`（老调用方 / 测试）时退回「有 awareness 就开」。
   */
  const active = computed(() => !mode || mode.value === "collab")

  function awareness() {
    return active.value ? (sync.session.value?.awareness ?? null) : null
  }

  // —— 上报 ——

  function publishUser() {
    const current = user.value
    const id = current?.id ?? "anonymous"
    awareness()?.setLocalStateField("user", {
      id,
      name: displayName.value,
      avatarUrl: current?.avatarUrl ?? null,
      // 对方会自己按 id 重算，这里带上只是方便调试时肉眼看
      color: presenceColor(id)
    })
  }

  /*
   * —— 操作反馈：光标、选中、拖动几何、拉线，全部走**同一个缓冲、同一个节流** ——
   *
   * 每次写 awareness 都会发一个包，而且包里是**整份**本地状态。各字段各发各的话，
   * 拖动时一个窗口要发好几包（光标一包、几何一包…），内容大半重复；
   * 合到一个缓冲里，**不管动了几样，一个窗口最多一包**。
   * 离散事件（点一下选中、开始拉线）也不吃亏：安静一阵后的第一次走节流的前沿，立刻发。
   *
   * 加一种新的反馈字段：往 `FeedbackField` 里加个名字，setter 里调 `publish` 即可。
   * 身份（`user`）不是操作反馈，低频且必须立刻到，所以不走这里。
   *
   * 节流函数读的是缓冲而不是自己的入参：尾巴上那一次补发拿到的一定是**当前**状态，
   * 而不是一个已经过期的值（松手清空后又被补发回去）。
   */
  type FeedbackField = "cursor" | "selection" | "transform" | "connecting"
  let pending: Partial<Record<FeedbackField, unknown>> = {}

  /**
   * 上报的节流窗口 —— 所有反馈字段一个值，**跟着房间人数走**，见 `feedbackThrottle`。
   *
   * 写成 getter 而不是常量：`useThrottleFn` 每次调用都会 `toValue(ms)` 重读，
   * 所以人进人出时窗口自动跟着变，不用重建节流函数。
   */
  const throttleMs = computed(() => feedbackThrottle(peers.value.length))

  /**
   * 把缓冲写进 awareness。**值没变就不发** —— y-protocols 的 `update` 事件不去重，
   * provider 收到就发包，所以「鼠标在一个整数像素内抖」「选中没变又报一遍」这种都得在这儿拦掉。
   */
  function flush() {
    const current = awareness()
    const next = pending
    pending = {}
    if (!current) return

    const state = current.getLocalState() ?? {}
    const changed = (Object.keys(next) as FeedbackField[]).some(
      (field) => JSON.stringify(state[field] ?? null) !== JSON.stringify(next[field] ?? null)
    )
    if (changed) current.setLocalState({ ...state, ...next })
  }

  const scheduleFlush = useThrottleFn(flush, throttleMs, true)

  function publish(field: FeedbackField, value: unknown) {
    pending[field] = value
    void scheduleFlush()
  }

  /**
   * 上报鼠标位置。传的是**画布坐标**不是屏幕坐标 ——
   * 各人的视口不一样，屏幕坐标到了对方那儿毫无意义。
   */
  function setCursor(point: PresencePoint | null) {
    // 亚像素精度对显示毫无帮助，取整能让包小一点，也让「没动」更容易判出来
    publish("cursor", point ? { x: Math.round(point.x), y: Math.round(point.y) } : null)
  }

  /** 上报我选中了哪些元素（元素 key）。节点和边一视同仁 */
  function setSelection(keys: readonly string[]) {
    publish("selection", [...keys])
  }

  /** 上报「我正操作着哪些元素、它们此刻在哪」 */
  function setTransform(geometry: Record<string, PresencePoint>) {
    publish("transform", geometry)
  }

  function clearTransform() {
    pending.transform = {}
    // 立刻发一次，不等节流：松手了对方就该看到节点落定，不能压在节流窗口里。
    // 之后节流尾巴即使再触发，缓冲已空、状态没变，也不会多发
    flush()
  }

  /**
   * 上报「我正从哪个节点拉线、连接口在哪」。null = 收线。
   *
   * 线的另一头跟着 `cursor` 走，所以只发起点。
   */
  function setConnecting(next: { from: PresencePoint; nodeId: string } | null) {
    publish(
      "connecting",
      next
        ? {
            from: { x: Math.round(next.from.x), y: Math.round(next.from.y) },
            nodeId: next.nodeId
          }
        : null
    )
  }

  // —— 接收 ——

  /**
   * 第三个参数是「这个 clientId 最后一次更新是什么时候」。
   *
   * `readPeers` 会把同一个人的多条状态折叠成一条（刷新页面的那一瞬间会有两条，
   * 原因见它的注释），折叠时要挑还活着的那条 —— 判据就是这个时刻。
   * `meta` 是 y-protocols 自己维护的，每收到一次更新就刷新一遍。
   */
  function refresh() {
    const current = awareness()
    peers.value = current
      ? readPeers(current.getStates(), current.clientID, (clientId) =>
          current.meta.get(clientId)?.lastUpdated ?? 0
        )
      : []
  }

  // 换画布 / 重连都会给出新的 session，钩子跟着重挂一遍
  watch(
    [() => sync.session.value, active],
    ([next, enabled], _prev, onCleanup) => {
      /*
       * 没有 awareness、或这是张个人画布，就没有在场这一层 —— 房间里只有自己一个人，
       * 没有谁的光标可看。上面那些 `setXxx` 也因此全都变成空动作（`awareness()` 返回 null），
       * 画布那边一行都不用改。
       *
       * 个人画布走 WebSocket 时 awareness 是有的：把本地状态清成**空对象**，不是 null。
       *
       * 空对象不带身份也不带光标（服务端对个人房间还会整帧丢掉 awareness 的内容），
       * 但它让 y-protocols 每 15s 的本地状态重放继续跑 —— 那是这条连接**唯一的心跳**：
       * 服务端只看「多久没收到这个客户端的消息」（`timeout: 30_000`），自己不发 ping。
       * 清成 null 的话重放就停了，一张只看不改的个人画布每 30s 被服务端超时掐断一次、
       * 重连一次，状态栏跟着闪「已离线」。
       */
      if (next?.awareness && !enabled) next.awareness.setLocalState({})
      if (!next?.awareness || !enabled) {
        localClientId.value = -1
        peers.value = []
        return
      }

      const { awareness: current } = next
      localClientId.value = next.clientId
      current.on("change", refresh)
      onCleanup(() => current.off("change", refresh))

      publishUser()
      refresh()
    },
    { immediate: true }
  )

  // 会话是异步拿回来的，登录态先到先空着，回来了再补一次身份
  watch([user, displayName], () => {
    if (active.value) publishUser()
  })

  // —— 派生 ——

  /** 在场的所有人，含我自己且我排第一 —— 头像堆叠直接用这个 */
  const members = computed(() => peers.value)

  /** 除我以外的人 */
  const others = computed(() => peers.value.filter((peer) => !peer.isSelf))

  /** 需要在画布上画光标的人 */
  const cursors = computed<PresenceCursor[]>(() =>
    others.value.filter((peer): peer is PresenceCursor => peer.cursor !== null)
  )

  /** 正在拉线的人（起点已知，终点是他的光标） */
  const connections = computed<PresenceConnection[]>(() =>
    others.value.filter(
      (peer): peer is PresenceConnection => peer.connecting !== null && peer.cursor !== null
    )
  )

  /**
   * 被别人占住的元素 key。
   *
   * ⚠️ **画布当前没有接这条线** —— 占用（一个人在编辑时别人不能碰）已经从交互上摘掉，
   * 谁都可以同时改同一样东西，由 CRDT 负责合并。仲裁逻辑保留在这里和
   * `apps/web/src/lib/presence.ts`（有测试），要恢复限制只需在 `useFlowCanvas` 重新接上。
   */
  const lockedKeys = computed(() => computeLockedKeys(peers.value, localClientId.value))

  /** 别人正操作着的元素此刻的几何；画布用它盖掉 store 里那份还没更新的值 */
  const transforms = computed(() => remoteTransforms(peers.value, localClientId.value))

  /** 别人正拖着的**节点** → 实时位置，画布直接拿去覆盖节点坐标 */
  const nodePositions = computed(() => {
    const positions = new Map<string, PresencePoint>()
    for (const [key, point] of transforms.value) {
      const nodeId = elementIdOf(key, "node")
      if (nodeId) positions.set(nodeId, point)
    }
    return positions
  })

  /** 谁占住了这个元素；null = 我可以操作它 */
  function lockOf(kind: ElementKind, id: string): PresencePeer | null {
    return lockOwner(peers.value, elementKey(kind, id), localClientId.value)
  }

  /** 这个元素被别人占着吗 */
  function isLocked(kind: ElementKind, id: string): boolean {
    return lockedKeys.value.has(elementKey(kind, id))
  }

  /** 远端占着这个元素的人（选中或正在操作，一般就一个）；用来贴头像标签 */
  function occupantsOf(kind: ElementKind, id: string): PresencePeer[] {
    const key = elementKey(kind, id)
    return others.value.filter((peer) => occupies(peer, key))
  }

  return {
    connected: sync.connected,
    // 读
    members,
    others,
    cursors,
    connections,
    lockedKeys,
    nodePositions,
    lockOf,
    isLocked,
    occupantsOf,
    // 写
    setCursor,
    setSelection,
    setTransform,
    clearTransform,
    setConnecting
  }
}

export type FlowPresence = ReturnType<typeof useFlowPresence>
