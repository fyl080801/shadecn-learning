/**
 * 协同「在场状态」（presence）的纯逻辑：配色、头像缩写、awareness 状态解析、元素占用仲裁。
 *
 * 单独放在这里而不是塞进 composable：这几件事全是纯函数，既不依赖 yjs 也不依赖 Vue，
 * 可以脱离 WebSocket 单独测（`src/test/lib/presence.test.ts`）。
 * `useFlowPresence` 只负责把 awareness 的数据喂进来。
 *
 * ────────────────────────────────────────────────────────────
 * 画布协同分**两层**，边界就是这个文件和 `stores/flow` 的分界（详见
 * `docs/04-realtime-collab.md` §4）：
 *
 * | | 数据层 | 反馈层（本文件） |
 * |---|---|---|
 * | 走哪条路 | `store.apply` → 历史 → 落库 → `Y.Array` 广播 | awareness |
 * | 内容 | 节点、连线、图元数据 | 光标、选中、拖动中几何、连线中起点 |
 * | 生命周期 | 持久，可撤销，有 revision 乐观锁 | 易失，断线即消失，**绝不落库** |
 * | 丢一帧会怎样 | 不允许丢 | 无所谓，下一帧覆盖 |
 *
 * 判断一个新东西该放哪层，问一句：**刷新页面之后它还该在吗？**
 * 该在 → 数据层，写成 `FlowOp`；不该 → 反馈层，加一个 awareness 字段。
 * ────────────────────────────────────────────────────────────
 */

// —— 元素：占用的单位 ——

/**
 * 可被占用的元素种类。
 *
 * 节点和边在占用这件事上**一视同仁**：谁选中了它，别人就不能再选、不能拖、不能删。
 * 将来加第三种（分组、批注…）只需要在这里加一个值，占用那套逻辑不用动。
 */
export type ElementKind = "node" | "edge"

/**
 * 元素的全局唯一标识：`node:<id>` / `edge:<id>`。
 *
 * 节点 id 和边 id 各自唯一但彼此可能撞车，占用集合里两种元素混在一起，
 * 所以统一带上种类前缀。这个字符串也是 awareness 上传的形式。
 */
export function elementKey(kind: ElementKind, id: string): string {
  return `${kind}:${id}`
}

/** 反过来取 id；种类对不上返回 null（`elementIdOf('edge:e1', 'node')` → null） */
export function elementIdOf(key: string, kind: ElementKind): string | null {
  const prefix = `${kind}:`
  return key.startsWith(prefix) ? key.slice(prefix.length) : null
}

/** 一个人在画布上的身份（awareness 里那份 `user` 字段） */
export interface PresenceUser {
  /** 后端用户 id；没登录（本地裸跑）时是 `anonymous` */
  id: string
  name: string
  avatarUrl: string | null
  /** 由 id 推出来的固定颜色，光标 / 头像描边 / 占用标签都用它 */
  color: string
}

/** 画布坐标系下的一个点（不是屏幕像素） */
export interface PresencePoint {
  x: number
  y: number
}

/** 解析后的一个在场客户端 */
export interface PresencePeer {
  /** yjs awareness 的客户端号，同一个人开两个标签页也是两个号 */
  clientId: number
  user: PresenceUser
  cursor: PresencePoint | null
  /**
   * 这个人选中的元素（元素 key）。选中是**持续**的占用，直到他取消。
   */
  selection: Set<string>
  /**
   * 这个人**此刻正直接操作**的元素及其实时几何（目前只有拖动，值是位置）。
   *
   * 拖动过程不产生 `FlowOp`（一次拖动松手才合成一条 `node.move`），所以中间态
   * 只能走反馈层 —— 它本来就是干这个的：高频、易失、断线即消失。
   * 直接操作同样算占用，否则拖到一半被别人抢走选中，一个节点会被两个人搬。
   * 用 Map 而不是普通对象：键来自别的浏览器，不想让 `__proto__` 之类的键落到对象上。
   */
  transform: Map<string, PresencePoint>
  /**
   * 这个人**此刻正从哪个节点拉线**（还没松手）。
   *
   * 拉线期间那个**起点节点**算他正在编辑，所以它同样被占用（见 `occupies`）——
   * 否则别人可以在他拉到一半时把这个节点删掉或搬走。
   * 只广播起点坐标：线的另一头就是他的光标，本来就在发，没必要发两遍。
   */
  connecting: PresenceConnecting | null
  isSelf: boolean
}

/** 一次进行中的连线 */
export interface PresenceConnecting {
  /** 连接口位置（画布坐标） */
  from: PresencePoint
  /** 从哪个节点拉出来的 */
  nodeId: string
}

/** `cursor` 一定不为 null 的 peer，给光标层用，省得模板里到处 `?.` */
export interface PresenceCursor extends PresencePeer {
  cursor: PresencePoint
}

/** 正在拉线的 peer：起点和终点都齐了才画得出来 */
export interface PresenceConnection extends PresencePeer {
  cursor: PresencePoint
  connecting: PresenceConnecting
}

