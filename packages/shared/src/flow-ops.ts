import * as Y from 'yjs'
import { fromYEdge, fromYNode, toYEdge, toYNode } from './flow-doc.ts'
import type { FlowEdge, FlowNodeRecord } from './flow-graph.ts'
import { boundingRect, groupFrameAround, planAutoLayout, type LayoutLink, type LayoutNode } from './flow-layout.ts'
import {
  connectionEdgeData,
  DEFAULT_EDGE_TYPE,
  GROUP_NODE_TYPE,
  NODE_FORM_KEY,
  nodeFormOf,
  nodeSizeOf,
  resolveConnection,
  type ConnectionContext,
  type NodeForm,
  type NodeSize,
  type ResolvedPorts,
} from './flow-node-types.ts'
import {
  assertNodeFieldsWritable,
  FlowOpError,
  nodeMapOf,
  requireNodeMap,
  writeNodeFields,
  type FlowOpContext,
  type NodeFieldChanges,
} from './flow-ops-core.ts'
import { createId, EDGE_ID_PREFIX } from './id.ts'

// 底座（上下文、错误、按组写字段）在 flow-ops-core.ts；导演台的操作在 director-ops.ts —— 都从这里导出
export {
  assertNodeFieldsWritable,
  FlowOpError,
  opContext,
  writeNodeFields,
  type FlowOpContext,
  type FlowOpErrorCode,
  type NodeFieldChanges,
} from './flow-ops-core.ts'
export * from './director-ops.ts'

/**
 * 画布的原子操作层 —— 编辑器（`apps/web/src/stores/flow`）和 agent（`packages/agent/src/tools.ts`）
 * 写画布内容的**同一份实现**（docs/20 §3.10.1）。
 *
 * ## 形状
 *
 * 每个操作是 `op(ctx, …args) → result`：
 *
 * - **在调用方已经开好的事务里跑，自己从不 `transact`** —— 事务的 origin（`LOCAL_ORIGIN` / agent）、
 *   撤销分段、选中、提示这些都是调用方的事；编辑器是 `store.mutate(ctx => ops.x(ctx, …))`，
 *   agent 是 `canvas.write(doc => ops.x(opContext(doc), …))`。
 * - **先校验、后动手**：Yjs 的事务不回滚，所以每个操作把前提全部查完才写第一笔；
 *   不满足就抛 {@link FlowOpError}，抛出时文档一个字节都没动。
 * - **读的是文档本身**（经 `fromYNode` / `fromYEdge`），语义和编辑器的投影一致：要读节点内容的操作
 *   （连线、复制）把没有合法 position 的节点当不存在，端点不全的边不参与连线规则；
 *   只写不读的操作（写字段、改尺寸）只要求节点在。
 *
 * ## 目标不存在时
 *
 * - 针对**一个**目标的操作（写字段、改尺寸、连线、复制）→ 抛 `NODE_NOT_FOUND`；
 * - 针对**一批**目标的操作（移动、删除、打组的成员）→ 跳过不存在的，返回实际处理了哪些。
 *   协同时别人随时可能删掉其中一个，不该因此丢掉另外几个的改动（拖动一批节点松手时尤其如此）。
 *
 * 编辑器原来对「目标不存在」一律静默不做，它在 store 里把 `FlowOpError` 吞掉，保持原样；
 * agent 把它转成给模型看的错误（带上「先 read_canvas」的提示）。
 *
 * 依赖 DOM 实测的东西（分组框的外接矩形、渲染出来的尺寸）一律是**参数**，操作里不量。
 *
 * 导演台节点的场景 / 时间轴操作（docs/07 §7.3.1）在 `director-ops.ts`，同样的形状，也从这里导出。
 */

export interface Point {
  x: number
  y: number
}

// —— 读（操作内部用，也给调用方拼校验上下文）——

/** 读一个节点（不含 inputs）；不存在或读不出（没有合法 position）返回 null —— 和投影的口径一致 */
export function readNodeRecord(ctx: FlowOpContext, id: string): FlowNodeRecord | null {
  const map = nodeMapOf(ctx, id)
  return map ? fromYNode(id, map) : null
}

