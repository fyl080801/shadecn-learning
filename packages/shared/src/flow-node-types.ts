import {
  defaultEdgeData,
  defaultNodeMetadata,
  defaultNodeRuntime,
  FALLBACK_NODE_TYPE,
  nextInputIndex,
  type FlowEdge,
  type FlowNodeLayout,
  type FlowNodeRecord,
} from './flow-graph.ts'

/**
 * 节点类型注册表的**数据那一半** —— `type`、新建时的默认业务 `data`、默认布局、端口声明。
 *
 * 渲染那一半（组件、图标、菜单名）留在前端的 `apps/web/src/components/flow/node-types.ts`，
 * 它从这里取默认值再补上自己的。拆开是因为服务端也要「新建一个节点」、也要「判断这条线能不能连」：
 * agent 的画布工具（`@shadecn/agent`）建出来的节点、连出来的线必须和人在界面上点出来的一模一样，
 * 默认值和规则只能有一份（REQ-AGENT §3.2）。
 *
 * **加一种节点**：这里加一条（默认值、端口），前端注册表加一条（组件 + 图标）。
 *
 * 只用 ES2020，不碰 DOM / Node API（见本包 tsconfig 的护栏）。
 */

/** 分组框的 `type`。打组（`useFlowCanvas.groupSelection`）建的就是它 */
export const GROUP_NODE_TYPE = 'group'

/** 分组框的默认底色。半透明，因为它是背景板不是卡片 */
export const GROUP_DEFAULT_BACKGROUND = 'rgba(120, 120, 140, 0.10)'

/** 分组框的默认尺寸：够放下两三个节点，剩下的自己拉 */
export const GROUP_DEFAULT_SIZE = { width: 520, height: 360 }

/**
 * 分组框的层级。
 *
 * 必须是负数：分组是**背景板**，画在所有节点下面。Vue Flow 的节点默认 zIndex 为 0，
 * 给 0 或不给的话，后建的分组会盖住先建的节点，把它们整片挡掉。
 */
export const GROUP_Z_INDEX = -1

/**
 * 连线的 `type`。前端 `useFlowCanvas` 的 `FLOW_EDGE_TYPE` 是同一个值（Vue Flow 的默认边）；
 * agent 建的边照这个写，两边建出来的边才没有差别。
 */
export const DEFAULT_EDGE_TYPE = 'default'

// —— 端口 ——

/**
 * 端口上流动的数据种类。`any` 和谁都兼容 —— 没声明端口的节点那个唯一的连接点就按 `any` 算。
 */
export type PortDataType = 'text' | 'image' | 'video' | 'audio' | 'any'

export interface PortDef {
  /** 端口 id，即边上 `data.sourcePort` / `data.targetPort` 存的值。同一节点的输入和输出可以重名 */
  id: string
  dataType: PortDataType
  label?: string
  /** 输入端口能不能接多条线；不给 = 只能接一条 */
  multiple?: boolean
  /** `multiple` 时最多接几条；不给 = 不限 */
  max?: number
}

// —— 形态（图片 / 视频：生成 / 素材）——

/**
 * 节点的形态。只有声明了 `forms` 的类型（图片、视频）有：
 *
 * - `generate`（生成）：有底部输入框、接受连入 —— 「这张图要按连进来的素材生成」；
 * - `asset`（素材）：独立的资源，没有底部输入框，**拖线连不进去**。
 *
 * **存，不推导**：值在 `data.form`（平铺、字符串）。只经 {@link nodeFormOf} 读；没有这个字段（老数据、
 * 新建的节点）一律算 `generate`，不迁移、不按 `src` 反推。形态只在 `@shadecn/shared/flow-ops` 里变
 * （`attachAsset` / 连入时），规则见那边。
 */
export type NodeForm = 'generate' | 'asset'

