import * as Y from "yjs"
import type { FlowViewport } from "@shadecn/shared/flow-graph"
import { metaMap, VIEWPORT_KEY } from "@shadecn/shared/flow-doc"

/**
 * Y.Doc → 编辑器响应式状态的投影工具，只有前端用。
 *
 * 文档的形状本身（键名、嵌套结构、`toYNode` / `fromYNode`、v1 读时升级）在
 * `@shadecn/shared/flow-doc`，服务端读写的是同一份实现；这里只放前端 store
 * 把它变成 Vue Flow 能吃的数组时才需要的东西 —— 增量重算、复用对象引用、兜底视口。
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