/** 连线 / 复制要读节点内容，读不出来（画面上也看不见）就当不存在 */
function requireNodeRecord(ctx: FlowOpContext, id: string, what = '节点'): FlowNodeRecord {
  const record = readNodeRecord(ctx, id)
  if (!record) throw new FlowOpError('NODE_NOT_FOUND', `${what} ${id} 不存在`)
  return record
}

/**
 * 喂给 `resolveConnection` 的画布：类型、业务 data、两端都在的边 —— 和编辑器从投影拼出来的是同样三样，
 * 所以人连的和 agent 连的走同一套规则（docs/13 §3.7）。
 */
export function docConnectionContext(ctx: FlowOpContext): ConnectionContext {
  const records = new Map<string, FlowNodeRecord | null>()
  const recordOf = (id: string): FlowNodeRecord | null => {
    const cached = records.get(id)
    if (cached !== undefined) return cached
    const record = readNodeRecord(ctx, id)
    records.set(id, record)
    return record
  }
  const edges: FlowEdge[] = []
  for (const [id, value] of ctx.edges.entries()) {
    if (!(value instanceof Y.Map)) continue
    const edge = fromYEdge(id, value)
    if (edge && recordOf(edge.source) && recordOf(edge.target)) edges.push(edge)
  }
  return {
    typeOf: (id) => recordOf(id)?.type,
    dataOf: (id) => recordOf(id)?.data,
    edges,
  }
}

/** 两端之间连哪对端口；不能连抛 `CONNECTION_REJECTED`，原因原样带上 */
function pickPorts(
  request: { source: string; target: string; sourcePort?: string | null; targetPort?: string | null },
  context: ConnectionContext,
): ResolvedPorts {
  const verdict = resolveConnection(request, context)
  if (!verdict.ok) throw new FlowOpError('CONNECTION_REJECTED', verdict.reason)
  return { sourcePort: verdict.sourcePort, targetPort: verdict.targetPort }
}

/**
 * 建一条边（纯函数，不写文档）：handle 一律为 null（节点的连接点不带 id），端口和序号写进 `data`
 * （`connectionEdgeData`：有目标端口才有序号，取该端口现有最大 + 1，删线不重排）。
 */
export function buildEdge(
  source: string,
  target: string,
  ports: ResolvedPorts,
  edges: Iterable<Pick<FlowEdge, 'target' | 'data'>>,
  options: { id?: string; label?: string } = {},
): FlowEdge {
  return {
    id: options.id ?? createId(EDGE_ID_PREFIX),
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
    type: DEFAULT_EDGE_TYPE,
    animated: false,
    ...(options.label ? { label: options.label } : {}),
    data: connectionEdgeData(ports, target, edges),
  }
}

// —— 内容 ——

/**
 * 新建一个节点（记录由调用方按注册表拼好：`buildNodeRecord` / 前端的 `buildFlowNode`）。
 * id 已被占用时照旧覆盖（和 `Y.Map.set` 同义）—— id 都出自 `createId()`，不会撞。
 */
export function createNode(ctx: FlowOpContext, record: FlowNodeRecord): FlowNodeRecord {
  ctx.nodes.set(record.id, toYNode(record))
  return record
}

/** 这个节点现在有没有连进来的线（`target` 是它、起点还在的边；从它连出去的不算） */
export function hasIncomingEdges(ctx: FlowOpContext, nodeId: string): boolean {
  for (const [id, value] of ctx.edges.entries()) {
    if (!(value instanceof Y.Map) || value.get('target') !== nodeId) continue
    const edge = fromYEdge(id, value)
    if (edge && readNodeRecord(ctx, edge.source)) return true
  }
  return false
}

/**
 * 原样放进一条**已经定好端口**的边，不选端口。新连一条线走 {@link connect}（它和
 * {@link createConnectedNode} 最后都落到这里）；编辑器的 `addEdge` / `addElements` 也直接用它。
 *
 * **连进一个 asset 形态的节点 = 把它改回 generate**，同一个事务、同一条撤销：有了输入，它就是
 * 「按输入生成」的节点了。这是形态从 asset 回到 generate 的唯一入口 —— 删掉连入的线不会改回去。
 * 要写的那个键先校验（{@link assertNodeFieldsWritable}），不行就在放边之前抛。
 */