/**
 * 这个类型参不参与连线。`connectable: false` 的（分组）不参与：拉线落在它身上等于落在它下面的东西上
 * （编辑器的落点判定透过它看），不提示「不能连线」。
 */
export function isConnectableType(type: string): boolean {
  return FLOW_NODE_TYPE_DEFAULTS[type]?.connectable !== false
}

/** 形态存在 `data` 上的键 */
export const NODE_FORM_KEY = 'form'

export interface FlowNodeTypeDefaults {
  /** 顶层 `type`，也是注册表的键 */
  type: string
  /** 新建时的业务 `data`。框架信息（名字、状态、创建时刻）在 metadata / runtime，这里不用管 */
  defaultData?: () => Record<string, unknown>
  /** 新建时的布局字段（尺寸、层级…）；位置由调用方给 */
  defaultLayout?: () => Partial<Omit<FlowNodeLayout, 'position'>>
  /**
   * 输入 / 输出端口。端口**不画成多个连接点**：节点左边最多一个进、右边最多一个出（都不带 id），
   * 端口只决定能连什么、连上之后是哪对（写在边的 data 上）。
   * **一个都不声明**就是和谁都能连的普通节点 —— 兜底的 `process` 就是这样。
   */
  inputs?: PortDef[]
  outputs?: PortDef[]
  /**
   * `false` = 这个类型**完全不参与连线**：两边都没有连接点，连不进也连不出（分组 —— 它是背景板，不是数据的一环）。
   * 不写就按端口声明算（一个都不声明的是「和谁都能连」）。
   */
  connectable?: false
  /**
   * 这个节点「有没有内容 / 资源」—— 文本有正文、图片 / 视频有资源地址。只是「有没有素材」，
   * **不决定形态、不决定能不能连**。不给 = 永远没有（导演台、分组）。统一经 `hasNodeResource` 调。
   */
  hasResource?: (data: Readonly<Record<string, unknown>>) => boolean
  /**
   * 这个类型有没有「生成 / 素材」两种形态（{@link NodeForm}）。不给 = 没有（文本、导演台…）。
   * 有的话：`asset` 形态的节点左边那个连接点不画、拖线连不进去（交互门，{@link interactionGate}）；
   * 已经连着的线照旧保留（读的一侧从不回写文档）。
   */
  forms?: boolean
  /**
   * 没有实测尺寸时按多大估（服务端没有 DOM：agent 摆新节点、打组算外接矩形、自动布局都靠它）。
   * 取自前端注册表 `view.class` 里的宽 / 最小高（`apps/web/src/components/flow/node-types.ts`），
   * 是**近似值**：真实高度随内容（正文行数、底部输入框、报错行）变。布局里存了 `width` / `height`
   * 的节点（分组、量过素材的图片 / 视频、拉伸过的）以存的为准，见 {@link nodeSizeOf}。
   */
  defaultSize?: NodeSize
}

export interface NodeSize {
  width: number
  height: number
}

/** 字符串字段有没有非空白内容 */
function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** 图片 / 视频的资源地址在 `data.src` */
const hasSrc = (data: Readonly<Record<string, unknown>>) => filled(data.src)

/**
 * 图片 / 视频节点共用的输入：文本（提示词）、参考图、参考视频。
 *
 * **每个输入都能接多条、不设上限**：一个节点已经被连过，别的节点还能再连进来；
 * 唯一的去重是「同一个上游、同一对端口」不连第二条（`resolveConnection` 第 4 条）。
 */
const mediaInputs = (): PortDef[] => [
  { id: 'text', dataType: 'text', label: '提示词', multiple: true },
  { id: 'image', dataType: 'image', label: '参考图', multiple: true },
  { id: 'video', dataType: 'video', label: '参考视频', multiple: true },
]

