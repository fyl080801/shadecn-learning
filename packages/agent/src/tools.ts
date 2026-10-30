import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { StringEnum, Type, type Static, type TSchema } from '@earendil-works/pi-ai'
import * as Y from 'yjs'
import { DIRECTOR_NODE_TYPE, msToSeconds, readDirectorScene } from '@shadecn/shared/director-doc'
import { edgesMap, fromYEdge, nodeGroupMap, nodesMap, readNodes, type FlowNodeGroup } from '@shadecn/shared/flow-doc'
import { type FlowEdge, type FlowNode } from '@shadecn/shared/flow-graph'
import {
  buildNodeRecord,
  CREATABLE_NODE_TYPES,
  defaultNodeSize,
  GROUP_NODE_TYPE,
  NODE_FORM_KEY,
  nodeSizeOf,
  nodeTypeDefaultsOf,
  portsOf,
  resolveConnection,
  type PortDef,
} from '@shadecn/shared/flow-node-types'
import * as ops from '@shadecn/shared/flow-ops'
import { FlowOpError } from '@shadecn/shared/flow-ops'
import { createId, NODE_ID_PREFIX } from '@shadecn/shared/id'
import { agentAttachmentKind, type AgentAttachment } from '@shadecn/shared/agent'
import type { AgentCapability } from './authority.ts'
import type { CanvasHandle } from './canvas.ts'
import { MediaReadError, sniffImageType, VIEWABLE_IMAGE_TYPES, type MediaReader } from './media.ts'

/**
 * 画布工具 —— agent 读写画布的**唯一**途径（REQ-AGENT §3.2 方案 C）。
 *
 * 三条贯穿全文件的规矩：
 *
 * 1. **一次工具调用 = 一个 Y 事务**（`canvas.write` 一次）。「加节点并连上」这种组合操作
 *    在同一个事务里写完，在线的人看到的要么是节点和线一起出现，要么都没有。
 * 2. **先校验、后动手**：Yjs 事务不回滚（见 `canvas.ts`），所以每个写函数先把全部前提查完，
 *    出错只能在第一次改动之前抛。抛出去的错误由 pi 以 `isError` 回给模型，模型据此改正。
 * 3. **写一律走 `@shadecn/shared/flow-ops` 的原子操作，不直接碰 Y.Map** —— 和编辑器的 store 是同一份实现：
 *    建节点、按组按 key 写字段、连线（`resolveConnection` 选端口）、删除（连带删边、删分组只解散）的规则都在那里。
 *    原子操作自己先校验后动手，不满足抛 `FlowOpError`；这里转成给模型看的错误（{@link runOps}）。
 *    这个文件只管参数校验（id、长度、体积、可建的类型、删除预算）和给模型看的读写结果。
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
  /** 一次 `move_nodes` 最多挪多少个 */
  movePerCall: 50,
  /** 一次 `group_nodes` 最多圈多少个 */
  groupMembers: 50,
  /** `resize_node` 的宽高范围（像素）：太小点不中、太大一屏装不下 */
  sizeMin: 40,
  sizeMax: 4000,
  /** `auto_layout` 最多排多少个节点（dagre 在服务端同步跑，太大的画布让用户自己点「自动布局」） */
  layoutNodes: 500,
  /** `duplicate_node` 不给偏移时副本错开多少（和编辑器的复制同一个步长） */
  duplicateOffset: 24,
  /** `view_node_media` 一次最多看几个节点 */
  mediaPerCall: 4,
  /** 单张图片的字节上限（Anthropic 单图 5MB；更大的让用户换小图） */
  mediaBytes: 5 * 1024 * 1024,
  /**
   * 一轮里累计交给模型的图片字节上限。看过的图留在这一轮的模型上下文里，**之后每次请求模型都整段重发**
   * （base64 再大三分之一）；网关模型代理的请求体上限是 32MB，16MB 原始字节 ≈ 21MB base64，给文字留出余量。
   */
  mediaBytesPerRun: 16 * 1024 * 1024,
} as const

/** 多模态查看工具的名字：编排层只在模型支持图片输入、宿主接了素材读取时才把它交给模型 */
export const VIEW_MEDIA_TOOL_NAME = 'view_node_media'
/** 看用户消息附件的工具（docs/20 §3.10.12）：和 `view_node_media` 同属技能 `media-view`、同一份图片字节预算 */
export const VIEW_ATTACHMENT_TOOL_NAME = 'view_attachment'

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

/**
 * agent 能建的节点类型 = 人能建的（shared 的 `CREATABLE_NODE_TYPES`，和工具栏菜单同一份）。
 * 兜底的 `process` 只用来显示认不出的老节点；分组只能由「打组」围着已有节点长出来。
 */
export const AGENT_NODE_TYPES: readonly string[] = CREATABLE_NODE_TYPES

/** 一轮里工具之间共享的状态：删除预算、已经交给模型的图片字节数 */
export interface ToolRunState {
  deleted: number
  mediaBytes: number
}

export interface CanvasToolDetails {
  /** 给人看的一句话（`AgentToolCallView.summary`） */
  summary: string
  /** 这次调用新建 / 修改 / 删除了哪些元素（写进工具调用日志） */
  elementIds: string[]
  /** 只有 `load_skill` 成功加载时有：新加载的技能 id（runner 据此把它的工具并进来，docs/23 §3.3） */
  loadedSkill?: string
  /**
   * 读类工具：这次把哪些节点的内容**完整**交给了模型（docs/20 §3.10.8：读过就移出「改过」集合，结果里标出占用）。
   * 只在服务端用 —— 编排层（`session.ts`）取走之后从结果里删掉，不发给 runner、不进模型上下文。
   */
  readNodeIds?: string[]
}

/**
 * 画布工具 = pi 的 `AgentTool` + 一个「调用开始时给人看的一句话」。
 * 结束时的那句话在 `details.summary` 里（可能比开始时的更准，比如带上了真实的节点名）。
 */
