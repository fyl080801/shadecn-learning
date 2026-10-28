import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { StringEnum, Type, type Static, type TSchema } from '@mariozechner/pi-ai'
import * as Y from 'yjs'
import {
  edgesMap,
  fromYEdge,
  nodeGroupMap,
  nodesMap,
  readNodes,
  toYEdge,
  toYNode,
} from '@shadecn/shared/flow-doc'
import { type FlowEdge, type FlowNode } from '@shadecn/shared/flow-graph'
import {
  buildNodeRecord,
  DEFAULT_EDGE_TYPE,
  FLOW_NODE_TYPE_DEFAULTS,
  GROUP_NODE_TYPE,
  portsOf,
  connectionEdgeData,
  resolveConnection,
  type ResolvedPorts,
  type PortDef,
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
 * 3. **schema v3 的规则由这里守，不交给模型**：节点用 shared 的 `buildNodeRecord` + `toYNode` 建，
 *    写按组（metadata / data）、按 key 合并（改一个业务字段只 `set` 那一个 key，不整块换），
 *    连线走 shared 的 `resolveConnection`（自动选端口 + 校验）—— 和前端拉线时是同一个函数；
 *    选出来的端口写在边的 `data.sourcePort` / `data.targetPort` 上，handle 一律为 null。
 *    值一律是 plain JSON，不引入 Y 类型；已有 key 上是 Y 类型的拒绝改写（key 的类型首次写入即固定）。
 *
 * 参数先过 TypeBox 校验（pi 在调 `execute` 之前做），这里对 id 与长度再查一遍 ——
 * 模型的输出是不可信输入，而这几行比一次误写便宜得多。
 */

// —— 限额 ——

export const TOOL_LIMITS = {
  /** 节点名 */
  label: 80,
  /** 节点说明 */
  description: 400,
  /** data 里单个字符串值 */
  text: 8000,
  /** 一次写入的 data 补丁序列化后的字节数 */
  dataBytes: 32_000,
  /** 一次写入最多碰多少个 data 键 */
  dataKeys: 50,
  /** `read_canvas` 最多列出多少个节点 / 连线，超出截断并说明 */
  readNodes: 200,
  readEdges: 400,
  /** `read_canvas` 里每个字符串值只给开头这么多字 */
  readTextExcerpt: 400,
  /** `read_canvas` 里对象 / 数组值序列化后超过这么多字就只报大小 */
  readValueChars: 400,
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

/** data 键的格式：字母开头，允许 `.`（平铺分键 `<前缀>.<id>` 要用） */
const DATA_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9_.-]{0,127}$'
const DATA_KEY_REGEX = new RegExp(DATA_KEY_PATTERN)

/** 端口 id 的格式 */
const PORT_PATTERN = '^[A-Za-z0-9_-]{1,64}$'

/** 坐标的合理范围：防一个离谱的数把节点扔到看不见的地方 */
const COORD_LIMIT = 1_000_000

/** agent 能建的节点类型：注册表里除了分组的全部（分组只能由「打组」围着已有节点长出来） */
export const AGENT_NODE_TYPES = Object.keys(FLOW_NODE_TYPE_DEFAULTS).filter(
  (type) => type !== GROUP_NODE_TYPE,
)

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

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字，已截断）` : text
}

/**
 * 给模型看的值：字符串截断，大对象只报大小 —— 导演台的场景一个节点就能有几十 KB，
 * 整块塞进上下文既贵又没用。要全文的话这一版没有入口，模型应该据实告诉用户。
 */
function compactValue(value: unknown): unknown {
  if (typeof value === 'string') return excerpt(value, TOOL_LIMITS.readTextExcerpt)
  if (value === null || typeof value !== 'object') return value
  const json = JSON.stringify(value) ?? ''
  if (json.length <= TOOL_LIMITS.readValueChars) return value
  return { 省略: Array.isArray(value) ? '数组' : '对象', 字数: json.length }
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, compactValue(value)]))
}

function portView(port: PortDef) {
  return {
    id: port.id,
    dataType: port.dataType,
    ...(port.label ? { label: port.label } : {}),
    ...(port.multiple ? { multiple: true } : {}),
    ...(port.max !== undefined ? { max: port.max } : {}),
  }
}

/** 一个节点给模型看的样子：按组，加派生的 inputs */
function nodeSnapshot(node: FlowNode) {
  const { position, parentNode, width, height } = node.layout
  return {
    id: node.id,
    type: node.type,
    layout: {
      position,
      ...(parentNode !== undefined ? { parentNode } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    },
    metadata: {
      label: node.metadata.label,
      ...(node.metadata.description !== undefined ? { description: node.metadata.description } : {}),
    },
    data: compactRecord(node.data),
    runtime: {
      status: node.runtime.status,
      ...(node.runtime.error !== undefined ? { error: node.runtime.error } : {}),
      ...(node.runtime.outputs ? { outputs: compactRecord(node.runtime.outputs) } : {}),
    },
    inputs: node.inputs.map((input) => ({
      port: input.port,
      index: input.index,
      edgeId: input.edgeId,
      source: input.source,
      sourcePort: input.sourcePort,
      ...(input.value !== undefined ? { value: compactValue(input.value) } : {}),
    })),
  }
}

function readEdgeList(doc: Y.Doc): FlowEdge[] {
  const list: FlowEdge[] = []
  for (const [id, value] of edgesMap(doc).entries()) {
    if (!(value instanceof Y.Map)) continue
    const edge = fromYEdge(id, value)
    if (edge) list.push(edge)
  }
  return list
}

/** 单个节点（带 inputs）；不存在返回 null。提及展开（`prompt.ts`）用 */
export function readNodeById(doc: Y.Doc, id: string): FlowNode | null {
  return readNodes(doc).find((node) => node.id === id) ?? null
}

/**
 * 画布的精简快照：`read_canvas` 的返回值，也是 run 开始时写进沙箱的 `canvas.json`。
 * 节点 / 连线太多时截断，并在 `truncated` 里说清楚截了多少 —— 不说的话模型会以为它看到的就是全部。
 *
 * `nodeTypes` 列出画布上出现过的类型各自的端口：连线要点名端口 id，模型得先知道有哪些。
 */
export function canvasSnapshot(doc: Y.Doc) {
  const nodes = readNodes(doc)
  const alive = new Set(nodes.map((node) => node.id))
  const edges = readEdgeList(doc).filter((edge) => alive.has(edge.source) && alive.has(edge.target))
  const notes: string[] = []
  if (nodes.length > TOOL_LIMITS.readNodes) {
    notes.push(`节点共 ${nodes.length} 个，只列出前 ${TOOL_LIMITS.readNodes} 个`)
  }
  if (edges.length > TOOL_LIMITS.readEdges) {
    notes.push(`连线共 ${edges.length} 条，只列出前 ${TOOL_LIMITS.readEdges} 条`)
  }

  const listed = nodes.slice(0, TOOL_LIMITS.readNodes)
  const nodeTypes: Record<string, { inputs: ReturnType<typeof portView>[]; outputs: ReturnType<typeof portView>[] }> = {}
  for (const node of listed) {
    if (nodeTypes[node.type]) continue
    const inputs = portsOf(node.type, 'inputs')
    const outputs = portsOf(node.type, 'outputs')
    if (inputs.length + outputs.length === 0) continue
    nodeTypes[node.type] = { inputs: inputs.map(portView), outputs: outputs.map(portView) }
  }

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: listed.map(nodeSnapshot),
    edges: edges.slice(0, TOOL_LIMITS.readEdges).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(typeof edge.data.sourcePort === 'string' ? { sourcePort: edge.data.sourcePort } : {}),
      ...(typeof edge.data.targetPort === 'string' ? { targetPort: edge.data.targetPort } : {}),
      ...(typeof edge.data.index === 'number' ? { index: edge.data.index } : {}),
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    })),
    nodeTypes,
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

/** 摆放只看这几样 */
export type PlacedNode = Pick<FlowNode, 'id' | 'type' | 'layout'>

/** 节点在画布坐标下的矩形。组里的子节点 position 是相对父节点的，要加回去 */
function absoluteRects(nodes: readonly PlacedNode[]): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const rects = new Map<string, Rect>()
  for (const node of nodes) {
    const size = ESTIMATED_SIZE[node.type] ?? FALLBACK_SIZE
    const { position, parentNode, width, height } = node.layout
    const parent = parentNode ? byId.get(parentNode) : undefined
    rects.set(node.id, {
      x: position.x + (parent?.layout.position.x ?? 0),
      y: position.y + (parent?.layout.position.y ?? 0),
      width: width ?? size.width,
      height: height ?? size.height,
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
export function placeNewNode(nodes: readonly PlacedNode[], type: string, nearId?: string) {
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

// —— 校验 ——

const Id = (description: string) => Type.String({ pattern: ID_PATTERN, description })
const Port = (description: string) => Type.String({ pattern: PORT_PATTERN, description })

function assertId(value: string, what: string) {
  if (!ID_REGEX.test(value)) throw new Error(`${what} 不是合法的 id：${JSON.stringify(value.slice(0, 80))}`)
}

function assertLength(value: string, max: number, what: string) {
  if (value.length > max) throw new Error(`${what} 超过 ${max} 字（实际 ${value.length} 字）`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** data 补丁：键名合法、键数和体积有上限、值是 JSON 能表达的东西 */
function assertDataPatch(patch: Record<string, unknown>, removed: readonly string[] = []) {
  const keys = [...Object.keys(patch), ...removed]
  if (keys.length > TOOL_LIMITS.dataKeys) throw new Error(`一次最多改 ${TOOL_LIMITS.dataKeys} 个 data 字段`)
  for (const key of keys) {
    if (!DATA_KEY_REGEX.test(key)) throw new Error(`data 字段名不合法：${JSON.stringify(key.slice(0, 80))}`)
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) throw new Error(`data.${key} 没有值`)
    if (typeof value === 'string') assertLength(value, TOOL_LIMITS.text, `data.${key}`)
  }
  const bytes = JSON.stringify(patch).length
  if (bytes > TOOL_LIMITS.dataBytes) throw new Error(`data 补丁太大（${bytes} 字，上限 ${TOOL_LIMITS.dataBytes}）`)
}

/** 已有 key 上是 Y 类型（协同文本之类）的不许用 plain 值覆盖 —— 那会让写它的一方整棵子树消失 */
function assertPlainKeys(map: Y.Map<unknown>, keys: Iterable<string>, what: string) {
  for (const key of keys) {
    if (map.get(key) instanceof Y.AbstractType) {
      throw new Error(`${what}.${key} 是协同编辑的结构化字段，不能用工具整体改写`)
    }
  }
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

function typeOfNode(doc: Y.Doc, id: string): string | undefined {
  const node = getNodeMap(doc, id)
  if (!node) return undefined
  const type = node.get('type')
  return typeof type === 'string' && type ? type : 'process'
}

function nodeLabel(doc: Y.Doc, id: string): string {
  const label = nodeGroupMap(getNodeMap(doc, id) ?? undefined, 'metadata')?.get('label')
  return typeof label === 'string' && label ? label : id
}

/**
 * 两端之间走哪对端口：交给 shared 的 `resolveConnection`（给了端口就只校验那一对，没给就按声明顺序
 * 自动选第一对类型兼容、目标端口没满、还没连过的）。不行就把原因原样抛给模型。
 */
function pickConnection(
  request: { source: string; target: string; sourcePort?: string; targetPort?: string },
  typeOf: (id: string) => string | undefined,
  edges: readonly FlowEdge[],
): ResolvedPorts {
  const verdict = resolveConnection(request, { typeOf, edges })
  if (!verdict.ok) throw new Error(verdict.reason)
  return { sourcePort: verdict.sourcePort, targetPort: verdict.targetPort }
}

function buildEdge(
  source: string,
  target: string,
  ports: ResolvedPorts,
  edges: readonly FlowEdge[],
  label?: string,
): FlowEdge {
  return {
    id: createId(EDGE_ID_PREFIX),
    source,
    target,
    // 节点的连接点不带 id：端口只写在 data 上（和前端连线同一个函数）
    sourceHandle: null,
    targetHandle: null,
    type: DEFAULT_EDGE_TYPE,
    animated: false,
    ...(label ? { label } : {}),
    data: connectionEdgeData(ports, target, edges),
  }
}

// —— 参数 ——

const readCanvasParams = Type.Object({}, { additionalProperties: false })

const metadataParams = (required: boolean) =>
  Type.Object(
    {
      label: required
        ? Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label, description: '节点名' })
        : Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label, description: '节点名' })),
      description: Type.Optional(Type.String({ maxLength: TOOL_LIMITS.description, description: '节点说明' })),
    },
    { additionalProperties: false },
  )

const dataParams = Type.Record(Type.String({ pattern: DATA_KEY_PATTERN }), Type.Unknown(), {
  description:
    '业务字段，平铺的键值对（例如 text 节点的 text、生成类节点的 prompt / model / width）。只写给出的键，其余保留。',
})

const addNodeParams = Type.Object(
  {
    type: StringEnum(AGENT_NODE_TYPES, {
      description:
        'text = 带正文（data.text）的文本节点；process = 只有名字的流程节点；其余是带端口的业务节点，端口见 read_canvas 的 nodeTypes',
    }),
    metadata: metadataParams(true),
    data: Type.Optional(dataParams),
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
    sourcePort: Type.Optional(Port('connectFrom 那个节点的输出端口 id；不给则自动选第一个能连的')),
    targetPort: Type.Optional(Port('新节点的输入端口 id；不给则自动选第一个能连的')),
  },
  { additionalProperties: false },
)

const updateNodeParams = Type.Object(
  {
    id: Id('要修改的节点 id'),
    metadata: Type.Optional(metadataParams(false)),
    data: Type.Optional(dataParams),
    removeData: Type.Optional(
      Type.Array(Type.String({ pattern: DATA_KEY_PATTERN }), {
        maxItems: TOOL_LIMITS.dataKeys,
        description: '要从 data 里删掉的字段名',
      }),
    ),
  },
  { additionalProperties: false },
)

const connectParams = Type.Object(
  {
    source: Id('起点节点 id'),
    target: Id('终点节点 id'),
    sourcePort: Type.Optional(Port('起点的输出端口 id；不给则按声明顺序自动选第一个能连的')),
    targetPort: Type.Optional(Port('终点的输入端口 id；不给则按声明顺序自动选第一个能连的')),
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
      '读取当前画布：每个节点按组给出 —— layout（坐标 / 所属分组）、metadata（名字 / 说明）、data（业务字段，长文本截断）、' +
      'runtime（运行状态 / 各输出端口的产出）、inputs（连进来的线，按端口和序号排好）；以及全部连线和各节点类型的端口。' +
      '修改或连线之前先调它拿到真实的 id 和端口，不要猜。',
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
    description:
      '在画布上新建一个节点（metadata 给名字，data 给业务字段）；可以顺带从一个已有节点连线过来。返回新节点的 id。',
    parameters: addNodeParams,
    executionMode: 'sequential',
    describe: (args) => `新建节点${quote(args.metadata.label)}`,
    async execute(_id, args) {
      if (!AGENT_NODE_TYPES.includes(args.type)) throw new Error(`不能新建 ${args.type} 类型的节点`)
      assertLength(args.metadata.label, TOOL_LIMITS.label, '节点名')
      if (args.metadata.description !== undefined) {
        assertLength(args.metadata.description, TOOL_LIMITS.description, '节点说明')
      }
      const data = args.data ?? {}
      if (!isPlainRecord(data)) throw new Error('data 必须是对象')
      assertDataPatch(data)
      if (args.connectFrom !== undefined) assertId(args.connectFrom, 'connectFrom')
      if (args.connectFrom === undefined && (args.sourcePort !== undefined || args.targetPort !== undefined)) {
        throw new Error('只有给了 connectFrom 才能指定端口')
      }

      const created = await canvas.write((doc) => {
        const id = createId(NODE_ID_PREFIX)
        const existing = readEdgeList(doc)
        let ports: ResolvedPorts | null = null
        if (args.connectFrom !== undefined) {
          if (!getNodeMap(doc, args.connectFrom)) {
            throw new Error(`connectFrom 指向的节点 ${args.connectFrom} 不存在，先 read_canvas 确认 id`)
          }
          // 新节点还没进文档：它的类型由这里告诉校验
          const typeOf = (nodeId: string) => (nodeId === id ? args.type : typeOfNode(doc, nodeId))
          ports = pickConnection(
            { source: args.connectFrom, target: id, sourcePort: args.sourcePort, targetPort: args.targetPort },
            typeOf,
            existing,
          )
        }

        const position = args.position ?? placeNewNode(readNodes(doc), args.type, args.connectFrom)
        const node = buildNodeRecord({
          id,
          type: args.type,
          label: args.metadata.label,
          position: { x: position.x, y: position.y },
        })
        if (args.metadata.description !== undefined) node.metadata.description = args.metadata.description
        Object.assign(node.data, data)

        // 节点和那条线同一个事务：在线的人看到的要么一起出现，要么都没有
        nodesMap(doc).set(node.id, toYNode(node))
        const edge = args.connectFrom !== undefined && ports ? buildEdge(args.connectFrom, node.id, ports, existing) : null
        if (edge) edgesMap(doc).set(edge.id, toYEdge(edge))
        return { node, edge }
      })

      const ids = [created.node.id, ...(created.edge ? [created.edge.id] : [])]
      return result(
        JSON.stringify({
          id: created.node.id,
          position: created.node.layout.position,
          ...(created.edge
            ? {
                edgeId: created.edge.id,
                sourcePort: created.edge.data.sourcePort ?? null,
                targetPort: created.edge.data.targetPort ?? null,
              }
            : {}),
        }),
        { summary: `新建节点${quote(args.metadata.label)}`, elementIds: ids },
      )
    },
  }

  const updateNode: CanvasTool<typeof updateNodeParams> = {
    name: 'update_node',
    label: '修改节点',
    description:
      '修改一个已有节点：metadata 改名字 / 说明，data 改业务字段（例如 text 节点的正文 data.text），removeData 删业务字段。' +
      '只改给出的键，其余原样保留。用户要求改某个具体节点（例如 @ 提及的那个）的内容时用它。',
    parameters: updateNodeParams,
    executionMode: 'sequential',
    describe: (args) => `修改节点 ${args.id}`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      const metadata: { label?: string; description?: string } = args.metadata ?? {}
      const data = args.data ?? {}
      const removeData = args.removeData ?? []
      if (!isPlainRecord(data)) throw new Error('data 必须是对象')
      if (Object.keys(metadata).length === 0 && Object.keys(data).length === 0 && removeData.length === 0) {
        throw new Error('metadata / data / removeData 至少给一个')
      }
      if (metadata.label !== undefined) assertLength(metadata.label, TOOL_LIMITS.label, '节点名')
      if (metadata.description !== undefined) {
        assertLength(metadata.description, TOOL_LIMITS.description, '节点说明')
      }
      assertDataPatch(data, removeData)

      const label = await canvas.write((doc) => {
        const node = getNodeMap(doc, args.id)
        if (!node) throw new Error(`节点 ${args.id} 不存在（可能已被删除），先 read_canvas 确认`)
        // 先把要碰的组都查一遍再动手：key 上是别的类型的组不覆盖（nodeGroupMap 返回 null）
        const touchMetadata = Object.keys(metadata).length > 0
        const touchData = Object.keys(data).length > 0 || removeData.length > 0
        const existingData = node.get('data')
        if (touchData && existingData !== undefined && !(existingData instanceof Y.Map)) {
          throw new Error(`节点 ${args.id} 的 data 结构不对，不能修改`)
        }
        const existingMeta = node.get('metadata')
        if (touchMetadata && existingMeta !== undefined && !(existingMeta instanceof Y.Map)) {
          throw new Error(`节点 ${args.id} 的 metadata 结构不对，不能修改`)
        }
        if (existingData instanceof Y.Map) assertPlainKeys(existingData, [...Object.keys(data), ...removeData], 'data')

        // 按 key 合并：只 set 给出的那几个，别人同时改的别的字段不受影响。
        // 老节点（v1 / v2 写的）没有 metadata 这一组，这里现建
        if (touchMetadata) {
          const map = nodeGroupMap(node, 'metadata', { create: true })!
          for (const [key, value] of Object.entries(metadata)) {
            if (value !== undefined) map.set(key, value)
          }
        }
        if (touchData) {
          const map = nodeGroupMap(node, 'data', { create: true })!
          for (const key of removeData) map.delete(key)
          for (const [key, value] of Object.entries(data)) map.set(key, value)
        }
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
    description:
      '从一个节点连一条线到另一个节点。连的是哪对端口：给了 sourcePort / targetPort 就只校验那一对；' +
      '不给就按端口声明顺序自动选第一对数据类型兼容、目标端口没满、还没连过的。两端必须都存在；单输入端口只能接一条。',
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
        const existing = readEdgeList(doc)
        const ports = pickConnection(args, (id) => typeOfNode(doc, id), existing)
        const edge = buildEdge(args.source, args.target, ports, existing, args.label)
        edgesMap(doc).set(edge.id, toYEdge(edge))
        return {
          edge,
          summary: `连线${quote(nodeLabel(doc, args.source))} → ${quote(nodeLabel(doc, args.target))}`,
        }
      })

      return result(
        JSON.stringify({
          id: created.edge.id,
          sourcePort: created.edge.data.sourcePort ?? null,
          targetPort: created.edge.data.targetPort ?? null,
          index: created.edge.data.index,
        }),
        { summary: created.summary, elementIds: [created.edge.id] },
      )
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