/**
 * 注册表本体。
 *
 * **键的顺序有意义**：前四个就是「可新建」的类型（`CREATABLE_NODE_TYPES`，工具栏菜单、
 * 拉线 / 点加号弹出的候选菜单、agent 的 `add_node` 都按这个顺序列）；`process` / `group` 不可新建。
 *
 * **每个类型里端口的声明顺序也有意义**：画布上一个节点最多左右各一个连接点，连线时连的是哪对端口
 * 由 `resolveConnection` 按声明顺序自动选（起点的输出在外层，第一对类型兼容、目标没满、还没连过的）。
 *
 * ## 连线关系表（起点 → 终点：选中的端口对；条件）
 *
 * | 起点 \ 终点 | text | image（generate） | video（generate） | director |
 * |---|---|---|---|---|
 * | **text**     | ✗ text 没有输入 | text → text | text → text | text → text |
 * | **image**    | ✗ | image → image | image → image | image → image |
 * | **video**    | ✗ | video → video | video → video | ✗ 导演台不收视频 |
 * | **director** | ✗ | image → image（截图）；连过再连落到 video → video（录制） | 同左 | image → image（只此一对） |
 *
 * - 终点是 **asset 形态**的 image / video：**拖线（交互门 `interactionGate`）一律拒绝**；
 *   逻辑上（`resolveConnection`，agent 的 `connect`）照上表选端口、能连，连上时 `flow-ops` 把它改回 generate。
 * - 有没有资源（`data.src`）、起点是什么形态都不影响能不能连。
 * - 每个输入端口都能接多条；同一个上游、同一对端口已经连过时试下一对，没有下一对就拒绝。
 *
 * 这张表由 `packages/shared/test/flow-node-types.test.ts` 里的全矩阵测试逐格钉住 —— 改端口声明
 * 必须同时改这张表和那份测试。
 */
export const FLOW_NODE_TYPE_DEFAULTS: Record<string, FlowNodeTypeDefaults> = {
  text: {
    type: 'text',
    // 正文单独占一个 key（平铺在 data 上）：两个人一个改标题一个改正文才不会互相盖掉
    defaultData: () => ({ text: '' }),
    hasResource: (data) => filled(data.text),
    // view.class：w-[320px] min-h-[120px]（没拉伸过时；可拉伸，拉过就是 layout 里的尺寸）
    defaultSize: { width: 320, height: 120 },
    // 文本是源头：只往外给，不接收
    outputs: [{ id: 'text', dataType: 'text', label: '文本' }],
  },
  image: {
    type: 'image',
    // 资源地址平铺在 data 上：`src` 是图片本身。形态 `form` 不写进默认值：没有 = generate
    defaultData: () => ({ src: '' }),
    hasResource: hasSrc,
    forms: true,
    // 宽 = 前端没量到素材时的 MEDIA_DEFAULT_WIDTH；高是空占位的估计。量过素材后布局里有真实宽高
    defaultSize: { width: 320, height: 200 },
    inputs: mediaInputs(),
    outputs: [{ id: 'image', dataType: 'image', label: '图片' }],
  },
  video: {
    type: 'video',
    // `src` 是视频本身，`poster` 是它的预览图（画布上只画这张，不放 <video>）
    defaultData: () => ({ src: '', poster: '' }),
    hasResource: hasSrc,
    forms: true,
    // 同图片
    defaultSize: { width: 320, height: 200 },
    inputs: mediaInputs(),
    outputs: [{ id: 'video', dataType: 'video', label: '视频' }],
  },
  director: {
    type: 'director',
    // 场景、时间轴这类巨型对象不进默认值：它们按「平铺分键」由导演台自己写
    defaultData: () => ({}),
    // 固定正方形：view.class 的 w-[240px] + body 的 aspect-square（底部输入框在框外，不算）
    defaultSize: { width: 240, height: 240 },
    inputs: [
      { id: 'image', dataType: 'image', label: '全景 / 参考图', multiple: true },
      { id: 'text', dataType: 'text', label: '描述', multiple: true },
    ],
    outputs: [
      { id: 'image', dataType: 'image', label: '截图' },
      { id: 'video', dataType: 'video', label: '录制' },
    ],
  },
  /**
   * 兜底类型：认不出的 `type`（老画布里的 `process`、已经下线的旧业务类型）按它渲染和连线，
   * 外观不变、和谁都能连。不可新建。
   */
  [FALLBACK_NODE_TYPE]: {
    type: FALLBACK_NODE_TYPE,
    // view.class：w-[360px] min-h-[202.5px]
    defaultSize: { width: 360, height: 203 },
  },
  [GROUP_NODE_TYPE]: {
    type: GROUP_NODE_TYPE,
    defaultData: () => ({ background: GROUP_DEFAULT_BACKGROUND }),
    defaultLayout: () => ({ ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX }),
    defaultSize: GROUP_DEFAULT_SIZE,
    connectable: false,
  },
}