export interface CanvasTool<TParameters extends TSchema = TSchema>
  extends AgentTool<TParameters, CanvasToolDetails> {
  /**
   * 执行之前要判的能力（docs/22 §3）。编排层在调 `execute` 之前统一 `authorize` 它（`session.ts`），
   * 判权失败（Grant 失效）整轮停。必填：新加的工具不声明就过不了类型检查。
   * 删除类（`delete_elements`、`ungroup`）是 `flow:delete`，它们那次写事务另外还过画布那道 `flow:write`。
   */
  readonly capability: AgentCapability
  /**
   * 在哪执行（docs/23 §3.1）：`gateway`（缺省）= runner 只转发，服务端在网关上执行（读写 Y.Doc 只走 `flow-ops`）；
   * `runner` = 在 runner 里执行（媒体命令、发起任务），服务端只留定义给 `describe`，网关拒绝代它执行。
   */
  readonly execution?: 'gateway' | 'runner'
  /**
   * 要在 runner 的工作目录里**起子进程**（ffmpeg / ffprobe）：只能是 `execution: 'runner'` 的工具，所在技能必须要求 `sandbox:exec`
   * （注册表建表时校验）。在 runner 里执行但不起进程的（`delegate_task`：被调用的 agent 的每一步仍经网关）不设它。
   */
  readonly spawnsProcess?: boolean
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

/**
 * 导演台的场景数据在 `data` 里的键都以它开头（`dc.obj.*` / `dc.track.*` / `dc.kf.*` / `dc.duration` …，`@shadecn/shared/director-doc`）。
 * 这些键归导演台技能管：`read_canvas` / `get_node` 只给摘要（最多上千个键，逐个列出会淹没输出），
 * `update_node` / `add_node` 不让写（绕开导演台 ops 的校验与上限）。
 */
const DIRECTOR_KEY_PREFIX = 'dc.'

const isDirectorKey = (key: string) => key.startsWith(DIRECTOR_KEY_PREFIX)

/**
 * 导演台节点的 data：`dc.*` 换成一条摘要，其余业务字段照常。摘要挂在键 `dc.*` 下 ——
 * 合法的 data 键里不会有 `*`（{@link DATA_KEY_PATTERN}），不会和真的业务字段撞名
 */
function directorDataView(data: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !isDirectorKey(key)))
  const scene = readDirectorScene(data)
  return {
    ...compactRecord(rest),
    'dc.*': {
      objects: scene.objects.size,
      tracks: scene.tracks.size,
      keyframes: scene.keyframes.size,
      durationSeconds: msToSeconds(scene.duration),
      note: '导演台的场景（dc.* 字段）不在这里展开：用 director 技能的 get_director_scene 读，用它的工具改',
    },
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
    data: node.type === DIRECTOR_NODE_TYPE ? directorDataView(node.data) : compactRecord(node.data),
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

/** 新节点和已有内容之间留的空 */
const PLACEMENT_GAP = 80

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 摆放只看这几样 */
export type PlacedNode = Pick<FlowNode, 'id' | 'type' | 'layout'>

/**
 * 节点在画布坐标下的矩形。组里的子节点 position 是相对父节点的，要加回去。
 * 量不到渲染尺寸（服务端没有 DOM）：尺寸用 shared 的 `nodeSizeOf`（存的宽高，没有按类型估，是近似值）
 */
function absoluteRects(nodes: readonly PlacedNode[]): Map<string, Rect> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const rects = new Map<string, Rect>()
  for (const node of nodes) {
    const { position, parentNode } = node.layout
    const parent = parentNode ? byId.get(parentNode) : undefined
    rects.set(node.id, {
      x: position.x + (parent?.layout.position.x ?? 0),
      y: position.y + (parent?.layout.position.y ?? 0),
      ...nodeSizeOf(node),
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

  const size = defaultNodeSize(type)
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

function assertCoord(value: number, what: string) {
  if (!Number.isFinite(value) || Math.abs(value) > COORD_LIMIT) {
    throw new Error(`${what} 超出范围（±${COORD_LIMIT}）`)
  }
}

function assertSize(value: number, what: string) {
  if (!Number.isFinite(value) || value < TOOL_LIMITS.sizeMin || value > TOOL_LIMITS.sizeMax) {
    throw new Error(`${what} 必须在 ${TOOL_LIMITS.sizeMin}–${TOOL_LIMITS.sizeMax} 之间`)
  }
}

/** 点名的一批 id：格式合法、不重复、不超过上限 */
function assertIdList(ids: readonly string[], max: number, what: string) {
  for (const id of ids) assertId(id, what)
  if (ids.length > max) throw new Error(`一次最多 ${max} 个${what}`)
  if (new Set(ids).size !== ids.length) throw new Error(`${what}里有重复的 id`)
}

/** 读的工具点名一个节点：不存在就报错，带上「先 read_canvas」的提示 */
function notFound(id: string): Error {
  return new Error(`节点 ${id} 不存在（可能已被删除），先 read_canvas 确认 id`)
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

/**
 * 素材地址和形态不让模型直接写：`data.form` 由画布按连线自己维护（`flow-ops`），`data.src` 只能在
 * `add_node` 新建时给（同一步按「有没有连入」定形态，`ops.attachAsset`）。直接改 `src` 会绕过形态规则。
 */
const MANAGED_DATA_KEYS = ['src', NODE_FORM_KEY] as const

function assertNotManaged(keys: Iterable<string>, allowed: readonly string[] = []) {
  for (const key of keys) {
    if ((MANAGED_DATA_KEYS as readonly string[]).includes(key) && !allowed.includes(key)) {
      throw new Error(
        key === NODE_FORM_KEY
          ? `data.${NODE_FORM_KEY} 由画布按连线自动维护，不能直接写`
          : `data.${key} 不能用 update_node 修改：素材地址只能在 add_node 新建时给`,
      )
    }
  }
}

/** 导演台的场景键（`dc.*`）只能经导演台工具写：它们的校验、上限、单位换算都在导演台 ops 里 */
function assertNotDirector(keys: Iterable<string>, tool: string) {
  for (const key of keys) {
    if (isDirectorKey(key)) {
      throw new Error(
        `data.${key} 是导演台的场景数据，不能用 ${tool} 写：请用 director 技能的工具（get_director_scene、add_objects、set_keyframes…；` +
          "没加载就先单独调用 load_skill({ id: 'director' })）",
      )
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

function nodeLabel(doc: Y.Doc, id: string): string {
  const label = nodeGroupMap(getNodeMap(doc, id) ?? undefined, 'metadata')?.get('label')
  return typeof label === 'string' && label ? label : id
}

/**
 * 在一次 `canvas.write` 里跑原子操作，把 `FlowOpError` 转成给模型看的错误。
 *
 * 原子操作抛出时文档没被改动（它们先校验后动手），所以这里只改措辞：点名的节点不存在时提示模型
 * 先 `read_canvas` 拿真实的 id —— 别的原因（端口不匹配、字段类型不能换…）原样转达。
 */
function runOps<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (!(error instanceof FlowOpError)) throw error
    const hint = error.code === 'NODE_NOT_FOUND' ? '（可能已被删除），先 read_canvas 确认 id' : ''
    throw new Error(`${error.message}${hint}`, { cause: error })
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
    '业务字段，平铺的键值对（例如 text 节点的 text、video 的 poster、底部输入框的 prompt；image / video 的素材地址 src 只能在 add_node 新建时给，form 由画布自动维护、不能写；导演台的场景 dc.* 只能用 director 技能的工具写）。只写给出的键，其余保留。',
})

const addNodeParams = Type.Object(
  {
    type: StringEnum(AGENT_NODE_TYPES, {
      description:
        'text = 文本（正文 data.text）；image = 图片（资源地址 data.src）；video = 视频（资源地址 data.src、预览图 data.poster）；director = 导演台（场景内容用 director 技能的工具写）。端口见 read_canvas 的 nodeTypes',
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

const getNodeParams = Type.Object({ id: Id('要读取的节点 id') }, { additionalProperties: false })

const checkConnectionParams = Type.Object(
  {
    source: Id('起点节点 id'),
    target: Id('终点节点 id'),
    sourcePort: Type.Optional(Port('起点的输出端口 id；不给则按声明顺序自动选')),
    targetPort: Type.Optional(Port('终点的输入端口 id；不给则按声明顺序自动选')),
  },
  { additionalProperties: false },
)

const Coord = (description: string) => Type.Number({ minimum: -COORD_LIMIT, maximum: COORD_LIMIT, description })
const Size = (description: string) =>
  Type.Number({ minimum: TOOL_LIMITS.sizeMin, maximum: TOOL_LIMITS.sizeMax, description })

const moveNodesParams = Type.Object(
  {
    moves: Type.Array(
      Type.Object(
        { id: Id('节点 id'), x: Coord('新的左上角 x'), y: Coord('新的左上角 y') },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: TOOL_LIMITS.movePerCall,
        description: '每个节点的新位置（左上角）。组内节点的坐标相对它所在的分组框，顶层节点是画布坐标',
      },
    ),
  },
  { additionalProperties: false },
)

const resizeNodeParams = Type.Object(
  { id: Id('节点 id'), width: Size('新宽度（像素）'), height: Size('新高度（像素）') },
  { additionalProperties: false },
)

const duplicateNodeParams = Type.Object(
  {
    id: Id('要复制的节点 id'),
    offset: Type.Optional(
      Type.Object(
        { x: Coord('副本相对原件的横向偏移'), y: Coord('副本相对原件的纵向偏移') },
        { additionalProperties: false, description: `不给则错开 ${TOOL_LIMITS.duplicateOffset}px` },
      ),
    ),
  },
  { additionalProperties: false },
)

const groupNodesParams = Type.Object(
  {
    ids: Type.Array(Id('节点 id'), {
      minItems: 2,
      maxItems: TOOL_LIMITS.groupMembers,
      description: '要圈进分组的节点：至少两个，都得是顶层节点（不在别的分组里）、且不是分组本身',
    }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_LIMITS.label, description: '分组名；不给则自动编号' })),
  },
  { additionalProperties: false },
)

const ungroupParams = Type.Object({ id: Id('要解散的分组 id') }, { additionalProperties: false })

const autoLayoutParams = Type.Object({}, { additionalProperties: false })

const viewMediaParams = Type.Object(
  {
    ids: Type.Array(Id('图片 / 视频节点的 id'), {
      minItems: 1,
      maxItems: TOOL_LIMITS.mediaPerCall,
      description: `要查看的节点，一次最多 ${TOOL_LIMITS.mediaPerCall} 个：图片节点看它的图（data.src），视频节点只看预览图（data.poster）`,
    }),
  },
  { additionalProperties: false },
)

const viewAttachmentParams = Type.Object(
  {
    keys: Type.Array(Type.String({ minLength: 1, maxLength: 512, description: '附件的键（用户消息末尾「附件」块里列的那个）' }), {
      minItems: 1,
      maxItems: TOOL_LIMITS.mediaPerCall,
      description: `要查看的附件，一次最多 ${TOOL_LIMITS.mediaPerCall} 个；只有图片附件能看`,
    }),
  },
  { additionalProperties: false },
)

export interface CanvasToolsOptions {
  canvas: CanvasHandle
  /** 一轮共享的状态；不给就每次 `createCanvasTools` 新建一份 */
  runState?: ToolRunState
  /**
   * 读素材字节（宿主注入，只读宿主自己的对象存储）。不给时 `view_node_media` 照样有定义（runner 要拿它的 schema），
   * 但执行即报错 —— 给不给模型由技能 `media-view` 的可用条件定（模型支持图片输入 + 宿主接了它，`skills/media/`）。
   */
  media?: MediaReader
  /**
   * 这个会话里用户消息带过的附件（docs/20 §3.10.12，宿主核对过都是这张画布的资源）—— `view_attachment` 只认这些键。
   * runner 那侧（只造定义）不给。
   */
  attachments?: readonly AgentAttachment[]
}

const MB = 1024 * 1024
const megabytes = (bytes: number) => `${(bytes / MB).toFixed(bytes < MB ? 2 : 1)} MB`

/** 读素材失败 → 给模型看的原因（宿主的细节不进上下文） */
function mediaFailure(err: unknown, what: string): string {
  if (err instanceof MediaReadError) {
    switch (err.kind) {
      case 'foreign':
        return `${what}不是本项目对象存储里的素材（外部链接不能查看），只能看用户上传到画布的图片`
      case 'not_found':
        return `${what}对应的文件不存在（可能已被删除）`
      case 'too_large':
        return `${what}超过 ${megabytes(TOOL_LIMITS.mediaBytes)}，不能查看`
      case 'unavailable':
        return `${what}暂时读不到（对象存储不可用），可以稍后再试，或据实告诉用户`
    }
  }
  console.warn('[agent] 读取节点素材失败', err)
  return `${what}暂时读不到，可以稍后再试，或据实告诉用户`
}

/** 画布技能 `canvas` 里只读的工具 */
export const CANVAS_READ_TOOL_NAMES = ['read_canvas', 'get_node', 'check_connection'] as const

/** 画布技能 `canvas` 里写画布的工具 */
export const CANVAS_EDIT_TOOL_NAMES = [
  'add_node',
  'update_node',
  'duplicate_node',
  'connect',
  'delete_elements',
  'move_nodes',
  'resize_node',
  'group_nodes',
  'ungroup',
  'auto_layout',
] as const

/**
 * 画布工具按技能分组取（docs/23 §4）：画布技能（读 + 写）/ 看图。实现都在下面同一个闭包里 ——
 * 它们共享这一轮的 `runState`（删除预算、图片字节预算），**同一轮里几组要传同一份 `runState`**。
 */
function pickTools(options: CanvasToolsOptions, names: readonly string[]): CanvasTool[] {
  const all = new Map(buildCanvasTools(options).map((tool) => [tool.name, tool]))
  return names.map((name) => {
    const tool = all.get(name)
    if (!tool) throw new Error(`没有画布工具 ${name}`)
    return tool
  })
}

/** 画布技能 `canvas` 的 13 个工具：读在前、写在后 */
export const createCanvasBaseTools = (options: CanvasToolsOptions) =>
  pickTools(options, [...CANVAS_READ_TOOL_NAMES, ...CANVAS_EDIT_TOOL_NAMES])
export const createViewMediaTool = (options: CanvasToolsOptions) => pickTools(options, [VIEW_MEDIA_TOOL_NAME])[0]!
export const createViewAttachmentTool = (options: CanvasToolsOptions) => pickTools(options, [VIEW_ATTACHMENT_TOOL_NAME])[0]!

/** 全部画布工具（三组之和）—— 工具单测用；编排层按技能取（`skills/`） */
export function createCanvasTools(options: CanvasToolsOptions): CanvasTool[] {
  return buildCanvasTools(options)
}

function buildCanvasTools(options: CanvasToolsOptions): CanvasTool[] {
  const { canvas } = options
  const runState = options.runState ?? { deleted: 0, mediaBytes: 0 }

  const readCanvas: CanvasTool<typeof readCanvasParams> = {
    name: 'read_canvas',
    capability: 'flow:read',
    label: '读取画布',
    description:
      '读取当前画布：每个节点按组给出 —— layout（坐标 / 所属分组）、metadata（名字 / 说明）、data（业务字段，长文本截断）、' +
      'runtime（运行状态 / 各输出端口的产出）、inputs（连进来的线，按端口和序号排好）；以及全部连线和各节点类型的端口。' +
      '导演台节点的场景只给摘要（data 里的 dc.*：对象 / 轨道 / 关键帧数量和时长），场景内容用 get_director_scene 读。' +
      '修改或连线之前先调它拿到真实的 id 和端口，不要猜。',
    parameters: readCanvasParams,
    executionMode: 'sequential',
    describe: () => '读取画布',
    async execute() {
      const snapshot = await canvas.read(canvasSnapshot)
      return result(JSON.stringify(snapshot), {
        summary: `读取画布（${snapshot.nodeCount} 个节点、${snapshot.edgeCount} 条连线）`,
        elementIds: [],
        // 只算列出来的（超出上限被截掉的那些模型没看到）
        readNodeIds: snapshot.nodes.map((node) => node.id),
      })
    },
  }

  const addNode: CanvasTool<typeof addNodeParams> = {
    name: 'add_node',
    capability: 'flow:write',
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
      // 新建时可以带素材地址（src），形态（form）一律不让给
      assertNotManaged(Object.keys(data), ['src'])
      assertNotDirector(Object.keys(data), 'add_node')
      const withForms = nodeTypeDefaultsOf(args.type).forms === true
      if (withForms && data.src !== undefined && typeof data.src !== 'string') throw new Error('data.src 必须是字符串')
      if (args.connectFrom !== undefined) assertId(args.connectFrom, 'connectFrom')
      if (args.connectFrom === undefined && (args.sourcePort !== undefined || args.targetPort !== undefined)) {
        throw new Error('只有给了 connectFrom 才能指定端口')
      }

      const created = await canvas.write((doc) =>
        runOps(() => {
          const ctx = ops.opContext(doc)
          const position = args.position ?? placeNewNode(readNodes(doc), args.type, args.connectFrom)
          const node = buildNodeRecord({
            id: createId(NODE_ID_PREFIX),
            type: args.type,
            label: args.metadata.label,
            position: { x: position.x, y: position.y },
          })
          if (args.metadata.description !== undefined) node.metadata.description = args.metadata.description
          // 图片 / 视频带着素材地址：先按没有素材建（和连线），再在同一个事务里 `attachAsset` ——
          // 和人「先建节点、再上传」是同一条形态规则（有连入保持 generate，没有就成 asset）
          const src = data.src
          const asset =
            withForms && typeof src === 'string' && src.trim() !== ''
              ? { src, ...(typeof data.poster === 'string' ? { poster: data.poster } : {}) }
              : null
          const rest = { ...data }
          if (asset) {
            delete rest.src
            if (asset.poster !== undefined) delete rest.poster
          }
          Object.assign(node.data, rest)

          // 节点和那条线同一个事务：在线的人看到的要么一起出现，要么都没有
          const created =
            args.connectFrom === undefined
              ? { node: ops.createNode(ctx, node), edge: null }
              : ops.createConnectedNode(ctx, node, {
                  source: args.connectFrom,
                  sourcePort: args.sourcePort,
                  targetPort: args.targetPort,
                })
          if (asset) ops.attachAsset(ctx, node.id, asset)
          return created
        }),
      )

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
    capability: 'flow:write',
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
      assertNotManaged([...Object.keys(data), ...removeData])
      assertNotDirector([...Object.keys(data), ...removeData], 'update_node')

      const label = await canvas.write((doc) =>
        runOps(() => {
          const ctx = ops.opContext(doc)
          // 要碰的组先全部校验一遍再动手：事务不回滚，不能改完 metadata 才发现 data 改不了
          const writes: [FlowNodeGroup, ops.NodeFieldChanges][] = []
          if (Object.keys(metadata).length > 0) writes.push(['metadata', { set: metadata }])
          if (Object.keys(data).length > 0 || removeData.length > 0) {
            writes.push(['data', { set: data, remove: removeData }])
          }
          for (const [group, changes] of writes) ops.assertNodeFieldsWritable(ctx, args.id, group, changes)
          // 按 key 合并：只 set 给出的那几个，别人同时改的别的字段不受影响
          for (const [group, changes] of writes) ops.writeNodeFields(ctx, args.id, group, changes)
          return nodeLabel(doc, args.id)
        }),
      )

      return result(`已修改节点 ${args.id}`, {
        summary: `修改节点${quote(label)}`,
        elementIds: [args.id],
      })
    },
  }

  const connect: CanvasTool<typeof connectParams> = {
    name: 'connect',
    capability: 'flow:write',
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

      const created = await canvas.write((doc) =>
        runOps(() => {
          const edge = ops.connect(ops.opContext(doc), args)
          return {
            edge,
            summary: `连线${quote(nodeLabel(doc, args.source))} → ${quote(nodeLabel(doc, args.target))}`,
          }
        }),
      )

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
    capability: 'flow:delete',
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
        const ctx = ops.opContext(doc)
        const doomedNodes: string[] = []
        const doomedEdges: string[] = []
        const missing: string[] = []
        for (const id of ids) {
          if (ctx.nodes.has(id)) doomedNodes.push(id)
          else if (ctx.edges.has(id)) doomedEdges.push(id)
          else missing.push(id)
        }
        // 有一个不存在就整个拒绝：模型多半是猜错了 id，不该删掉剩下那些
        if (missing.length > 0) {
          throw new Error(`这些 id 不存在：${missing.join(', ')}；先 read_canvas 确认`)
        }
        // 连着被删节点的线一起删；删分组 = 解散（子节点换算回画布坐标）—— 和编辑器的删除同一个操作
        return ops.removeElements(ctx, doomedNodes, doomedEdges)
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

  const getNode: CanvasTool<typeof getNodeParams> = {
    name: 'get_node',
    capability: 'flow:read',
    label: '读取节点',
    description:
      '读取一个节点：形状和 read_canvas 里的节点条目一样（layout / metadata / data / runtime / inputs），' +
      '另附它这个类型的端口（ports）。只关心一个节点（例如 @ 提及的那个、刚改过的那个）时用它，比 read_canvas 省。',
    parameters: getNodeParams,
    executionMode: 'sequential',
    describe: (args) => `读取节点 ${args.id}`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      const node = await canvas.read((doc) => readNodeById(doc, args.id))
      if (!node) throw notFound(args.id)
      const inputs = portsOf(node.type, 'inputs')
      const outputs = portsOf(node.type, 'outputs')
      return result(
        JSON.stringify({
          ...nodeSnapshot(node),
          ...(inputs.length + outputs.length > 0
            ? { ports: { inputs: inputs.map(portView), outputs: outputs.map(portView) } }
            : {}),
        }),
        { summary: `读取节点${quote(node.metadata.label || node.id)}`, elementIds: [], readNodeIds: [node.id] },
      )
    },
  }

  const checkConnection: CanvasTool<typeof checkConnectionParams> = {
    name: 'check_connection',
    capability: 'flow:read',
    label: '检查连线',
    description:
      '只检查、不连：这两个节点之间现在能不能连线，能的话会连哪对端口（和 connect 同一套规则）。' +
      '返回 { ok: true, sourcePort, targetPort } 或 { ok: false, reason }。拿不准时先问它，省得 connect 报错。',
    parameters: checkConnectionParams,
    executionMode: 'sequential',
    describe: (args) => `检查连线 ${args.source} → ${args.target}`,
    async execute(_id, args) {
      assertId(args.source, 'source')
      assertId(args.target, 'target')
      const verdict = await canvas.read((doc) => {
        const ctx = ops.opContext(doc)
        for (const id of [args.source, args.target]) {
          if (!ops.readNodeRecord(ctx, id)) throw notFound(id)
        }
        // 只走逻辑门（和 connect 一样）；不写任何东西
        return resolveConnection(args, ops.docConnectionContext(ctx))
      })
      const text = verdict.ok
        ? { ok: true, sourcePort: verdict.sourcePort, targetPort: verdict.targetPort }
        : { ok: false, reason: verdict.reason }
      return result(JSON.stringify(text), {
        summary: `检查连线 ${args.source} → ${args.target}：${verdict.ok ? '可以连' : '不能连'}`,
        elementIds: [],
      })
    },
  }

  const moveNodes: CanvasTool<typeof moveNodesParams> = {
    name: 'move_nodes',
    capability: 'flow:write',
    label: '移动节点',
    description:
      `把一批节点挪到新位置（左上角坐标），一次最多 ${TOOL_LIMITS.movePerCall} 个。` +
      '组内节点的坐标相对它所在的分组框（read_canvas 里带 parentNode 的那些）。整片重排请用 auto_layout。',
    parameters: moveNodesParams,
    executionMode: 'sequential',
    describe: (args) => `移动 ${args.moves.length} 个节点`,
    async execute(_id, args) {
      const ids = args.moves.map((move) => move.id)
      assertIdList(ids, TOOL_LIMITS.movePerCall, '要移动的节点')
      for (const move of args.moves) {
        assertCoord(move.x, `${move.id} 的 x`)
        assertCoord(move.y, `${move.id} 的 y`)
      }
      const moved = await canvas.write((doc) => {
        const ctx = ops.opContext(doc)
        // 有一个不存在就整个拒绝：模型多半是猜错了 id，不该只挪一半
        const missing = ids.filter((id) => !ops.readNodeRecord(ctx, id))
        if (missing.length > 0) throw new Error(`这些节点不存在：${missing.join(', ')}；先 read_canvas 确认`)
        return ops.moveNodes(
          ctx,
          args.moves.map((move): [string, ops.Point] => [move.id, { x: move.x, y: move.y }]),
        )
      })
      return result(JSON.stringify({ moved }), { summary: `移动 ${moved.length} 个节点`, elementIds: moved })
    },
  }

  const resizeNode: CanvasTool<typeof resizeNodeParams> = {
    name: 'resize_node',
    capability: 'flow:write',
    label: '调整尺寸',
    description:
      `改一个节点的宽高（像素，${TOOL_LIMITS.sizeMin}–${TOOL_LIMITS.sizeMax}），左上角不动。` +
      '主要用于分组框（放不下组员时拉大）；图片 / 视频的尺寸画布会按素材比例自己记，一般不用改。',
    parameters: resizeNodeParams,
    executionMode: 'sequential',
    describe: (args) => `调整节点 ${args.id} 的尺寸`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      assertSize(args.width, 'width')
      assertSize(args.height, 'height')
      const label = await canvas.write((doc) =>
        runOps(() => {
          ops.resizeNode(ops.opContext(doc), args.id, { width: args.width, height: args.height })
          return nodeLabel(doc, args.id)
        }),
      )
      return result(`已把节点 ${args.id} 调整为 ${args.width}×${args.height}`, {
        summary: `调整${quote(label)}的尺寸为 ${args.width}×${args.height}`,
        elementIds: [args.id],
      })
    },
  }

  const duplicateNode: CanvasTool<typeof duplicateNodeParams> = {
    name: 'duplicate_node',
    capability: 'flow:write',
    label: '复制节点',
    description:
      '复制一个节点：类型、名字、业务字段照抄，运行状态清空、不带产出，连线一条都不复制。' +
      `副本默认错开 ${TOOL_LIMITS.duplicateOffset}px（组内节点的副本留在同一个分组里）。分组框不能复制。返回副本 id。`,
    parameters: duplicateNodeParams,
    executionMode: 'sequential',
    describe: (args) => `复制节点 ${args.id}`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      const offset = args.offset ?? { x: TOOL_LIMITS.duplicateOffset, y: TOOL_LIMITS.duplicateOffset }
      assertCoord(offset.x, 'offset.x')
      assertCoord(offset.y, 'offset.y')
      const copy = await canvas.write((doc) =>
        runOps(() => {
          const ctx = ops.opContext(doc)
          // 和编辑器一致：分组没有「复制」（只复制框不带组员没有意义）
          if (ops.readNodeRecord(ctx, args.id)?.type === GROUP_NODE_TYPE) throw new Error('分组框不能复制')
          return ops.duplicateNode(ctx, args.id, { id: createId(NODE_ID_PREFIX), offset })
        }),
      )
      return result(JSON.stringify({ id: copy.id, position: copy.layout.position }), {
        summary: `复制节点${quote(copy.metadata.label || args.id)}`,
        elementIds: [copy.id],
      })
    },
  }

  const groupNodes: CanvasTool<typeof groupNodesParams> = {
    name: 'group_nodes',
    capability: 'flow:write',
    label: '打组',
    description:
      '把几个节点圈进一个新的分组框（至少两个、都得是顶层节点、不能是分组本身）。分组框按它们的位置和估计尺寸自动围出来；' +
      '组员挂到分组下之后，它们的坐标改为相对分组框。返回分组 id。',
    parameters: groupNodesParams,
    executionMode: 'sequential',
    describe: (args) => `把 ${args.ids.length} 个节点打组`,
    async execute(_id, args) {
      assertIdList(args.ids, TOOL_LIMITS.groupMembers, '要打组的节点')
      if (args.label !== undefined) assertLength(args.label, TOOL_LIMITS.label, '分组名')
      const created = await canvas.write((doc) =>
        runOps(() => {
          const ctx = ops.opContext(doc)
          // 外框按存的位置 + 估计尺寸算（服务端量不到实测尺寸），先算好、校验完再建
          const frame = ops.groupFrameFor(ctx, args.ids)
          let groups = 0
          for (const id of ctx.nodes.keys()) if (ops.readNodeRecord(ctx, id)?.type === GROUP_NODE_TYPE) groups += 1
          const group = buildNodeRecord({
            id: createId(NODE_ID_PREFIX),
            type: GROUP_NODE_TYPE,
            // 自动编号和编辑器的 groupSelection 同一个口径
            label: args.label ?? `分组 ${groups + 1}`,
            position: frame.position,
          })
          group.layout.width = frame.width
          group.layout.height = frame.height
          const attached = ops.groupNodes(ctx, group, frame.children)
          return { group, attached }
        }),
      )
      return result(
        JSON.stringify({
          id: created.group.id,
          position: created.group.layout.position,
          width: created.group.layout.width,
          height: created.group.layout.height,
          children: created.attached,
        }),
        {
          summary: `把 ${created.attached.length} 个节点打组为${quote(created.group.metadata.label)}`,
          elementIds: [created.group.id, ...created.attached],
        },
      )
    },
  }

  const ungroup: CanvasTool<typeof ungroupParams> = {
    name: 'ungroup',
    capability: 'flow:delete',
    label: '解组',
    description:
      '解散一个分组：拆掉分组框，组里的节点留在原地（坐标换回画布坐标）。只接受分组框的 id。' +
      `拆掉的分组框算一次删除，计入每轮 ${TOOL_LIMITS.deletePerRun} 个的删除上限。`,
    parameters: ungroupParams,
    executionMode: 'sequential',
    describe: (args) => `解散分组 ${args.id}`,
    async execute(_id, args) {
      assertId(args.id, 'id')
      // 解组 = 删掉分组框（和 delete_elements 删分组效果相同），所以同一份预算：不能拿它绕开删除上限
      if (runState.deleted + 1 > TOOL_LIMITS.deletePerRun) {
        throw new Error(
          `本轮已删除 ${runState.deleted} 个元素，解组要拆掉分组框，会超过每轮上限 ${TOOL_LIMITS.deletePerRun}，已拒绝。` +
            '请告诉用户需要解散哪个分组，由用户自己操作。',
        )
      }
      const done = await canvas.write((doc) =>
        runOps(() => {
          const label = nodeLabel(doc, args.id)
          return { label, ...ops.ungroup(ops.opContext(doc), args.id) }
        }),
      )
      runState.deleted += 1
      return result(JSON.stringify({ children: done.children, edges: done.edges }), {
        summary: `解散分组${quote(done.label)}（${done.children.length} 个节点留在原地）`,
        elementIds: [args.id, ...done.children, ...done.edges],
      })
    },
  }

  const autoLayout: CanvasTool<typeof autoLayoutParams> = {
    name: 'auto_layout',
    capability: 'flow:write',
    label: '自动布局',
    description:
      '把整张画布从左到右按连线分层重新排列（和画布上的「自动布局」按钮同一个算法）。只挪顶层节点，分组连同组员整体挪。' +
      '尺寸是估计的，结果可能和用户点按钮排的略有出入。建完一批节点、连好线之后用它收拾版面，不要一个个 move_nodes。',
    parameters: autoLayoutParams,
    executionMode: 'sequential',
    describe: () => '自动布局',
    async execute() {
      const moved = await canvas.write((doc) => {
        const ctx = ops.opContext(doc)
        if (ctx.nodes.size > TOOL_LIMITS.layoutNodes) {
          throw new Error(`画布有 ${ctx.nodes.size} 个节点，超过 ${TOOL_LIMITS.layoutNodes} 个，请让用户在画布上点「自动布局」`)
        }
        return ops.autoLayout(ctx)
      })
      return result(JSON.stringify({ moved }), {
        summary: moved.length > 0 ? `自动布局（移动 ${moved.length} 个节点）` : '自动布局（已经排好，无需移动）',
        elementIds: moved,
      })
    },
  }

  /**
   * 读一张图交给模型：读字节（宿主的 `MediaReader`，只读本服务的对象存储）→ 单张上限 → 按字节嗅类型 → 本轮累计预算。
   * `view_node_media` 和 `view_attachment` 共用，所以两者花的是同一份 `runState.mediaBytes`。
   */
  async function readViewableImage(
    reader: MediaReader,
    url: string,
    what: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { ok: true; image: { type: 'image'; data: string; mimeType: string }; size: number }
    | { ok: false; message: string }
  > {
    if (signal?.aborted) throw new Error('已中止')
    let asset
    try {
      asset = await reader.read(url, { maxBytes: TOOL_LIMITS.mediaBytes, ...(signal ? { signal } : {}) })
    } catch (err) {
      return { ok: false, message: mediaFailure(err, what) }
    }
    const size = asset.data.byteLength
    if (size > TOOL_LIMITS.mediaBytes) return { ok: false, message: `${what}超过 ${megabytes(TOOL_LIMITS.mediaBytes)}，不能查看` }
    const mimeType = sniffImageType(asset.data)
    if (!mimeType) {
      return { ok: false, message: `${what}不是能查看的图片格式（只支持 ${VIEWABLE_IMAGE_TYPES.join(' / ')}）` }
    }
    if (runState.mediaBytes + size > TOOL_LIMITS.mediaBytesPerRun) {
      return {
        ok: false,
        message: `本轮已查看 ${megabytes(runState.mediaBytes)} 的素材，再看这张会超过每轮上限 ${megabytes(TOOL_LIMITS.mediaBytesPerRun)}，已拒绝`,
      }
    }
    runState.mediaBytes += size
    return { ok: true, image: { type: 'image', data: Buffer.from(asset.data).toString('base64'), mimeType }, size }
  }

  const viewNodeMedia: CanvasTool<typeof viewMediaParams> = {
    name: VIEW_MEDIA_TOOL_NAME,
    capability: 'flow:read',
    label: '查看素材',
    description:
      `用多模态直接看节点上的图：图片节点给出图片本身，视频节点只给预览图（data.poster，看不到视频内容）。` +
      `一次最多 ${TOOL_LIMITS.mediaPerCall} 个节点，单张不超过 ${megabytes(TOOL_LIMITS.mediaBytes)}，` +
      `一轮累计不超过 ${megabytes(TOOL_LIMITS.mediaBytesPerRun)}；只能看用户上传到画布的素材，外部链接看不了。` +
      '用户问图里有什么、要按图的内容写文字 / 起名 / 判断时用它；只需要地址或名字时用 get_node 就够了。',
    parameters: viewMediaParams,
    executionMode: 'sequential',
    describe: (args) => `查看 ${args.ids.length} 个节点的素材`,
    async execute(_id, args, signal) {
      assertIdList(args.ids, TOOL_LIMITS.mediaPerCall, '要查看的节点')
      const reader = options.media
      if (!reader) throw new Error('服务端没有接入素材读取，看不了节点上的图')
      const nodes = await canvas.read((doc) => args.ids.map((id) => readNodeById(doc, id)))
      // 有一个不存在就整个拒绝（和其余批量工具一样）：模型多半是猜错了 id
      const missing = args.ids.filter((_, index) => !nodes[index])
      if (missing.length > 0) throw new Error(`这些节点不存在：${missing.join(', ')}；先 read_canvas 确认`)

      const content: AgentToolResult<CanvasToolDetails>['content'] = []
      /** 每个节点一句话；全都是错误时整个调用报错 */
      const lines: { text: string; error: boolean }[] = []
      let images = 0
      for (const node of nodes as FlowNode[]) {
        const head = `节点 ${node.id}（${node.type}，名字${quote(node.metadata.label || node.id)}）`
        const say = (text: string, error: boolean) => {
          lines.push({ text: `${head}：${text}`, error })
          content.push({ type: 'text', text: `${head}：${text}` })
        }
        const field = node.type === 'image' ? 'src' : node.type === 'video' ? 'poster' : null
        if (!field) {
          say(`是 ${node.type} 类型，只有图片和视频节点能查看`, true)
          continue
        }
        const url = node.data[field]
        if (typeof url !== 'string' || url.trim() === '') {
          if (node.type === 'video') say('是视频，但没有预览图（data.poster），这一版看不到视频内容', false)
          else say('还没有图片（data.src 为空）', true)
          continue
        }
        const what = node.type === 'video' ? '它的预览图' : '它的图片'
        const viewed = await readViewableImage(reader, url, what, signal)
        if (!viewed.ok) {
          say(viewed.message, true)
          continue
        }
        images += 1
        say(
          node.type === 'video'
            ? `视频本身看不到，下面是它的预览图（${viewed.image.mimeType}，${megabytes(viewed.size)}）`
            : `下面是它的图片（${viewed.image.mimeType}，${megabytes(viewed.size)}）`,
          false,
        )
        content.push(viewed.image)
      }

      if (lines.every((line) => line.error)) throw new Error(lines.map((line) => line.text).join('\n'))
      return {
        content,
        details: {
          summary: images > 0 ? `查看 ${images} 张图片` : `查看素材（${nodes.length} 个节点，没有可看的图）`,
          elementIds: [],
          readNodeIds: (nodes as FlowNode[]).map((node) => node.id),
        },
      }
    },
  }

  const viewAttachment: CanvasTool<typeof viewAttachmentParams> = {
    name: VIEW_ATTACHMENT_TOOL_NAME,
    capability: 'flow:read',
    label: '查看附件',
    description:
      `用多模态直接看用户随消息上传的图片附件（用户消息末尾「附件」块里列出的键）。` +
      `一次最多 ${TOOL_LIMITS.mediaPerCall} 个，单张不超过 ${megabytes(TOOL_LIMITS.mediaBytes)}，和 view_node_media 共用每轮 ${megabytes(TOOL_LIMITS.mediaBytesPerRun)} 的上限；` +
      '视频和其他文件看不到内容。只需要地址或名字时不用调它。',
    parameters: viewAttachmentParams,
    executionMode: 'sequential',
    describe: (args) => `查看 ${args.keys.length} 个附件`,
    async execute(_id, args, signal) {
      if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.length > TOOL_LIMITS.mediaPerCall) {
        throw new Error(`要查看的附件需要 1–${TOOL_LIMITS.mediaPerCall} 个`)
      }
      const reader = options.media
      if (!reader) throw new Error('服务端没有接入素材读取，看不了附件')
      const known = new Map((options.attachments ?? []).map((item) => [item.key, item]))
      // 只认这个会话里用户发过的附件：别的键（猜的、别的画布的）一律拒，不去读
      const missing = args.keys.filter((key) => !known.has(key))
      if (missing.length > 0) throw new Error(`这些不是这个会话里的附件：${missing.join(', ')}；只能看用户消息「附件」块里列出的键`)

      const content: AgentToolResult<CanvasToolDetails>['content'] = []
      const lines: { text: string; error: boolean }[] = []
      let images = 0
      for (const key of new Set(args.keys)) {
        const item = known.get(key)!
        const head = `附件 ${key}（${quote(item.name)}）`
        const say = (text: string, error: boolean) => {
          lines.push({ text: `${head}：${text}`, error })
          content.push({ type: 'text', text: `${head}：${text}` })
        }
        if (agentAttachmentKind(item.contentType) !== 'image') {
          say(`是 ${item.contentType || '未知类型'}，只有图片附件能查看`, true)
          continue
        }
        const viewed = await readViewableImage(reader, item.url, '这个附件', signal)
        if (!viewed.ok) {
          say(viewed.message, true)
          continue
        }
        images += 1
        say(`下面是它的内容（${viewed.image.mimeType}，${megabytes(viewed.size)}）`, false)
        content.push(viewed.image)
      }

      if (lines.every((line) => line.error)) throw new Error(lines.map((line) => line.text).join('\n'))
      return {
        content,
        details: { summary: images > 0 ? `查看 ${images} 个附件` : '查看附件（没有可看的图）', elementIds: [] },
      }
    },
  }

  return [
    readCanvas,
    getNode,
    viewNodeMedia,
    viewAttachment,
    addNode,
    updateNode,
    duplicateNode,
    connect,
    checkConnection,
    deleteElements,
    moveNodes,
    resizeNode,
    groupNodes,
    ungroup,
    autoLayout,
  ] as unknown as CanvasTool[]
}