/**
 * 配色表。刻意避开黄色 —— 元素被占用时画的是黄框，
 * 两者撞色的话「谁占的」和「被占了」就分不清了。
 */
export const PRESENCE_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899" // pink
] as const

/**
 * 按 id 取一个固定颜色 —— 同一个人每次进来、在别人屏幕上，颜色都一样。
 * 用哈希而不是「第几个进来的」：后者会随进出顺序变。
 */
export function presenceColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0]
}

/** 头像兜底文字：中文名取最后一个字（「张三」→「三」），西文取首字母 */
export function presenceInitials(name: string): string {
  const chars = [...name.trim()]
  if (chars.length === 0) return "?"

  const last = chars[chars.length - 1] as string
  if (/\p{Script=Han}/u.test(last)) return last
  return (chars[0] as string).toUpperCase()
}

// —— awareness 状态解析 ——

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function readPoint(value: unknown): PresencePoint | null {
  if (!value || typeof value !== "object") return null
  const { x, y } = value as Record<string, unknown>
  if (typeof x !== "number" || typeof y !== "number") return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function readKeys(value: unknown): Set<string> {
  const keys = new Set<string>()
  if (!Array.isArray(value)) return keys
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) keys.add(item)
  }
  return keys
}

function readConnecting(value: unknown): PresenceConnecting | null {
  if (!value || typeof value !== "object") return null
  const { from, nodeId } = value as Record<string, unknown>
  const point = readPoint(from)
  const id = readString(nodeId)
  return point && id ? { from: point, nodeId: id } : null
}

/** 解析「正在操作的元素 → 几何」。键来自别的浏览器，收进 Map 而不是对象 */
function readTransform(value: unknown): Map<string, PresencePoint> {
  const transform = new Map<string, PresencePoint>()
  if (!value || typeof value !== "object") return transform

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const point = readPoint(raw)
    if (point) transform.set(key, point)
  }
  return transform
}

/**
 * 解析单个客户端的 awareness 状态。
 *
 * 这份数据是**别的浏览器写进来的**，服务端不校验也不改写，所以这里一律当不可信输入处理：
 * 形状不对就整条丢掉，坏掉的单个字段退回默认值，不让它把整个在场列表带崩。
 */
export function readPeer(
  clientId: number,
  state: unknown,
  isSelf: boolean
): PresencePeer | null {
  if (!state || typeof state !== "object") return null

  const { user, cursor, selection, transform, connecting } = state as Record<string, unknown>
  if (!user || typeof user !== "object") return null

  const raw = user as Record<string, unknown>
  const id = readString(raw.id) ?? "anonymous"

  return {
    clientId,
    user: {
      id,
      name: readString(raw.name) ?? "匿名用户",
      avatarUrl: readString(raw.avatarUrl),
      // 颜色不信客户端报的，本地按 id 重算：省得有人把自己涂成别人的颜色
      color: presenceColor(id)
    },
    cursor: readPoint(cursor),
    selection: readKeys(selection),
    transform: readTransform(transform),
    connecting: readConnecting(connecting),
    isSelf
  }
}

/**
 * 没登录时大家的 id 都是这一个（本地裸跑、没配 Keycloak）。
 * 它辨认不出「是谁」，所以**不参与下面的按人折叠** —— 否则一屋子人会被并成一个。
 * 服务端的单连接互斥出于同样的理由在这种情况下也不生效（`server/collab/exclusive.ts`）。
 */
export const ANONYMOUS_USER_ID = "anonymous"

/**
 * 同一个人的两条状态，留哪一条。
 *
 * **自己那条永远留下**：它就是本地状态，一定是活的。其余比「最后一次更新是什么时候」——
 * 幽灵按定义就是不再更新的那条。拿不到时间信息时保留先到的，至少结论是确定的。
 */
function fresher(
  candidate: PresencePeer,
  incumbent: PresencePeer,
  lastUpdatedOf?: (clientId: number) => number
): boolean {
  if (candidate.isSelf) return true
  if (incumbent.isSelf) return false
  if (!lastUpdatedOf) return false
  return lastUpdatedOf(candidate.clientId) > lastUpdatedOf(incumbent.clientId)
}

/**
 * 把 `awareness.getStates()` 整个解析成列表，**一个人只留一条**。
 *
 * 自己永远排第一（头像堆叠里「我」在最前），其余按 clientId 排 ——
 * 需要一个**稳定**顺序，否则每次 awareness 变动头像都会重排。
 *
 * ── 为什么要按人折叠 ──
 *
 * 在场展示的是**人**，不是连接。正常情况下一个人在一张画布上也只有一条连接
 * （服务端的单连接互斥保证），所以多出来的那条一定是**过渡态**：刷新页面时，
 * 新连接已经建好、旧连接的 awareness 条目还留在房间里，服务端把当前 awareness
 * 全量推给新页面，于是在场栏冒出两个同名头像，画布上还多一个停住不动的光标。
 *
 * 那条旧的**不会立刻消失**：provider 在 `pagehide` 时发的「把我删掉」被
 * Hocuspocus 4.6.0 吞掉了（它把入站 awareness 先灌进一个空的 scratch Awareness
 * 再重新编码，而移除条目的 state 是 `null`，灌进空 Awareness 后不会出现在
 * `getStates()` 里，重编码时就整条丢了），只能等旧 socket 真的关闭、服务端
 * `removeConnection()` 才清掉。同一个原因也让客户端那套「30 秒没更新就清掉」
 * 的兜底同步不回服务端，所以这里不能指望上游把重复消掉。
 *
 * @param lastUpdatedOf 取某个 clientId 最后一次更新的时刻（`awareness.meta`）；
 *   同一个人有两条时用它挑活的那条
 */