/**
 * 能新建的节点类型，**顺序就是菜单顺序**：工具栏「添加节点」、拉线 / 点加号弹出的候选菜单、
 * agent 的 `add_node` 都只认这几种。兜底的 `process` 和分组（只能由「打组」围出来）不在里面。
 */
export const CREATABLE_NODE_TYPES = ['text', 'image', 'video', 'director'] as const

export type CreatableNodeType = (typeof CREATABLE_NODE_TYPES)[number]

/**
 * 这个节点有没有内容 / 资源：text → 正文非空白；image / video → `data.src` 非空白；其余永远没有。
 * 「有没有内容」只问这一个函数（文本的底部输入框收不收）。它**只表示有没有素材**：
 * 图片 / 视频的输入框和能不能连看形态（`nodeFormOf`），不看它。
 */
export function hasNodeResource(type: string, data: Readonly<Record<string, unknown>>): boolean {
  return FLOW_NODE_TYPE_DEFAULTS[type]?.hasResource?.(data) ?? false
}

/** 认不认识这个 type；认不出来的按兜底类型（和 `fromYNode` 读缺失 type 时同一个） */
export function nodeTypeDefaultsOf(type: string): FlowNodeTypeDefaults {
  return FLOW_NODE_TYPE_DEFAULTS[type] ?? FLOW_NODE_TYPE_DEFAULTS[FALLBACK_NODE_TYPE]!
}

/** 类型连 `defaultSize` 都没声明时的估计 */
export const FALLBACK_NODE_SIZE: NodeSize = { width: 320, height: 160 }

/** 这个类型没有实测、也没存尺寸时按多大估（认不出的类型按兜底类型） */
export function defaultNodeSize(type: string): NodeSize {
  const size = nodeTypeDefaultsOf(type).defaultSize ?? FALLBACK_NODE_SIZE
  return { width: size.width, height: size.height }
}

function positiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 不量 DOM 时一个节点的尺寸：布局里存的 `width` / `height`（分组、量过素材的图片 / 视频、拉伸过的节点都有），
 * 没存（或不是正数）的那一边按类型的 `defaultSize` 估。**近似值** —— 编辑器有实测尺寸时用实测的。
 */
export function nodeSizeOf(node: { type: string; layout: { width?: number; height?: number } }): NodeSize {
  const fallback = defaultNodeSize(node.type)
  return {
    width: positiveSize(node.layout.width) ? node.layout.width : fallback.width,
    height: positiveSize(node.layout.height) ? node.layout.height : fallback.height,
  }
}

export interface BuildNodeOptions {
  id: string
  type: string
  label: string
  position: { x: number; y: number }
  createdBy?: string
}

/**
 * 按注册表拼一个新节点：布局（默认尺寸、层级 + 给定位置）、metadata、默认业务 data、空闲的运行态。
 *
 * 前端和 agent 都走它 —— 默认值只有这一份，同一种节点不会因为谁建的而长得不一样。
 */
