import { computed, shallowRef, watch } from "vue"
import { useThrottleFn } from "@vueuse/core"

import { useAuth } from "@/lib/auth"
import {
  elementKey,
  elementIdOf,
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
import type { FlowSync } from "./sync"

/**
 * 画布的**反馈层** —— 跑在 yjs 的 awareness 协议上。
 *
 * 这一层只管「谁在、在哪、在动谁」：光标、选中、拖动中的几何、正在拉的线。
 * 它们全都易失、断线即消失、丢一帧无所谓（下一帧覆盖），因此**绝不落库**。
 * 画布内容是另一层，直接住在 Y.Doc 里（见 `src/lib/presence.ts` 顶部的两层对照表）。
 *
 * 这个 composable **不认识 selection、也不认识 Vue Flow**：它只提供
 * 「上报」和「读别人」两组能力，本地状态怎么接进来由 `useFlowCanvas` 负责。
 * 这样加一种新的反馈信号（正在输入标题、框选范围…）只要在这里加一对 set/computed，
 * 不用动选中态和画布那两坨。
 *
 * awareness 的内容完全由客户端自己写、服务端只做转发，因此对收到的数据一律当
 * 不可信输入解析（`readPeer`），颜色也在本地按 id 重算而不是照抄对方上报的。
 * 真正的边界在握手那一步：`server/auth/ws.ts` 只放项目成员进这个房间。
 */

/** 光标 / 拖动几何上报的节流窗口（毫秒）：够跟手，又不至于每帧一个包 */
const FEEDBACK_THROTTLE = 40

export function useFlowPresence(sync: FlowSync) {
  const { user, displayName } = useAuth()

  const peers = shallowRef<PresencePeer[]>([])
  const localClientId = shallowRef(-1)

  function awareness() {
    return sync.session.value?.awareness ?? null
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

  /**
   * 上报鼠标位置。传的是**画布坐标**不是屏幕坐标 ——
   * 各人的视口不一样，屏幕坐标到了对方那儿毫无意义。
   */
  const setCursor = useThrottleFn(
    (point: PresencePoint | null) => {
      awareness()?.setLocalStateField(
        "cursor",
        // 亚像素精度对显示毫无帮助，取整能让包小一点
        point ? { x: Math.round(point.x), y: Math.round(point.y) } : null
      )
    },
    FEEDBACK_THROTTLE,
    true
  )

  /** 上报我选中了哪些元素（元素 key）。节点和边一视同仁 */
  function setSelection(keys: readonly string[]) {
    awareness()?.setLocalStateField("selection", [...keys])
  }

  /**
   * 上报「我正操作着哪些元素、它们此刻在哪」。
   *
   * 节流函数读的是 `transformState` 而不是自己的入参：这样节流尾巴上那一次补发
   * 拿到的一定是**当前**状态，而不是一个已经过期的值（松手清空后又被补发回去）。
   */
  let transformState: Record<string, PresencePoint> = {}

  const flushTransform = useThrottleFn(
    () => {
      awareness()?.setLocalStateField("transform", transformState)
    },
    FEEDBACK_THROTTLE,
    true
  )

  function setTransform(geometry: Record<string, PresencePoint>) {
    transformState = geometry
    void flushTransform()
  }

  function clearTransform() {
    transformState = {}
    // 立刻发一次，不等节流：松手了对方就该看到节点落定，不能压在节流窗口里
    awareness()?.setLocalStateField("transform", {})
    void flushTransform()
  }

  /**
   * 上报「我正从哪个节点拉线、连接口在哪」。null = 收线。
   *
   * 线的另一头跟着 `cursor` 走，所以只发起点。
   */
  function setConnecting(connecting: { from: PresencePoint; nodeId: string } | null) {
    awareness()?.setLocalStateField(
      "connecting",
      connecting
        ? {
            from: { x: Math.round(connecting.from.x), y: Math.round(connecting.from.y) },
            nodeId: connecting.nodeId
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
    () => sync.session.value,
    (next, _prev, onCleanup) => {
      /*
       * 没有 awareness 就没有在场这一层 —— 个人画布（`mode: 'solo'`）走的是
       * HTTP 通道，房间里只有自己一个人，没有谁的光标可看。上面那些 `setXxx`
       * 也因此全都变成空动作（`awareness()` 返回 null），画布那边一行都不用改。
       */
      if (!next?.awareness) {
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
  watch([user, displayName], publishUser)

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
   * `src/lib/presence.ts`（有测试），要恢复限制只需在 `useFlowCanvas` 重新接上。
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