export function readPeers(
  states: Map<number, unknown>,
  localClientId: number,
  lastUpdatedOf?: (clientId: number) => number
): PresencePeer[] {
  const peers: PresencePeer[] = []
  /** user.id → 这个人目前留下的那一条 */
  const byUser = new Map<string, PresencePeer>()

  for (const [clientId, state] of states) {
    const peer = readPeer(clientId, state, clientId === localClientId)
    if (!peer) continue

    if (peer.user.id === ANONYMOUS_USER_ID) {
      peers.push(peer)
      continue
    }

    const incumbent = byUser.get(peer.user.id)
    if (!incumbent || fresher(peer, incumbent, lastUpdatedOf)) byUser.set(peer.user.id, peer)
  }

  peers.push(...byUser.values())
  peers.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
    return a.clientId - b.clientId
  })
  return peers
}

// —— 占用仲裁 ——

/**
 * 一个人是不是「占着」这个元素。
 *
 * 占用的判据只有一条：**他是不是正在改这个元素**。三种情况都算：
 * - 选中了它（选中就是「我要动它」的意思，属性面板、删除键都对着它）；
 * - 正拖着它；
 * - 正从它拉线（还没松手 —— 那条线的起点节点在他手里）。
 *
 * 反过来，**不改这个元素的事一律不算占用**：从它拉出一条新线、把线连到它上面，
 * 动的都是**新的边**，节点本身没变，所以这些不受占用限制（见 `docs/04-realtime-collab.md` §4.0.1）。
 */
export function occupies(peer: PresencePeer, key: string): boolean {
  if (peer.selection.has(key) || peer.transform.has(key)) return true
  return peer.connecting !== null && elementKey("node", peer.connecting.nodeId) === key
}

/** 一个人占着的所有元素 key */
export function occupiedBy(peer: PresencePeer): Set<string> {
  const keys = new Set<string>(peer.selection)
  for (const key of peer.transform.keys()) keys.add(key)
  if (peer.connecting) keys.add(elementKey("node", peer.connecting.nodeId))
  return keys
}

/**
 * 谁占住了这个元素。
 *
 * 两个人几乎同时点同一个元素时 awareness 没有仲裁者，这里定死规则：**clientId 最小者胜**。
 * 每个客户端拿同一份状态算出的赢家都一样，不需要服务端参与，也不会出现
 * 「我以为归我、他以为归他」。
 *
 * 返回 null 表示「这个元素我可以操作」—— 包括赢家就是我自己的情况。
 */
export function lockOwner(
  peers: readonly PresencePeer[],
  key: string,
  localClientId: number
): PresencePeer | null {
  let winner: PresencePeer | null = null
  for (const peer of peers) {
    if (!occupies(peer, key)) continue
    if (!winner || peer.clientId < winner.clientId) winner = peer
  }
  if (!winner || winner.clientId === localClientId) return null
  return winner
}

/** 当前被别人占住的所有元素 key，用来一次性算出画布上哪些东西要变只读 */
export function lockedKeys(
  peers: readonly PresencePeer[],
  localClientId: number
): Set<string> {
  const keys = new Set<string>()
  for (const peer of peers) {
    for (const key of occupiedBy(peer)) {
      if (keys.has(key)) continue
      if (lockOwner(peers, key, localClientId)) keys.add(key)
    }
  }
  return keys
}

/**
 * 别人正操作着的元素此刻的几何 —— 画布要用它盖掉 store 里那份还没更新的值，
 * 对方才能看到节点跟手在动，而不是松手一瞬间瞬移过去。
 *
 * 同一个元素被多人上报（抢占仲裁生效前的一瞬）时同样取 clientId 最小者，
 * 和 `lockOwner` 用的是一把尺子，画面不会和黄框的归属打架。
 */
export function remoteTransforms(
  peers: readonly PresencePeer[],
  localClientId: number
): Map<string, PresencePoint> {
  const owners = new Map<string, PresencePeer>()
  for (const peer of peers) {
    if (peer.clientId === localClientId) continue
    for (const key of peer.transform.keys()) {
      const current = owners.get(key)
      if (!current || peer.clientId < current.clientId) owners.set(key, peer)
    }
  }

  const geometry = new Map<string, PresencePoint>()
  for (const [key, peer] of owners) {
    const point = peer.transform.get(key)
    if (point) geometry.set(key, point)
  }
  return geometry
}