export function buildNodeRecord(
  options: BuildNodeOptions,
  defaults: FlowNodeTypeDefaults = nodeTypeDefaultsOf(options.type),
): FlowNodeRecord {
  return {
    id: options.id,
    type: options.type,
    layout: { ...defaults.defaultLayout?.(), position: { ...options.position } },
    metadata: defaultNodeMetadata(options.label, options.createdBy),
    data: defaults.defaultData?.() ?? {},
    runtime: defaultNodeRuntime(),
  }
}

// —— 连线规则（前端拉线 / 长出新节点、agent 的 connect 共用这一套）——

export type PortSide = 'inputs' | 'outputs'

/** 某类型在某一侧声明的端口；没声明返回空数组 */
export function portsOf(type: string, side: PortSide): PortDef[] {
  return FLOW_NODE_TYPE_DEFAULTS[type]?.[side] ?? []
}

/**
 * 这个类型声明过端口没有（任一侧）。声明过的类型**只有**声明了的那些端口：只声明了输出的
 * （text）就没有输入、谁也连不进去；一个都没声明的（兜底的 process）
 * 是「左右各一个、和谁都能连」。不参与连线的类型（`connectable: false`，分组）另由 {@link declaresSide} 拦。
 */
export function hasPorts(type: string): boolean {
  return portsOf(type, 'inputs').length + portsOf(type, 'outputs').length > 0
}

/**
 * 这个类型在这一侧**声明**过端口没有（不看节点数据）。没声明端口的类型两边都算有；
 * `connectable: false` 的类型（分组）两边都没有。「此刻能不能连」要用带数据的 `hasSide`。
 */
export function declaresSide(type: string, side: PortSide): boolean {
  if (!isConnectableType(type)) return false
  return !hasPorts(type) || portsOf(type, side).length > 0
}

/**
 * 节点的形态（{@link NodeForm}）。类型没有形态（`forms` 没声明）返回 null；
 * 有形态但 `data.form` 缺失 / 不认识 → `generate`（老数据不迁移、不按 `src` 反推）。
 * **形态只问这一个函数**，别在别处读 `data.form`。
 */
export function nodeFormOf(type: string, data: Readonly<Record<string, unknown>>): NodeForm | null {
  if (!FLOW_NODE_TYPE_DEFAULTS[type]?.forms) return null
  return data[NODE_FORM_KEY] === 'asset' ? 'asset' : 'generate'
}

/**
 * 节点在这一侧**此刻**有没有连接点 —— 画布上左边（inputs）/ 右边（outputs）那一个圆画不画，
 * 也是交互门（{@link interactionGate}）判「拖线能不能连进来」的同一个函数。
 *
 * `data` 是节点的业务数据，**必填**：输入开不开放看形态（asset 形态的图片 / 视频不画左边），
 * 必填是为了每个调用方都没法漏掉这条。
 */
export function hasSide(type: string, side: PortSide, data: Readonly<Record<string, unknown>>): boolean {
  if (!declaresSide(type, side)) return false
  return side === 'outputs' || nodeFormOf(type, data) !== 'asset'
}

/** 按 id 找端口；`port` 为 null 返回 null */
export function findPort(type: string, side: PortSide, port: string | null): PortDef | null {
  if (port === null) return null
  return portsOf(type, side).find((item) => item.id === port) ?? null
}

/** 两种数据能不能接上：相同，或任一边是 `any` */
export function isDataTypeCompatible(from: PortDataType, to: PortDataType): boolean {
  return from === 'any' || to === 'any' || from === to
}

/** 一个输入端口最多接几条线 */
export function portCapacity(port: PortDef): number {
  if (!port.multiple) return 1
  return port.max ?? Number.POSITIVE_INFINITY
}

export interface ConnectionCandidate {
  source: string
  target: string
  /** 显式指定起点的输出端口；不给就自动选 */
  sourcePort?: string | null
  /** 显式指定终点的输入端口；不给就自动选 */
  targetPort?: string | null
}

