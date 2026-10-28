import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { StringEnum, Type, type Static, type TSchema } from '@mariozechner/pi-ai'
import * as Y from 'yjs'
import { edgesMap, nodesMap, toYEdge, toYNode } from '@shadecn/shared/flow-doc'
import { defaultEdgeData, type FlowEdge, type FlowNode } from '@shadecn/shared/flow-graph'
import {
  buildNodeData,
  buildNodeDefaults,
  DEFAULT_EDGE_TYPE,
} from '@shadecn/shared/flow-node-types'
import { createId, EDGE_ID_PREFIX, NODE_ID_PREFIX } from '@shadecn/shared/id'
import type { CanvasHandle } from './canvas.ts'

/**
 * 画布工具 —— agent 读写画布的**唯一**途径（REQ-AGENT §3.2 方案 C）。
 *
 * 三条贯穿全文件的规矩：
 *
 * 1. **一次工具调用 = 一个 Y 事务**（`canvas.write` 一次）。「加节点并连上」这种组合操作
 *    在同一个事务里写完，在线的人看到的要么是节点和线一起出现，要么都没有。
 * 2. **先校验、后动手**：Yjs 事务不回滚（见 `canvas.ts`），所以每个写函数先把全部前提查完，
 *    出错只能在第一次改动之前抛。抛出去的错误由 pi 以 `isError` 回给模型，模型据此改正。
 * 3. **schema v2 的规则由这里守，不交给模型**：节点用 shared 的 `toYNode` + 注册表默认值建，
 *    业务字段平铺、按 key 合并（改正文只 `set('text')`，不整块换 `data`），
 *    已有 key 的类型不变（全是 plain 值，不引入 `Y.Text`）。
 *
 * 参数先过 TypeBox 校验（pi 在调 `execute` 之前做），这里对 id 与长度再查一遍 ——
 * 模型的输出是不可信输入，而这几行比一次误写便宜得多。
 */

// —— 限额 ——

export const TOOL_LIMITS = {
  /** 节点名 */
  label: 80,
  /** 文本节点的正文 */
  text: 8000,
  /** `read_canvas` 最多列出多少个节点 / 连线，超出截断并说明 */
  readNodes: 200,
  readEdges: 400,
  /** `read_canvas` 里每个节点的正文只给开头这么多字 */
  readTextExcerpt: 400,
  /** 一次 `delete_elements` 最多点名多少个 */
  deletePerCall: 20,
  /**
   * 一轮（一个 run）里一共最多删多少个元素（点名的节点 + 连线，不算被连带删掉的边）。
   * 靠规则而不是靠模型自觉（docs/20 §3.9 ②）：被注入的 agent 也删不掉整张画布。
   */
  deletePerRun: 20,
} as const

/** 节点 / 连线 id 的格式 —— 和提及格式 `@{node:<id>}` 认的字符集一致 */
const ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'
const ID_REGEX = new RegExp(ID_PATTERN)

/** 坐标的合理范围：防一个离谱的数把节点扔到看不见的地方 */
const COORD_LIMIT = 1_000_000

/** 一轮里工具之间共享的状态 —— 目前只有删除预算 */
export interface ToolRunState {
  deleted: number
}

export interface CanvasToolDetails {
  /** 给人看的一句话（`AgentToolCallView.summary`） */
  summary: string
  /** 这次调用新建 / 修改 / 删除了哪些元素（写进工具调用日志） */
  elementIds: string[]
}

/**
 * 画布工具 = pi 的 `AgentTool` + 一个「调用开始时给人看的一句话」。
 * 结束时的那句话在 `details.summary` 里（可能比开始时的更准，比如带上了真实的节点名）。
 */
export interface CanvasTool<TParameters extends TSchema = TSchema>
  extends AgentTool<TParameters, CanvasToolDetails> {
  describe(args: Static<TParameters>): string
}

// —— 读 ——

interface NodeView {
  id: string
  type: string
  label: string
  text?: string
  position: { x: number; y: number }
  parentNode?: string
  width?: number
  height?: number
}