export function insertEdge(ctx: FlowOpContext, edge: FlowEdge): FlowEdge {
  const target = readNodeRecord(ctx, edge.target)
  // 和 hasIncomingEdges 同一个口径：起点还在的边才算「有输入」，悬空边不改形态
  const revert =
    target !== null && nodeFormOf(target.type, target.data) === 'asset' && readNodeRecord(ctx, edge.source) !== null
  const formChange: NodeFieldChanges = { set: { [NODE_FORM_KEY]: 'generate' satisfies NodeForm } }
  if (revert) assertNodeFieldsWritable(ctx, edge.target, 'data', formChange)
  ctx.edges.set(edge.id, toYEdge(edge))
  if (revert) writeNodeFields(ctx, edge.target, 'data', formChange)
  return edge
}

/**
 * 给图片 / 视频节点挂上素材（上传完成、或 agent 带着地址新建）：写 `src`（和 `poster`），
 * 并按**此刻有没有连进来的线**定形态 —— 没有就成 `asset`（独立素材，收起输入框、不再接受拖线），
 * 有就保持 `generate`（它是按输入生成的，只是先放了一张图）。一个事务、一条撤销。
 *
 * 已知的竞态（不修，docs/13 §3.7）：本地上传时判定「没有连入」，同一时刻别人连了一条线进来 ——
 * 两边合并后是「asset + 有连入」。读的一侧不回写；下一次连入或上传会把它纠正过来。
 *
 * 返回挂完之后的形态。
 */
export function attachAsset(
  ctx: FlowOpContext,
  nodeId: string,
  asset: { src: string; poster?: string },
): NodeForm {
  const node = requireNodeRecord(ctx, nodeId)
  if (nodeFormOf(node.type, node.data) === null) {
    throw new FlowOpError('NO_FORMS', `${node.type} 节点不能挂素材`)
  }
  const form: NodeForm = hasIncomingEdges(ctx, nodeId) ? 'generate' : 'asset'
  writeNodeFields(ctx, nodeId, 'data', {
    set: {
      src: asset.src,
      ...(asset.poster !== undefined ? { poster: asset.poster } : {}),
      [NODE_FORM_KEY]: form,
    },
  })
  return form
}

export interface ConnectRequest {
  source: string
  target: string
  /** 显式指定端口；不给就由 `resolveConnection` 按声明顺序自动选 */
  sourcePort?: string | null
  targetPort?: string | null
  label?: string
  /** 新边的 id；不给就现发一个 */
  id?: string
}

/** 连一条线：两端都得在，端口由 `resolveConnection` 选 / 校验，边由 {@link buildEdge} 建 */
export function connect(ctx: FlowOpContext, request: ConnectRequest): FlowEdge {
  requireNodeRecord(ctx, request.source, '起点节点')
  requireNodeRecord(ctx, request.target, '终点节点')
  const context = docConnectionContext(ctx)
  const ports = pickPorts(request, context)
  const edge = buildEdge(request.source, request.target, ports, context.edges, {
    id: request.id,
    label: request.label,
  })
  return insertEdge(ctx, edge)
}

export interface ConnectFrom {
  /** 从哪个已有节点连过来 */
  source: string
  sourcePort?: string | null
  /** 新节点的输入端口 */
  targetPort?: string | null
  edgeId?: string
  label?: string
}

/**
 * 新建一个节点，**同一个事务里**从 `from.source` 连一条线过来 —— 一条撤销把两样一起拿掉，
 * 别人也不会先看到一条指向不存在节点的线。
 *
 * 连线规则（逻辑门，只配端口）按新节点的**最终**类型和 data 判（记录里的 data，即默认值 + 调用方给的字段）。
 * 要带素材地址，建完再 {@link attachAsset}（同一个事务里，形态按那时有没有连入定）。
 */