export interface ConnectionContext {
  /** 按节点 id 取类型；节点不存在返回 undefined */
  typeOf: (nodeId: string) => string | undefined
  /**
   * 按节点 id 取业务 `data`（交互门要看形态）；取不到按空对象算。
   * **必填**：同一个上下文既喂交互门又喂 `resolveConnection`，谁都没法漏掉形态这条。
   */
  dataOf: (nodeId: string) => Readonly<Record<string, unknown>> | undefined
  /** 画布上已有的边（端口读的是 `data.sourcePort` / `data.targetPort`） */
  edges: Iterable<Pick<FlowEdge, 'id' | 'source' | 'target' | 'data'>>
  /** 正在被改端点的那条边自己（重连时），不算进容量和重复判断 */
  ignoreEdgeId?: string
}

/** 选定的那对端口；没声明端口的一侧是 null */
export interface ResolvedPorts {
  sourcePort: string | null
  targetPort: string | null
}

export type ConnectionVerdict = ({ ok: true } & ResolvedPorts) | { ok: false; reason: string }

/** 边上存的端口（老边、无端口的边没有就是 null） */
function portOfEdge(edge: Pick<FlowEdge, 'data'>, key: 'sourcePort' | 'targetPort'): string | null {
  const port = edge.data?.[key]
  return typeof port === 'string' && port ? port : null
}

/**
 * 交互门：**人拖线**能不能连进 `target`（拉线途中的 `is-valid-connection`、松手建边、落在节点身上、
 * 候选菜单都先问它，再问 `resolveConnection`）。基于 {@link hasSide}：asset 形态的图片 / 视频不接受拖进来的线。
 *
 * **逻辑上不拦**：`resolveConnection`（agent 的 `connect`、`flow-ops`）不看形态，能连进 asset 节点，
 * 连上时由 `flow-ops` 把它改回 generate —— 两道门不互斥。
 */
export function interactionGate(
  candidate: Pick<ConnectionCandidate, 'target'>,
  context: Pick<ConnectionContext, 'typeOf' | 'dataOf'>,
): { ok: true } | { ok: false; reason: string } {
  const type = context.typeOf(candidate.target)
  if (type === undefined) return { ok: true }
  if (declaresSide(type, 'inputs') && !hasSide(type, 'inputs', context.dataOf(candidate.target) ?? {})) {
    return { ok: false, reason: `${type} 节点是素材，不接受连入` }
  }
  return { ok: true }
}

/**
 * 这条线能不能连、连的是哪对端口 —— **唯一的连线规则（逻辑门）**。前端拉线时的 `isValidConnection`、
 * 拉线松手真正建边、点连接点长出新节点、agent 的 `connect` 全都调它，所以人连的和 agent 连的不会有差别。
 * 它**只做端口匹配**，不看资源、不看形态；人拖线额外先过 {@link interactionGate}。
 *
 * 画布上每个节点最多左右各一个连接点（不带 id），端口不由用户点选，而是在这里**自动选**：
 *
 * 1. 两端都存在，且不是同一个节点；
 * 2. 声明过端口、但这一侧一个都没有的类型连不了（text 没有输入）；
 *    显式给了端口的，必须是该侧真实存在的端口；给无端口类型指定端口拒绝；
 * 3. 候选 = 起点的输出端口 × 终点的输入端口，**都按注册表里声明的顺序**，起点在外层 ——
 *    没声明端口的一侧只有一个按 `any` 算的「虚端口」（null）；
 * 4. 取第一对：数据类型兼容、目标端口没满（单输入只接一条，`max` 限多输入；眼下的类型都是不限条数的多输入）、
 *    且这对端口之间还没有线（已经有了就跳过，试下一对 —— 导演台第二次连到视频，会落到 video 那对上）；
 * 5. 一对都不行就拒绝，原因按「类型不兼容 < 端口已满 < 已经连过」取最接近能连上的那条。
 *
 * 两端都没声明端口的连线：选出来的是 (null, null)，同方向已经有一条就拒绝，不连第二条。
 */