interface EdgeView {
  id: string
  source: string
  target: string
  label?: string
}

function readString(map: Y.Map<unknown>, key: string): string | undefined {
  const value = map.get(key)
  return typeof value === 'string' ? value : undefined
}

function readNumber(map: Y.Map<unknown>, key: string): number | undefined {
  const value = map.get(key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一个节点的精简视图；结构不对返回 null（数据可能来自别的客户端，坏一条不拖垮整张图） */
function nodeView(id: string, value: unknown): NodeView | null {
  if (!(value instanceof Y.Map)) return null
  const position = value.get('position') as { x?: unknown; y?: unknown } | undefined
  if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return null
  const data = value.get('data')
  const dataMap = data instanceof Y.Map ? (data as Y.Map<unknown>) : null
  const view: NodeView = {
    id,
    type: readString(value, 'type') ?? 'process',
    label: (dataMap && readString(dataMap, 'label')) ?? '',
    position: { x: position.x, y: position.y },
  }
  const text = dataMap ? readString(dataMap, 'text') : undefined
  if (text !== undefined) view.text = text
  const parentNode = readString(value, 'parentNode')
  if (parentNode !== undefined) view.parentNode = parentNode
  const width = readNumber(value, 'width')
  const height = readNumber(value, 'height')
  if (width !== undefined) view.width = width
  if (height !== undefined) view.height = height
  return view
}

function edgeView(id: string, value: unknown): EdgeView | null {
  if (!(value instanceof Y.Map)) return null
  const source = readString(value, 'source')
  const target = readString(value, 'target')
  if (source === undefined || target === undefined) return null
  const view: EdgeView = { id, source, target }
  const label = readString(value, 'label')
  if (label !== undefined) view.label = label
  return view
}

export function readNodeViews(doc: Y.Doc): NodeView[] {
  const nodes: NodeView[] = []
  for (const [id, value] of nodesMap(doc).entries()) {
    const view = nodeView(id, value)
    if (view) nodes.push(view)
  }
  return nodes
}

export function readEdgeViews(doc: Y.Doc): EdgeView[] {
  const edges: EdgeView[] = []
  for (const [id, value] of edgesMap(doc).entries()) {
    const view = edgeView(id, value)
    if (view) edges.push(view)
  }
  return edges
}

/** 单个节点的视图；不存在返回 null。提及展开（`prompt.ts`）用 */
export function readNodeView(doc: Y.Doc, id: string): NodeView | null {
  return nodeView(id, nodesMap(doc).get(id))
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字，已截断）` : text
}

/**
 * 画布的精简快照：`read_canvas` 的返回值，也是 run 开始时写进沙箱的 `canvas.json`。
 * 节点 / 连线太多时截断，并在 `truncated` 里说清楚截了多少 —— 不说的话模型会以为它看到的就是全部。
 */
export function canvasSnapshot(doc: Y.Doc) {
  const nodes = readNodeViews(doc)
  const edges = readEdgeViews(doc)
  const notes: string[] = []
  if (nodes.length > TOOL_LIMITS.readNodes) {
    notes.push(`节点共 ${nodes.length} 个，只列出前 ${TOOL_LIMITS.readNodes} 个`)
  }
  if (edges.length > TOOL_LIMITS.readEdges) {
    notes.push(`连线共 ${edges.length} 条，只列出前 ${TOOL_LIMITS.readEdges} 条`)
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.slice(0, TOOL_LIMITS.readNodes).map((node) =>
      node.text === undefined ? node : { ...node, text: excerpt(node.text, TOOL_LIMITS.readTextExcerpt) },
    ),
    edges: edges.slice(0, TOOL_LIMITS.readEdges),
    ...(notes.length > 0 ? { truncated: notes.join('；') } : {}),
  }
}

// —— 摆放 ——

/** 量不到渲染尺寸（服务端没有 DOM），按各类型组件的最小尺寸估 */
const ESTIMATED_SIZE: Record<string, { width: number; height: number }> = {
  text: { width: 320, height: 120 },
  process: { width: 360, height: 203 },
}
const FALLBACK_SIZE = { width: 320, height: 160 }
const PLACEMENT_GAP = 80

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 节点在画布坐标下的矩形。组里的子节点 position 是相对父节点的，要加回去 */
function absoluteRects(nodes: NodeView[]): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const rects = new Map<string, Rect>()
  for (const node of nodes) {
    const size = ESTIMATED_SIZE[node.type] ?? FALLBACK_SIZE
    const parent = node.parentNode ? byId.get(node.parentNode) : undefined
    rects.set(node.id, {
      x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0),
      width: node.width ?? size.width,
      height: node.height ?? size.height,
    })
  }
  return rects
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  )
}

/**
 * 没给坐标时给新节点找个地方：有 `near`（`connectFrom` 的那个节点）就放它右边，
 * 否则放在现有内容的右侧；撞上别的节点就往下挪，直到不重叠。
 */
export function placeNewNode(nodes: NodeView[], type: string, nearId?: string) {
  const rects = absoluteRects(nodes)
  if (rects.size === 0) return { x: 0, y: 0 }

  const size = ESTIMATED_SIZE[type] ?? FALLBACK_SIZE
  const near = nearId ? rects.get(nearId) : undefined
  const all = [...rects.values()]
  const start = near
    ? { x: near.x + near.width + PLACEMENT_GAP, y: near.y }
    : {
        x: Math.max(...all.map((rect) => rect.x + rect.width)) + PLACEMENT_GAP,
        y: Math.min(...all.map((rect) => rect.y)),
      }

  const candidate: Rect = { ...start, ...size }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!all.some((rect) => overlaps(candidate, rect, PLACEMENT_GAP / 2))) break
    candidate.y += size.height + PLACEMENT_GAP / 2
  }
  return { x: Math.round(candidate.x), y: Math.round(candidate.y) }
}

// —— 工具定义 ——

const Id = (description: string) => Type.String({ pattern: ID_PATTERN, description })

function assertId(value: string, what: string) {
  if (!ID_REGEX.test(value)) throw new Error(`${what} 不是合法的 id：${JSON.stringify(value.slice(0, 80))}`)
}

function assertLength(value: string, max: number, what: string) {
  if (value.length > max) throw new Error(`${what} 超过 ${max} 字（实际 ${value.length} 字）`)
}

/** 摘要里引用用户内容时截短 —— 摘要是一行字，不是内容 */
function quote(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return `「${trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed}」`
}

function result(text: string, details: CanvasToolDetails): AgentToolResult<CanvasToolDetails> {
  return { content: [{ type: 'text', text }], details }
}

function getNodeMap(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const value = nodesMap(doc).get(id)
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null
}

function nodeLabel(doc: Y.Doc, id: string): string {
  const data = getNodeMap(doc, id)?.get('data')
  const label = data instanceof Y.Map ? data.get('label') : undefined
  return typeof label === 'string' && label ? label : id
}

function buildEdge(source: string, target: string, label?: string): FlowEdge {
  return {
    id: createId(EDGE_ID_PREFIX),
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
    type: DEFAULT_EDGE_TYPE,
    animated: false,
    ...(label ? { label } : {}),
    data: defaultEdgeData(),
  }
}

function hasEdge(doc: Y.Doc, source: string, target: string): boolean {
  for (const value of edgesMap(doc).values()) {
    if (!(value instanceof Y.Map)) continue
    if (value.get('source') === source && value.get('target') === target) return true
  }
  return false
}

const readCanvasParams = Type.Object({}, { additionalProperties: false })

const addNodeParams = Type.Object(
  {
    type: StringEnum(['text', 'process'] as const, {
      description: 'text = 带正文的文本节点；process = 只有名字的流程节点',
    }),
    label: Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label, description: '节点名' }),
    text: Type.Optional(
      Type.String({ maxLength: TOOL_LIMITS.text, description: '正文，只有 text 类型的节点有' }),
    ),
    position: Type.Optional(
      Type.Object(
        {
          x: Type.Number({ minimum: -COORD_LIMIT, maximum: COORD_LIMIT }),
          y: Type.Number({ minimum: -COORD_LIMIT, maximum: COORD_LIMIT }),
        },
        { additionalProperties: false, description: '左上角的画布坐标；不给则自动找空位' },
      ),
    ),
    connectFrom: Type.Optional(Id('给了就同时从这个已有节点连一条线到新节点')),
  },
  { additionalProperties: false },
)

const updateNodeParams = Type.Object(
  {
    id: Id('要修改的节点 id'),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label })),
    text: Type.Optional(
      Type.String({ maxLength: TOOL_LIMITS.text, description: '新的正文（整段替换），只有 text 类型的节点有' }),
    ),
  },
  { additionalProperties: false },
)

const connectParams = Type.Object(
  {
    source: Id('起点节点 id'),
    target: Id('终点节点 id'),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label })),
  },
  { additionalProperties: false },
)

const deleteParams = Type.Object(
  {
    ids: Type.Array(Id('节点或连线的 id'), {
      minItems: 1,
      maxItems: TOOL_LIMITS.deletePerCall,
      description: '要删除的节点 / 连线 id。删节点会连带删掉连着它的线；删分组只解散，组里的节点留在原地',
    }),
  },
  { additionalProperties: false },
)

export interface CanvasToolsOptions {
  canvas: CanvasHandle
  /** 一轮共享的状态；不给就每次 `createCanvasTools` 新建一份 */
  runState?: ToolRunState
}

/** 一轮 agent 能用的画布工具 */
export function createCanvasTools(options: CanvasToolsOptions): CanvasTool[] {
  const { canvas } = options
  const runState = options.runState ?? { deleted: 0 }

  const readCanvas: CanvasTool<typeof readCanvasParams> = {
    name: 'read_canvas',
    label: '读取画布',
    description:
      '读取当前画布的全部节点（id / 类型 / 名字 / 正文摘要 / 坐标 / 所属分组）和连线。' +
      '修改或连线之前先调它拿到真实的 id，不要猜。',
    parameters: readCanvasParams,
    executionMode: 'sequential',
    describe: () => '读取画布',
    async execute() {
      const snapshot = await canvas.read(canvasSnapshot)
      return result(JSON.stringify(snapshot), {
        summary: `读取画布（${snapshot.nodeCount} 个节点、${snapshot.edgeCount} 条连线）`,
        elementIds: [],
      })
    },
  }

  const addNode: CanvasTool<typeof addNodeParams> = {
    name: 'add_node',
    label: '新建节点',
    description: '在画布上新建一个节点；可以顺带从一个已有节点连线过来。返回新节点的 id。',
    parameters: addNodeParams,
    executionMode: 'sequential',
    describe: (args) => `新建节点${quote(args.label)}`,
    async execute(_id, args) {
      assertLength(args.label, TOOL_LIMITS.label, '节点名')
      if (args.text !== undefined) assertLength(args.text, TOOL_LIMITS.text, '正文')
      if (args.connectFrom !== undefined) assertId(args.connectFrom, 'connectFrom')
      if (args.type !== 'text' && args.text !== undefined) {
        throw new Error('只有 text 类型的节点有正文；流程节点只能起名字')
      }

      const created = await canvas.write((doc) => {
        if (args.connectFrom !== undefined && !getNodeMap(doc, args.connectFrom)) {
          throw new Error(`connectFrom 指向的节点 ${args.connectFrom} 不存在，先 read_canvas 确认 id`)
        }
        const position = args.position ?? placeNewNode(readNodeViews(doc), args.type, args.connectFrom)
        const node: FlowNode = {
          id: createId(NODE_ID_PREFIX),
          type: args.type,
          position: { x: position.x, y: position.y },
          ...buildNodeDefaults(args.type),
          data: buildNodeData(args.type, args.label),
        }
        if (args.type === 'text' && args.text !== undefined) node.data.text = args.text

        // 节点和那条线同一个事务：在线的人看到的要么一起出现，要么都没有
        nodesMap(doc).set(node.id, toYNode(node))
        const edge = args.connectFrom !== undefined ? buildEdge(args.connectFrom, node.id) : null
        if (edge) edgesMap(doc).set(edge.id, toYEdge(edge))
        return { node, edge }
      })

      const ids = [created.node.id, ...(created.edge ? [created.edge.id] : [])]
      return result(
        JSON.stringify({
          id: created.node.id,
          position: created.node.position,
          ...(created.edge ? { edgeId: created.edge.id } : {}),
        }),
        { summary: `新建节点${quote(args.label)}`, elementIds: ids },
      )
    },
  }

  const updateNode: CanvasTool<typeof updateNodeParams> = {
    name: 'update_node',
    label: '修改节点',
    description:
      '修改一个已有节点的名字和/或正文。只改给出的字段，其余字段原样保留。' +
      '用户要求改某个具体节点（例如 @ 提及的那个）的内容时用它。',
    parameters: updateNodeParams,
    executionMode: 'sequential',
    describe: (args) => `修改节点 ${args.id}`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      if (args.label === undefined && args.text === undefined) {
        throw new Error('label 和 text 至少给一个')
      }
      if (args.label !== undefined) assertLength(args.label, TOOL_LIMITS.label, '节点名')
      if (args.text !== undefined) assertLength(args.text, TOOL_LIMITS.text, '正文')

      const label = await canvas.write((doc) => {
        const node = getNodeMap(doc, args.id)
        if (!node) throw new Error(`节点 ${args.id} 不存在（可能已被删除），先 read_canvas 确认`)
        const data = node.get('data')
        if (!(data instanceof Y.Map)) throw new Error(`节点 ${args.id} 的数据结构不对，不能修改`)
        if (args.text !== undefined && node.get('type') !== 'text') {
          throw new Error(`节点 ${args.id} 不是文本节点，没有正文；只能改名字`)
        }
        // 按 key 合并：只 set 给出的那几个，别人同时改的别的字段不受影响
        if (args.label !== undefined) data.set('label', args.label)
        if (args.text !== undefined) data.set('text', args.text)
        return nodeLabel(doc, args.id)
      })

      return result(`已修改节点 ${args.id}`, {
        summary: `修改节点${quote(label)}`,
        elementIds: [args.id],
      })
    },
  }

  const connect: CanvasTool<typeof connectParams> = {
    name: 'connect',
    label: '连线',
    description: '从一个节点连一条线到另一个节点。两端必须都存在，同方向已有线时不重复连。',
    parameters: connectParams,
    executionMode: 'sequential',
    describe: (args) => `连线 ${args.source} → ${args.target}`,
    async execute(_id, args) {
      assertId(args.source, 'source')
      assertId(args.target, 'target')
      if (args.label !== undefined) assertLength(args.label, TOOL_LIMITS.label, '连线标签')
      if (args.source === args.target) throw new Error('起点和终点不能是同一个节点')

      const created = await canvas.write((doc) => {
        for (const end of [args.source, args.target]) {
          if (!getNodeMap(doc, end)) throw new Error(`节点 ${end} 不存在，先 read_canvas 确认 id`)
        }
        if (hasEdge(doc, args.source, args.target)) {
          throw new Error(`${args.source} → ${args.target} 已经有一条线了`)
        }
        const edge = buildEdge(args.source, args.target, args.label)
        edgesMap(doc).set(edge.id, toYEdge(edge))
        return {
          edge,
          summary: `连线${quote(nodeLabel(doc, args.source))} → ${quote(nodeLabel(doc, args.target))}`,
        }
      })

      return result(JSON.stringify({ id: created.edge.id }), {
        summary: created.summary,
        elementIds: [created.edge.id],
      })
    },
  }

  const deleteElements: CanvasTool<typeof deleteParams> = {
    name: 'delete_elements',
    label: '删除',
    description:
      `删除节点或连线。删节点会连带删掉连着它的线；删分组只是解散，组里的节点留在原地。` +
      `一轮对话最多删 ${TOOL_LIMITS.deletePerRun} 个，超出会被拒绝 —— 那种量请让用户自己删。`,
    parameters: deleteParams,
    executionMode: 'sequential',
    describe: (args) => `删除 ${args.ids.length} 个元素`,
    async execute(_id, args) {
      const ids = [...new Set(args.ids)]
      for (const id of ids) assertId(id, 'ids 里的元素')
      if (ids.length > TOOL_LIMITS.deletePerCall) {
        throw new Error(`一次最多删 ${TOOL_LIMITS.deletePerCall} 个`)
      }
      if (runState.deleted + ids.length > TOOL_LIMITS.deletePerRun) {
        throw new Error(
          `本轮已删除 ${runState.deleted} 个元素，再删 ${ids.length} 个会超过每轮上限 ${TOOL_LIMITS.deletePerRun}，已拒绝。` +
            '请告诉用户需要删除哪些，由用户自己删。',
        )
      }

      const removed = await canvas.write((doc) => {
        const nodes = nodesMap(doc)
        const edges = edgesMap(doc)
        const doomedNodes = new Set<string>()
        const doomedEdges = new Set<string>()
        const missing: string[] = []
        for (const id of ids) {
          if (nodes.has(id)) doomedNodes.add(id)
          else if (edges.has(id)) doomedEdges.add(id)
          else missing.push(id)
        }
        if (missing.length > 0) {
          throw new Error(`这些 id 不存在：${missing.join(', ')}；先 read_canvas 确认`)
        }

        // 连着被删节点的线一起删 —— 留着就是悬空的边
        for (const [edgeId, edge] of edges.entries()) {
          if (!(edge instanceof Y.Map)) continue
          if (doomedNodes.has(edge.get('source') as string) || doomedNodes.has(edge.get('target') as string)) {
            doomedEdges.add(edgeId)
          }
        }

        /*
         * 删分组 = 解散，和前端 `store.removeElements` 同一个语义：子节点清掉 parentNode / extent，
         * 相对坐标换算回画布坐标。不这么做的话子节点指向一个不存在的父节点，整组跳到原点附近
         * （`NODE_MISSING_PARENT`）。
         */
        const orphaned: { node: Y.Map<unknown>; position: { x: number; y: number } }[] = []
        for (const [childId, child] of nodes.entries()) {
          if (!(child instanceof Y.Map) || doomedNodes.has(childId)) continue
          const parentId = child.get('parentNode')
          if (typeof parentId !== 'string' || !doomedNodes.has(parentId)) continue
          const parent = nodes.get(parentId)
          const parentPos = parent instanceof Y.Map ? (parent.get('position') as { x: number; y: number }) : null
          const childPos = child.get('position') as { x: number; y: number }
          orphaned.push({
            node: child,
            position: parentPos
              ? { x: parentPos.x + childPos.x, y: parentPos.y + childPos.y }
              : { x: childPos.x, y: childPos.y },
          })
        }

        for (const edgeId of doomedEdges) edges.delete(edgeId)
        for (const { node, position } of orphaned) {
          node.delete('parentNode')
          node.delete('extent')
          node.set('position', position)
        }
        for (const nodeId of doomedNodes) nodes.delete(nodeId)
        return { nodes: [...doomedNodes], edges: [...doomedEdges], ungrouped: orphaned.length }
      })

      runState.deleted += ids.length
      const parts = [`删除 ${removed.nodes.length} 个节点`, `${removed.edges.length} 条连线`]
      if (removed.ungrouped > 0) parts.push(`${removed.ungrouped} 个节点移出了被删的分组`)
      return result(JSON.stringify(removed), {
        summary: parts.join('、'),
        elementIds: [...removed.nodes, ...removed.edges],
      })
    },
  }

  return [readCanvas, addNode, updateNode, connect, deleteElements] as unknown as CanvasTool[]
}
