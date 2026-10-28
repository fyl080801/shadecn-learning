import * as Y from "yjs"
import {
  deriveInputs,
  groupEdgesByTarget,
  type FlowEdge,
  type FlowNode,
  type FlowNodeInput,
  type FlowNodeRecord,
  type FlowViewport
} from "@shadecn/shared/flow-graph"
import { metaMap, VIEWPORT_KEY } from "@shadecn/shared/flow-doc"

/**
 * Y.Doc → 编辑器响应式状态的投影工具，只有前端用。
 *
 * 文档的形状本身（键名、嵌套结构、`toYNode` / `fromYNode`、节点五组的规范化）在
 * `@shadecn/shared/flow-doc`，服务端读写的是同一份实现；这里只放前端 store
 * 把它变成 Vue Flow 能吃的数组时才需要的东西 —— 增量重算、复用对象引用、inputs 的增量派生、兜底视口。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// —— 增量投影 ——

/**
 * 从一批 `observeDeep` 事件里挑出「哪些顶层键变了」。
 *
 * 事件分两种，都要认：
 * - **直接改这张 Map**（增删节点）：`event.path` 为空，变化的键在 `event.changes.keys` 里；
 * - **改某个节点内部**（拖位置、改标题）：`event.path[0]` 就是那个节点的 id。
 *
 * 返回 null 表示「说不清，全量重来」—— 宁可退回全量也不要漏掉一个键，
 * 漏掉的后果是画面和文档不一致，比多算一次贵得多。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs 的 observeDeep 回调就是这个签名
export function changedTopLevelKeys(events: Y.YEvent<any>[]): Set<string> | null {
  const keys = new Set<string>()
  for (const event of events) {
    if (event.path.length === 0) {
      for (const key of event.changes.keys.keys()) keys.add(key)
      continue
    }
    const first = event.path[0]
    if (typeof first !== "string") return null
    keys.add(first)
  }
  return keys
}

/**
 * 按 Y.Map 当前的键顺序重建数组，**只对变化的键重新解析**，其余复用上一轮的对象。
 *
 * 复用对象引用不只是省 CPU：Vue Flow 靠引用判断节点要不要重新同步，
 * 引用不变的节点它就不碰。
 *
 * `cache` 会被就地更新（删掉已经不存在的键），调用方持有它跨轮复用。
 */
export function projectMap<T extends { id: string }>(
  source: Y.Map<Y.Map<unknown>>,
  cache: Map<string, T>,
  changed: Set<string> | null,
  parse: (id: string, value: Y.Map<unknown>) => T | null,
): T[] {
  const result: T[] = []
  const alive = new Set<string>()

  for (const [id, value] of source.entries()) {
    alive.add(id)
    let item = cache.get(id)
    // changed 为 null = 全量重算；否则只有点名的那些要重新解析
    if (item === undefined || changed === null || changed.has(id)) {
      if (!(value instanceof Y.Map)) {
        cache.delete(id)
        continue
      }
      const parsed = parse(id, value)
      if (!parsed) {
        cache.delete(id)
        continue
      }
      item = parsed
      cache.set(id, item)
    }
    result.push(item)
  }

  for (const id of [...cache.keys()]) {
    if (!alive.has(id)) cache.delete(id)
  }
  return result
}

