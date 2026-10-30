import * as Y from 'yjs'
import { edgesMap, metaMap, nodesMap, type FlowNodeGroup } from './flow-doc.ts'

/**
 * 原子操作层的底座：上下文、错误、按组写字段。
 *
 * 单独成一个文件只为了不成环 —— `flow-ops.ts`（画布操作）和 `director-ops.ts`（导演台操作）都依赖它，
 * `flow-ops.ts` 再把两边一起导出。调用方一律从 `@shadecn/shared/flow-ops` 拿，不直接 import 这里。
 */

/** `mutate()` 回调拿到的东西，也是每个原子操作的第一个参数 */
export interface FlowOpContext {
  doc: Y.Doc
  nodes: Y.Map<Y.Map<unknown>>
  edges: Y.Map<Y.Map<unknown>>
  meta: Y.Map<unknown>
}

/** 按文档拼一个操作上下文（agent 的 `canvas.write(doc => …)` 里用） */
export function opContext(doc: Y.Doc): FlowOpContext {
  return { doc, nodes: nodesMap(doc), edges: edgesMap(doc), meta: metaMap(doc) }
}

export type FlowOpErrorCode =
  /** 点名的节点不存在（或没有合法的 position，等同不存在） */
  | 'NODE_NOT_FOUND'
  /** 节点的 metadata / data / runtime 这个 key 上不是 Y.Map —— 不覆盖 */
  | 'GROUP_NOT_MAP'
  /** 字段的类型首次写入即固定：已有的 Y 类型不能被改写 / 删掉，已有的普通值不能换成 Y 类型 */
  | 'KEY_TYPE_LOCKED'
  /** `resolveConnection` 不让连；`message` 就是它给的原因 */
  | 'CONNECTION_REJECTED'
  /** 这个类型没有「生成 / 素材」形态，不能挂素材（`attachAsset`） */
  | 'NO_FORMS'
  /** 点名的节点不是分组框（`ungroup`） */
  | 'NOT_A_GROUP'
  /** 这批节点不能圈成一个分组（不够两个、有分组框、有已经在别的分组里的）—— `groupFrameFor` */
  | 'NOT_GROUPABLE'
  /** 点名的节点不是导演台（导演台操作只认 `director` 类型） */
  | 'NOT_A_DIRECTOR'
  /** 导演台里点名的对象 / 轨道 / 关键帧不存在 */
  | 'DIRECTOR_ELEMENT_NOT_FOUND'
  /** 导演台操作的参数不合法（NaN、超范围、未知种类、属性和对象种类对不上…） */
  | 'DIRECTOR_INVALID'
  /** 超过导演台的上限（对象 / 轨道 / 关键帧个数、单次批量条数、单个事务的体积） */
  | 'DIRECTOR_LIMIT'

/** 原子操作的前提不满足。抛出时文档没有被改动 */
export class FlowOpError extends Error {
  readonly code: FlowOpErrorCode

  constructor(code: FlowOpErrorCode, message: string) {
    super(message)
    this.name = 'FlowOpError'
    this.code = code
  }
}

/** 一组字段的改动：`set` 逐 key 写（值为 `undefined` 的跳过），`remove` 逐 key 删 */
export interface NodeFieldChanges {
  set?: Record<string, unknown>
  remove?: Iterable<string>
}

/** 节点的那层 Y.Map；不存在（或不是 Y.Map）返回 null */
export function nodeMapOf(ctx: FlowOpContext, id: string): Y.Map<unknown> | null {
  const value = ctx.nodes.get(id)
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null
}

/** 写字段 / 改尺寸只要求节点在（是个 Y.Map）—— 读不出 position 的坏节点照样能改，和编辑器原来一致 */
export function requireNodeMap(ctx: FlowOpContext, id: string): Y.Map<unknown> {
  const map = nodeMapOf(ctx, id)
  if (!map) throw new FlowOpError('NODE_NOT_FOUND', `节点 ${id} 不存在`)
  return map
}

/**
 * 校验 {@link writeNodeFields} 能不能写，不写任何东西。一次要改好几组（agent 的 `update_node` 同时改
 * metadata 和 data）时先把每一组都校验一遍再动手 —— 事务不回滚，不能写了一半才发现另一半不行。
 */
export function assertNodeFieldsWritable(
  ctx: FlowOpContext,
  nodeId: string,
  group: FlowNodeGroup,
  changes: NodeFieldChanges,
): void {
  const value = requireNodeMap(ctx, nodeId).get(group)
  // 老节点（v1 / v2 写的）没有这一组：写的时候现建，没有已有的 key 要比
  if (value === undefined) return
  if (!(value instanceof Y.Map)) {
    throw new FlowOpError('GROUP_NOT_MAP', `节点 ${nodeId} 的 ${group} 结构不对，不能修改`)
  }
  const map = value as Y.Map<unknown>
  const locked = (key: string) =>
    new FlowOpError('KEY_TYPE_LOCKED', `${group}.${key} 是协同编辑的结构化字段，不能整体改写`)
  for (const key of changes.remove ?? []) {
    if (map.get(key) instanceof Y.AbstractType) throw locked(key)
  }
  for (const [key, next] of Object.entries(changes.set ?? {})) {
    if (next === undefined) continue
    const current = map.get(key)
    if (current instanceof Y.AbstractType) throw locked(key)
    if (next instanceof Y.AbstractType && current !== undefined) {
      throw new FlowOpError('KEY_TYPE_LOCKED', `${group}.${key} 已经是普通值，不能换成协同结构`)
    }
  }
}

/**
 * 改一个节点**某一组**（metadata / data / runtime）上的若干键 —— 写和删在同一个事务里。
 *
 * 逐个 key 写，不整块替换：Y.Map 的合并粒度就是 key，甲改 `metadata.label`、乙同时改 `data.prompt`，两边都留。
 * 老节点没有这一组时现建；这一组的 key 上是别的类型、或者要碰的字段类型对不上，抛错（规则见
 * {@link assertNodeFieldsWritable}）—— key 的类型首次写入即固定，换类型会让写它的另一方整棵子树消失。
 *
 * layout 不走这里：位置、尺寸、分组归属各有自己的操作（`moveNodes` / `resizeNode` /
 * `groupNodes` / `removeElements`）。
 */
export function writeNodeFields(
  ctx: FlowOpContext,
  nodeId: string,
  group: FlowNodeGroup,
  changes: NodeFieldChanges,
): void {
  const remove = [...(changes.remove ?? [])]
  const set = changes.set ?? {}
  assertNodeFieldsWritable(ctx, nodeId, group, { set, remove })
  const node = requireNodeMap(ctx, nodeId)
  let target = node.get(group) as Y.Map<unknown> | undefined
  if (target === undefined) {
    target = new Y.Map<unknown>()
    node.set(group, target)
  }
  for (const key of remove) target.delete(key)
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined) target.set(key, value)
  }
}