export function resolveConnection(
  candidate: ConnectionCandidate,
  context: ConnectionContext,
): ConnectionVerdict {
  const sourceType = context.typeOf(candidate.source)
  const targetType = context.typeOf(candidate.target)
  if (sourceType === undefined) return { ok: false, reason: `起点节点 ${candidate.source} 不存在` }
  if (targetType === undefined) return { ok: false, reason: `终点节点 ${candidate.target} 不存在` }
  if (candidate.source === candidate.target) return { ok: false, reason: '起点和终点不能是同一个节点' }

  if (!isConnectableType(sourceType)) return { ok: false, reason: `${sourceType} 不能连线` }
  if (!isConnectableType(targetType)) return { ok: false, reason: `${targetType} 不能连线` }
  if (!declaresSide(sourceType, 'outputs')) return { ok: false, reason: `${sourceType} 没有输出端口` }
  if (!declaresSide(targetType, 'inputs')) return { ok: false, reason: `${targetType} 没有输入端口` }

  const sources = candidatesOf(sourceType, 'outputs', candidate.sourcePort)
  if (!sources.ok) return sources
  const targets = candidatesOf(targetType, 'inputs', candidate.targetPort)
  if (!targets.ok) return targets

  // 这次要用到的已有边：只看连到这个终点的
  const incoming: { source: string; sourcePort: string | null; targetPort: string | null }[] = []
  for (const edge of context.edges) {
    if (edge.id === context.ignoreEdgeId || edge.target !== candidate.target) continue
    incoming.push({
      source: edge.source,
      sourcePort: portOfEdge(edge, 'sourcePort'),
      targetPort: portOfEdge(edge, 'targetPort'),
    })
  }

  // 0 = 类型都不兼容，1 = 兼容但满了，2 = 兼容也没满，但这对已经连过
  let closest = 0
  let fullPort: PortDef | null = null
  for (const from of sources.ports) {
    for (const to of targets.ports) {
      if (!isDataTypeCompatible(from?.dataType ?? 'any', to?.dataType ?? 'any')) continue
      const sourcePort = from?.id ?? null
      const targetPort = to?.id ?? null
      const onPort = incoming.filter((edge) => edge.targetPort === targetPort)
      if (onPort.some((edge) => edge.source === candidate.source && edge.sourcePort === sourcePort)) {
        closest = Math.max(closest, 2)
        continue
      }
      if (to && onPort.length >= portCapacity(to)) {
        if (closest < 1) fullPort = to
        closest = Math.max(closest, 1)
        continue
      }
      return { ok: true, sourcePort, targetPort }
    }
  }

  if (closest === 2) return { ok: false, reason: '这两个节点之间能连的端口都已经有线了' }
  if (closest === 1 && fullPort) {
    return { ok: false, reason: `输入端口 ${fullPort.label ?? fullPort.id} 已经接满（最多 ${portCapacity(fullPort)} 条）` }
  }
  const describe = (ports: (PortDef | null)[]) => ports.map((port) => port?.dataType ?? 'any').join(' / ')
  return {
    ok: false,
    reason: `数据类型不匹配：${sourceType} 的输出（${describe(sources.ports)}）接不到 ${targetType} 的输入（${describe(targets.ports)}）`,
  }
}