/** 快照里那份兜底视口；没有或不合法返回 null */
export function readFallbackViewport(doc: Y.Doc): FlowViewport | null {
  const viewport = metaMap(doc).get(VIEWPORT_KEY)
  if (
    !isRecord(viewport) ||
    typeof viewport.x !== "number" ||
    typeof viewport.y !== "number" ||
    typeof viewport.zoom !== "number" ||
    viewport.zoom <= 0
  ) {
    return null
  }
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

// —— 节点投影：存下来的部分 + 派生的 inputs ——

/**
 * 两个 JSON 值是否相等。只用来判断「上游的产出到底变没变」—— Y.Map 每次 `toJSON()`
 * 都给新对象，按引用比会把每次重读都当成变化，下游的 inputs 就白白重算、白白换引用。
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function sameInputs(a: readonly FlowNodeInput[], b: readonly FlowNodeInput[]): boolean {
  if (a.length !== b.length) return false
  return a.every((input, index) => {
    const other = b[index]!
    return (
      input.port === other.port &&
      input.index === other.index &&
      input.edgeId === other.edgeId &&
      input.source === other.source &&
      input.sourcePort === other.sourcePort &&
      jsonEqual(input.value, other.value)
    )
  })
}

const NO_EDGES: readonly FlowEdge[] = Object.freeze([])

/**
 * 增量地把「存下来的节点」+「可见的边」拼成带 `inputs` 的节点数组。
 *
 * **对象身份是这里的产品**：Vue Flow 靠引用判断节点要不要重新同步，节点组件靠引用跳过重渲染，
 * 所以没受影响的节点必须原样交出上一轮那个对象。一个节点要换新对象，只有两种原因：
 *
 * 1. **它自己的记录变了**（`projectMap` 给了新对象）—— inputs 能复用就复用；
 * 2. **它的 inputs 变了**，而 inputs 只取决于两样东西：
 *    - 连进它的边：按目标分桶后和上一轮逐个比引用（`projectMap` 对没动的边保留引用）。
 *      端口和序号都在边的 `data` 上（`sourcePort` / `targetPort` / `index`），改了它们边就是新对象，
 *      所以增删、改端点、改端口、改序号都会让桶变样；端点节点没了的边已被过滤，桶也会变；
 *    - 上游节点的 `runtime.outputs`：只有记录真的换了、且产出**按值**变了的上游才算数
 *      （改上游的名字、拖上游的位置不会波及下游）。value 取的是 `outputs[data.sourcePort]`。
 *
 * 失效范围因此是「变了的节点 + 入边变了的节点 + 产出变了的节点的直接下游」，其余一概复用。
 * 每一轮仍要按 id 走一遍数组（O(N + E)，只比引用），但**解析**只发生在受影响的那几个上 ——
 * 和 `projectMap` 对文档的增量重读是同一个思路。
 */
export function createNodeProjector() {
  let previousRecords = new Map<string, FlowNodeRecord>()
  let previousIncoming = new Map<string, readonly FlowEdge[]>()
  let previousNodes = new Map<string, FlowNode>()

  function project(records: readonly FlowNodeRecord[], edges: readonly FlowEdge[]): FlowNode[] {
    const recordById = new Map<string, FlowNodeRecord>()
    for (const record of records) recordById.set(record.id, record)
    const incoming = groupEdgesByTarget(edges)

    // 产出按值变了的上游：它们的直接下游要重算 inputs
    const outputsChanged = new Set<string>()
    for (const record of records) {
      const before = previousRecords.get(record.id)
      if (before === record) continue
      if (!before || !jsonEqual(before.runtime.outputs, record.runtime.outputs)) outputsChanged.add(record.id)
    }

    const nextNodes = new Map<string, FlowNode>()
    const result = records.map((record) => {
      const edgesIn = incoming.get(record.id) ?? NO_EDGES
      const previous = previousNodes.get(record.id)
      const recordSame = previousRecords.get(record.id) === record

      let inputs = previous?.inputs
      const inputsStale =
        !previous ||
        !sameList(edgesIn, previousIncoming.get(record.id) ?? NO_EDGES) ||
        edgesIn.some((edge) => outputsChanged.has(edge.source))
      if (inputsStale) {
        const derived = deriveInputs(edgesIn, (id) => recordById.get(id))
        inputs = previous && sameInputs(previous.inputs, derived) ? previous.inputs : derived
      }

      const node =
        previous && recordSame && inputs === previous.inputs
          ? previous
          : { ...record, inputs: inputs ?? [] }
      nextNodes.set(record.id, node)
      return node
    })

    previousRecords = recordById
    previousIncoming = incoming
    previousNodes = nextNodes
    return result
  }

  function reset() {
    previousRecords = new Map()
    previousIncoming = new Map()
    previousNodes = new Map()
  }

  return { project, reset }
}

export type NodeProjector = ReturnType<typeof createNodeProjector>