export function createConnectedNode(
  ctx: FlowOpContext,
  record: FlowNodeRecord,
  from: ConnectFrom,
): { node: FlowNodeRecord; edge: FlowEdge } {
  requireNodeRecord(ctx, from.source, '起点节点')
  const context = docConnectionContext(ctx)
  const ports = pickPorts(
    { source: from.source, target: record.id, sourcePort: from.sourcePort, targetPort: from.targetPort },
    {
      ...context,
      typeOf: (id) => (id === record.id ? record.type : context.typeOf(id)),
      dataOf: (id) => (id === record.id ? record.data : context.dataOf(id)),
    },
  )
  const edge = buildEdge(from.source, record.id, ports, context.edges, { id: from.edgeId, label: from.label })
  createNode(ctx, record)
  insertEdge(ctx, edge)
  return { node: record, edge }
}

/** plain JSON 的深拷贝（shared 的 lib 只有 ES2020，没有 `structuredClone`） */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T
  if (value instanceof Uint8Array) return value.slice() as T
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    // fromEntries 按「定义属性」写，`__proto__` 这样的键也只是普通键，不会改到原型
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T
  }
  return value
}

/**
 * 复制一个节点：类型、布局（错开 `offset`）、metadata、业务 data 照抄；**运行态重置为空闲、不带产出**
 * （复本还没跑过，带着原件的产出会让下游以为它已经有结果了）；**连线一条都不复制**。
 *
 * 深拷贝 metadata / data：里面可能有嵌套对象（UI 状态、平铺分键的元素），共用一份引用的话改一个两个都变。
 * 副本是从**读出来的**数据重建的（`fromYNode` → 拷贝 → `toYNode`），不是把 Y 结构拷一份 ——
 * data 里要是出现 `Y.Text` 之类，这里会压扁成字符串（docs/13 §3.7.2）。
 */
export function duplicateNode(
  ctx: FlowOpContext,
  sourceId: string,
  options: { id: string; offset: Point; createdAt?: number },
): FlowNodeRecord {
  const source = requireNodeRecord(ctx, sourceId)
  const clone: FlowNodeRecord = {
    id: options.id,
    type: source.type,
    layout: {
      ...cloneJson(source.layout),
      position: {
        x: source.layout.position.x + options.offset.x,
        y: source.layout.position.y + options.offset.y,
      },
    },
    metadata: { ...cloneJson(source.metadata), createdAt: options.createdAt ?? Date.now() },
    data: cloneJson(source.data),
    runtime: { status: 'idle' },
  }
  return createNode(ctx, clone)
}

// —— 删除 ——

export interface RemovedElements {
  /** 真正删掉的节点（点名了但本来就不在的不算） */
  nodes: string[]
  /** 真正删掉的边：点名的 + 连着被删节点被连带删掉的 */
  edges: string[]
  /** 有几个节点因为分组被删而移出了分组 */
  ungrouped: number
}

/**
 * 删元素。连着被删节点的边一起删 —— 留下悬空的边，画面上没了、数据里还在。
 *
 * 删掉一个分组，组里的节点**留在原地**：只解除归属（清掉 `parentNode` / `extent`），
 * 相对坐标换算回画布坐标。不解除的话它们指向一个不存在的父节点，整组跳到画布原点附近
 * （`NODE_MISSING_PARENT`）。不存在的 id 跳过。
 */
export function removeElements(
  ctx: FlowOpContext,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string>,
): RemovedElements {
  const doomedNodes = new Set<string>()
  for (const id of nodeIds) if (ctx.nodes.has(id)) doomedNodes.add(id)
  const doomedEdges = new Set<string>()
  for (const id of edgeIds) if (ctx.edges.has(id)) doomedEdges.add(id)

  for (const [edgeId, edge] of ctx.edges.entries()) {
    if (!(edge instanceof Y.Map)) continue
    if (doomedNodes.has(edge.get('source') as string) || doomedNodes.has(edge.get('target') as string)) {
      doomedEdges.add(edgeId)
    }
  }

  // 先算好每个孤儿的去处，再动手
  const orphaned: { node: Y.Map<unknown>; position: Point | null }[] = []
  for (const [childId, child] of ctx.nodes.entries()) {
    if (!(child instanceof Y.Map) || doomedNodes.has(childId)) continue
    const parentId = child.get('parentNode')
    if (typeof parentId !== 'string' || !doomedNodes.has(parentId)) continue
    const record = fromYNode(childId, child)
    if (!record) continue
    const parent = readNodeRecord(ctx, parentId)
    orphaned.push({
      node: child,
      // parentNode 下的 position 是相对父节点的；父节点读不出来就只解除归属、位置不动
      position: parent
        ? {
            x: parent.layout.position.x + record.layout.position.x,
            y: parent.layout.position.y + record.layout.position.y,
          }
        : null,
    })
  }

  for (const id of doomedEdges) ctx.edges.delete(id)
  for (const { node, position } of orphaned) {
    node.delete('parentNode')
    node.delete('extent')
    if (position) node.set('position', position)
  }
  for (const id of doomedNodes) ctx.nodes.delete(id)
  return { nodes: [...doomedNodes], edges: [...doomedEdges], ungrouped: orphaned.length }
}