/** 某一侧参与挑选的端口：显式给了就只有它；没声明端口的类型是一个 null（按 any 算） */
function candidatesOf(
  type: string,
  side: PortSide,
  given: string | null | undefined,
): { ok: true; ports: (PortDef | null)[] } | { ok: false; reason: string } {
  const ports = portsOf(type, side)
  if (given !== undefined && given !== null) {
    if (ports.length === 0) return { ok: false, reason: `${type} 没有声明端口，不能指定端口 ${given}` }
    const port = ports.find((item) => item.id === given)
    if (!port) {
      return {
        ok: false,
        reason: `${type} 没有${side === 'inputs' ? '输入' : '输出'}端口 ${given}（可用：${ports.map((item) => item.id).join(', ')}）`,
      }
    }
    return { ok: true, ports: [port] }
  }
  return { ok: true, ports: ports.length > 0 ? ports : [null] }
}

/**
 * 选定端口之后这条边的 data：创建时刻 + 端口 + 序号（有目标端口才有，取该端口现有最大 + 1）。
 * 两端都没有端口时只有创建时刻 —— 无端口类型之间的连线不写这几个字段。
 */
export function connectionEdgeData(
  ports: ResolvedPorts,
  target: string,
  edges: Iterable<Pick<FlowEdge, 'target' | 'data'>>,
): FlowEdge['data'] {
  return {
    ...defaultEdgeData(),
    ...(ports.sourcePort !== null ? { sourcePort: ports.sourcePort } : {}),
    ...(ports.targetPort !== null
      ? { targetPort: ports.targetPort, index: nextInputIndex(edges, target, ports.targetPort) }
      : {}),
  }
}

// —— 从出口长出新节点（拉线到空白处 / 点出口上的加号）——

/**
 * 连线只有一个方向：**从出口（右边）拉向入口（左边）**。入口不能起拉、也没有加号，
 * 所以「长出新节点」只有一种：新节点在下游、是终点。
 */

/** 一个能长出来的类型，和长出来之后那条线会连哪对端口 */
export interface GrowCandidate {
  type: string
  ports: ResolvedPorts
}

/** 列候选时给「还不存在的新节点」用的占位 id —— 不会和 `createId()` 发出来的撞 */
const CANDIDATE_NODE_ID = '\u0000candidate'

/**
 * 从 `sourceId` 的出口新建一个 `type` 节点（id 为 `newNodeId`、data 是该类型的默认值，即**全新的空节点**）
 * 并连上，这条线能不能连、连哪对端口 —— 规则就是 `resolveConnection`，新节点的类型和数据由这里补给它。
 */
export function resolveGrowConnection(
  sourceId: string,
  type: string,
  newNodeId: string,
  context: ConnectionContext,
): ConnectionVerdict {
  const fresh = nodeTypeDefaultsOf(type).defaultData?.() ?? {}
  return resolveConnection(
    { source: sourceId, target: newNodeId },
    {
      ...context,
      typeOf: (id) => (id === newNodeId ? type : context.typeOf(id)),
      dataOf: (id) => (id === newNodeId ? fresh : context.dataOf(id)),
    },
  )
}

/**
 * 从 `sourceId` 的出口能长出哪些类型 —— 拉线到空白处 / 点出口加号时弹出的那个菜单列的就是它。
 *
 * 按 `types` 的顺序（默认 `CREATABLE_NODE_TYPES`），逐个按「全新的空节点」去试 `resolveConnection`，
 * 只留能连上的（新节点一律是 generate 形态，交互门必放行，所以只看 `resolveConnection`）。
 * 一个都没有就是空数组（菜单里给一条置灰的「没有可连接的节点」）。
 */
export function connectableNodeTypes(
  sourceId: string,
  context: ConnectionContext,
  types: Iterable<string> = CREATABLE_NODE_TYPES,
): GrowCandidate[] {
  const candidates: GrowCandidate[] = []
  for (const type of types) {
    // 长出来的是全新的空节点（generate 形态），交互门必然放行，不用再问
    const verdict = resolveGrowConnection(sourceId, type, CANDIDATE_NODE_ID, context)
    if (verdict.ok) candidates.push({ type, ports: { sourcePort: verdict.sourcePort, targetPort: verdict.targetPort } })
  }
  return candidates
}
