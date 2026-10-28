import type { FlowNodeData } from "@/types/flow"

/**
 * 「平铺分键」—— 一批会被各人各改各的元素，怎么放进节点的 `data`。
 *
 * ## 它解决什么
 *
 * Y.Map 的合并粒度是 key。一个功能如果把一整批元素塞进 `data` 的**一个**键
 * （`data.scene = { objects: [...] }`），那这批元素就共用一个合并单位：
 * 甲摆角色 A、乙同时摆角色 B，后到的那次把整块盖掉 —— 明明改的是不同的东西。
 * 这和 v1 把业务字段裹在 `data.config` 里是同一个 bug，只是下沉了一层。
 *
 * 拆细合并粒度有两条路，这里走的是第二条：
 *
 * 1. **树更深** —— 把 `scene` 变成嵌套的 `Y.Map`，元素各占一个子 key。
 *    合并粒度最细（一次改动的 update 只有几十字节），但它把**结构**搬进了 CRDT 层，
 *    代价是不可接受的：Y.Doc 没有版本号，新老客户端会同时往同一个 key 上写
 *    **不同的类型**，赢家由 clientID 决定（等于随机），输家的整棵子树直接消失，
 *    而且输的那一方的代码当场 `TypeError`。这不是「读不懂就透传」能兜住的问题 ——
 *    读时升级只对**形状**有效，对**类型**无效。
 * 2. **key 更细**（本模块）—— `data` 仍然是**一层** Y.Map、值仍然全是普通 JSON，
 *    只是把一批元素摊成 `<前缀>.<id>` 这样一串平级的键。
 *
 * 第二条对 CRDT 层完全不可见：`toYNode` / `fromYNode`（含服务端那份）一行不用改，
 * `duplicateNode` 的「投影 → structuredClone → toYNode」照跑，服务端连知道都不用知道。
 * 老客户端读到一堆不认识的键，`normalizeNodeData` 原样透传 —— 现有代码已经是这个行为。
 * 所谓 schema 退化成一个**命名约定**，而命名约定的版本兼容就是普通的读时兼容
 * （换了前缀就两个都认一段时间），和 v1→v2 用的是同一套办法。
 *
 * 实测（导演台样例，`data` 43.7KB）：整块存 → 改一个元素要广播 26,626 字节且并发必然覆盖；
 * 平铺分键 → 3,358 字节、并发保住两边；代价是 doc 体积 +5%、内存 +14%。
 *
 * ## 三条硬规则
 *
 * - **值必须是「整体替换」的普通 JSON，不许是 Y 类型。** 这是整条约定的根：
 *   一旦往里放 Y.Map / Y.Array，上面第 1 条的版本偏斜就全回来了。
 * - **id 必须稳定，不能是下标。** 下标会因为别人的增删而错位，写就打到别人身上了。
 *   源数据没有 id 就先补一个（业务侧生成，用 `createId()`），别拿数组位置凑合。
 * - **前缀之间不许嵌套。** `dc.obj` 和 `dc.obj.pose` 同时存在的话，
 *   `dc.obj` + `pose.x` 和 `dc.obj.pose` + `x` 会撞成同一个键。
 *
 * ## 粒度到哪儿为止
 *
 * 拆到「一个元素一个键」就够，不必再往元素内部拆。两个人同时改**同一个元素**
 * 仍然只剩一边 —— 那一格靠占用锁（`src/lib/presence.ts`，已实现未启用），不靠 CRDT：
 * 两人同时摆同一个 3D 角色，就算合并得再干净，交互本身也是混乱的，那里要的是排他。
 *
 * 同理，**拖动中的中间态不要往这里写**，和节点拖动一条规矩（见 `useFlowCanvas`）：
 * 中间帧走 awareness 反馈层，松手才提交一次。
 */

/** 前缀和 id 之间的分隔符。id 里可以随便带 `.` / `:` —— 解析时按前缀长度切，不按分隔符搜 */
const SEPARATOR = "."

/** 拼一个集合元素的键：`<前缀>.<id>` */
export function collectionKey(prefix: string, id: string): string {
  return `${prefix}${SEPARATOR}${id}`
}

/** 这个键属于该集合吗 */
export function isCollectionKey(prefix: string, key: string): boolean {
  return key.length > prefix.length + 1 && key.startsWith(prefix + SEPARATOR)
}

/** 从键里取回 id；不属于该集合返回 null */
export function collectionIdOf(prefix: string, key: string): string | null {
  return isCollectionKey(prefix, key) ? key.slice(prefix.length + 1) : null
}

/**
 * 把 `data` 上属于该集合的键读成 `id → 元素`。
 *
 * **返回的顺序不可依赖**：它来自 Y.Map 的插入顺序，而各人收到更新的先后不一样，
 * 同一份文档在两台机器上迭代出来的顺序可以不同。要排序就让元素自己带排序字段
 * （`index` / `time` / `createdAt`），由调用方排。
 */
export function readCollection<T = unknown>(
  data: Readonly<FlowNodeData>,
  prefix: string
): Map<string, T> {
  const out = new Map<string, T>()
  for (const [key, value] of Object.entries(data)) {
    const id = collectionIdOf(prefix, key)
    if (id !== null && value !== undefined) out.set(id, value as T)
  }
  return out
}

/** `data` 上属于该集合的所有键 —— 整批删除时喂给 `store.writeNodeData({ remove })` */
export function collectionKeys(data: Readonly<FlowNodeData>, prefix: string): string[] {
  return Object.keys(data).filter((key) => isCollectionKey(prefix, key))
}

/**
 * 把一批元素摊成可以直接并进 `data` 的键值对。
 *
 * 建新节点时喂给注册表的 `defaultData()`，或者整批写入时喂给
 * `store.writeNodeData(id, { set: spreadCollection(...) })`。
 *
 * @param idOf 从元素上取稳定 id。取不出来（返回空串）的元素会被跳过 ——
 *   宁可少一个也不要拿下标顶上，那正是这套约定要避免的东西。
 */
export function spreadCollection<T>(
  prefix: string,
  items: Iterable<T>,
  idOf: (item: T) => string
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const item of items) {
    const id = idOf(item)
    if (id) out[collectionKey(prefix, id)] = item
  }
  return out
}