export interface UngroupResult {
  /** 被移出分组的节点（留在原地，坐标换算回画布坐标） */
  children: string[]
  /** 连着分组框本身被连带删掉的边（分组框不可连线，通常为空） */
  edges: string[]
}

/**
 * 解组：拆掉分组框，组里的节点留在原地 —— 就是「删掉这个分组」（{@link removeElements}，
 * 解除归属、换算坐标），只是先确认点名的确实是分组框：解组一个普通节点等于删了它，不能让它这样发生。
 * 不存在抛 `NODE_NOT_FOUND`，不是分组抛 `NOT_A_GROUP`。
 */
export function ungroup(ctx: FlowOpContext, groupId: string): UngroupResult {
  const map = requireNodeMap(ctx, groupId)
  if (map.get('type') !== GROUP_NODE_TYPE) {
    throw new FlowOpError('NOT_A_GROUP', `节点 ${groupId} 不是分组，不能解组`)
  }
  const children: string[] = []
  for (const [childId, child] of ctx.nodes.entries()) {
    if (child instanceof Y.Map && child.get('parentNode') === groupId) children.push(childId)
  }
  const removed = removeElements(ctx, [groupId], [])
  return { children, edges: removed.edges }
}

// —— 布局 ——

/** 不量 DOM 时每个节点按多大算；编辑器有实测尺寸时走自己的（见 `useFlowCanvas`） */
export type NodeSizeOf = (record: FlowNodeRecord) => NodeSize

/** 移动一批节点（只写 `position`）。不存在的跳过，返回真正移动了的 id */
export function moveNodes(ctx: FlowOpContext, positions: Iterable<[string, Point]>): string[] {
  const moved: string[] = []
  for (const [id, position] of positions) {
    const node = nodeMapOf(ctx, id)
    if (!node) continue
    node.set('position', { x: position.x, y: position.y })
    moved.push(id)
  }
  return moved
}

/**
 * 改一个节点的尺寸，顺带改位置（从左上角往外拉时锚点在对角，`x` / `y` 也变）——
 * 同一个事务，别人不会看到位置变了但尺寸没变的中间态。
 */
export function resizeNode(
  ctx: FlowOpContext,
  nodeId: string,
  size: { width: number; height: number; x?: number; y?: number },
): void {
  const node = requireNodeMap(ctx, nodeId)
  node.set('width', size.width)
  node.set('height', size.height)
  if (size.x !== undefined && size.y !== undefined) node.set('position', { x: size.x, y: size.y })
}

/**
 * 打组：新建一个分组框，并把一批节点挂到它下面 —— **同一个事务**（分开写的话，别人会先看到一批
 * `parentNode` 指着还不存在的节点的孤儿，整片跳到原点；撤销也会撤出半拉）。
 *
 * 分组框的位置和尺寸、`children` 里**相对分组框左上角**的位置都由调用方算好传进来（编辑器按实测尺寸算）。
 * `extent: 'parent'` 也在这一笔里写（渲染时机的问题在编辑器的 `extentReady` 挡，不靠晚写文档）。
 * 不存在的成员跳过，返回真正挂上去的 id。
 */
export function groupNodes(
  ctx: FlowOpContext,
  group: FlowNodeRecord,
  children: Iterable<[string, Point]>,
): string[] {
  createNode(ctx, group)
  const attached: string[] = []
  for (const [id, position] of children) {
    const node = nodeMapOf(ctx, id)
    if (!node) continue
    node.set('parentNode', group.id)
    node.set('extent', 'parent')
    node.set('position', { x: position.x, y: position.y })
    attached.push(id)
  }
  return attached
}

export interface GroupFrame {
  /** 分组框左上角（画布坐标） */
  position: Point
  width: number
  height: number
  /** 每个成员挂上去之后的位置 —— **相对分组框左上角** */
  children: Map<string, Point>
}

/**
 * 不量 DOM 时，围住这批节点的分组框该在哪、多大（读文档，不写）：外接矩形按存的位置 + `sizeOf`
 * （默认 `nodeSizeOf`：存的宽高，没有按类型估），留白和编辑器同一套（`groupFrameAround`）。
 * 结果交给 {@link groupNodes}。编辑器不走这里 —— 它按 Vue Flow 实测的矩形算。
 *
 * 能圈的和编辑器的 `groupableNodes` 一样：**顶层**的非分组节点，至少两个（id 去重后）。
 * 编辑器把不能圈的从选区里默默滤掉；这里是点名的，有一个不行就整个拒绝（`NOT_GROUPABLE`），
 * 点名的节点不存在抛 `NODE_NOT_FOUND` —— 没法拿缺了一个的成员去算框。
 */
export function groupFrameFor(
  ctx: FlowOpContext,
  memberIds: Iterable<string>,
  sizeOf: NodeSizeOf = nodeSizeOf,
): GroupFrame {
  const members: FlowNodeRecord[] = []
  for (const id of new Set(memberIds)) {
    const record = requireNodeRecord(ctx, id)
    if (record.type === GROUP_NODE_TYPE) {
      throw new FlowOpError('NOT_GROUPABLE', `${id} 本身是分组，分组不能再被圈进分组`)
    }
    if (record.layout.parentNode) {
      throw new FlowOpError('NOT_GROUPABLE', `${id} 已经在分组 ${record.layout.parentNode} 里，先解组`)
    }
    members.push(record)
  }
  if (members.length < 2) throw new FlowOpError('NOT_GROUPABLE', '至少要两个节点才能打组')

  const rect = boundingRect(members.map((record) => ({ ...record.layout.position, ...sizeOf(record) })))
  // 上面已经保证至少两个成员，rect 不会是 null；这里只为让类型收窄
  if (!rect) throw new FlowOpError('NOT_GROUPABLE', '至少要两个节点才能打组')
  const frame = groupFrameAround(rect)
  const position = { x: frame.x, y: frame.y }
  return {
    position,
    width: frame.width,
    height: frame.height,
    children: new Map(
      members.map((record) => [
        record.id,
        { x: record.layout.position.x - position.x, y: record.layout.position.y - position.y },
      ]),
    ),
  }
}

/**
 * 整张画布自动布局（横向 dagre，`planAutoLayout`）：只排顶层节点，分组连同组内节点整体挪，
 * 连到组内的线按分组计；位置变了的那些一笔 {@link moveNodes} 写进去。返回真正移动了的 id。
 *
 * 尺寸来自 `sizeOf`（默认 `nodeSizeOf`，服务端用）。编辑器不走这里：它拿 Vue Flow 实测的尺寸直接调
 * `planAutoLayout`，再 `store.moveNodes` —— 同一个算法、同一个「一笔写完」，只是尺寸来源不同。
 */
export function autoLayout(ctx: FlowOpContext, options: { sizeOf?: NodeSizeOf } = {}): string[] {
  const sizeOf = options.sizeOf ?? nodeSizeOf
  const nodes: LayoutNode[] = []
  for (const id of ctx.nodes.keys()) {
    const record = readNodeRecord(ctx, id)
    if (!record) continue
    nodes.push({
      id,
      parentNode: record.layout.parentNode,
      position: record.layout.position,
      ...sizeOf(record),
    })
  }
  const links: LayoutLink[] = []
  for (const [id, value] of ctx.edges.entries()) {
    if (!(value instanceof Y.Map)) continue
    const edge = fromYEdge(id, value)
    if (edge) links.push({ source: edge.source, target: edge.target })
  }
  return moveNodes(ctx, planAutoLayout(nodes, links))
}
