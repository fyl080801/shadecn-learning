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
   * **一个都不声明**就是和谁都能连的普通节点 —— `text` / `process` 就是这样。
   */
  inputs?: PortDef[]
  outputs?: PortDef[]
}

/**
 * 注册表本体。**键的顺序有意义**：从一个带端口的节点「长出新节点」时，取的是这里
 * 第一个能和它连上的类型（`findGrowType`）。所以「加工」类型排在「素材」类型前面 ——
 * 从一张图往右长，长出来的应该是图生图，而不是另一张素材图。
 *
 * **每个类型里端口的声明顺序也有意义**：画布上一个节点最多左右各一个连接点，连线时连的是哪对端口
 * 由 `resolveConnection` 按声明顺序自动选（第一对类型兼容、目标没满的）。
 *
 * 示例数据（`sample/画布数据参考/`）里的七种业务节点都在这里，端口照样例里真实出现过的连线声明：
 * text-input → text-config / video-config，image-source → image-config / video-config /
 * director-console / image-source（派生），image-config → video-config / image-config /
 * image-source，director-console → image-source（截图）/ video-source（录制），
 * video-source → video-config。
 */
export const FLOW_NODE_TYPE_DEFAULTS: Record<string, FlowNodeTypeDefaults> = {
  text: {
    type: 'text',
    // 正文单独占一个 key（平铺在 data 上）：两个人一个改标题一个改正文才不会互相盖掉
    defaultData: () => ({ text: '' }),
  },
  process: {
    type: 'process',
  },
  [GROUP_NODE_TYPE]: {
    type: GROUP_NODE_TYPE,
    defaultData: () => ({ background: GROUP_DEFAULT_BACKGROUND }),
    defaultLayout: () => ({ ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX }),
  },
  'text-input': {
    type: 'text-input',
    defaultData: () => ({ prompt: '', negativePrompt: '' }),
    outputs: [{ id: 'text', dataType: 'text', label: '文本' }],
  },
  'image-config': {
    type: 'image-config',
    defaultData: () => ({ prompt: '', model: '', width: 1024, height: 1024 }),
    inputs: [
      { id: 'image', dataType: 'image', label: '参考图', multiple: true },
      { id: 'text', dataType: 'text', label: '提示词' },
    ],
    outputs: [{ id: 'image', dataType: 'image', label: '图片' }],
  },
  'video-config': {
    type: 'video-config',
    defaultData: () => ({ prompt: '', model: '', width: 1280, height: 720, fps: 24, duration: 5 }),
    inputs: [
      { id: 'image', dataType: 'image', label: '参考图 / 首尾帧', multiple: true },
      { id: 'video', dataType: 'video', label: '参考视频', multiple: true },
      { id: 'text', dataType: 'text', label: '提示词' },
    ],
    outputs: [{ id: 'video', dataType: 'video', label: '视频' }],
  },
  'text-config': {
    type: 'text-config',
    defaultData: () => ({ prompt: '', model: '', content: '' }),
    inputs: [
      { id: 'text', dataType: 'text', label: '文本', multiple: true },
      { id: 'image', dataType: 'image', label: '图片', multiple: true },
    ],
    outputs: [{ id: 'text', dataType: 'text', label: '文本' }],
  },
  'image-source': {
    type: 'image-source',
    defaultData: () => ({ sourceType: 'image' }),
    // 派生（裁剪、全景、截图）的来源：一张图只能从一个地方派生出来
    inputs: [{ id: 'image', dataType: 'image', label: '派生自' }],
    outputs: [{ id: 'image', dataType: 'image', label: '图片' }],
  },
  'video-source': {
    type: 'video-source',
    defaultData: () => ({ sourceType: 'video' }),
    // 导演台录制出来的视频从这里接进来
    inputs: [{ id: 'video', dataType: 'video', label: '录制自' }],
    outputs: [{ id: 'video', dataType: 'video', label: '视频' }],
  },
  'director-console': {
    type: 'director-console',
    // 场景、时间轴这类巨型对象不进默认值：它们按「平铺分键」由导演台自己写
    defaultData: () => ({ aspectRatio: '16:9', activeView: 'camera' }),
    inputs: [{ id: 'image', dataType: 'image', label: '全景 / 参考图', multiple: true }],
    outputs: [
      { id: 'image', dataType: 'image', label: '截图' },
      { id: 'video', dataType: 'video', label: '录制' },
    ],
  },
}

/** 认不认识这个 type；认不出来的按兜底类型（和 `fromYNode` 读缺失 type 时同一个） */
export function nodeTypeDefaultsOf(type: string): FlowNodeTypeDefaults {
  return FLOW_NODE_TYPE_DEFAULTS[type] ?? FLOW_NODE_TYPE_DEFAULTS[FALLBACK_NODE_TYPE]!
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
 * （text-input）就没有输入、谁也连不进去；一个都没声明的（text / process / group）
 * 是「左右各一个、和谁都能连」。
 */
export function hasPorts(type: string): boolean {
  return portsOf(type, 'inputs').length + portsOf(type, 'outputs').length > 0
}

/**
 * 节点在这一侧有没有连接点 —— 画布上左边（inputs）/ 右边（outputs）那一个圆画不画。
 * 没声明端口的类型两边都有；声明了端口的类型，这一侧至少有一个端口才有。
 */
export function hasSide(type: string, side: PortSide): boolean {
  return !hasPorts(type) || portsOf(type, side).length > 0
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
 * 这条线能不能连、连的是哪对端口 —— **唯一的连线规则**。前端拉线时的 `isValidConnection`、
 * 拉线松手真正建边、点连接点长出新节点、agent 的 `connect` 全都调它，所以人连的和 agent 连的不会有差别。
 *
 * 画布上每个节点最多左右各一个连接点（不带 id），端口不由用户点选，而是在这里**自动选**：
 *
 * 1. 两端都存在，且不是同一个节点；
 * 2. 声明过端口、但这一侧一个都没有的类型连不了（text-input 没有输入）；
 *    显式给了端口的，必须是该侧真实存在的端口；给无端口类型指定端口拒绝；
 * 3. 候选 = 起点的输出端口 × 终点的输入端口，**都按注册表里声明的顺序**，起点在外层 ——
 *    没声明端口的一侧只有一个按 `any` 算的「虚端口」（null）；
 * 4. 取第一对：数据类型兼容、目标端口没满（单输入只接一条，`max` 限多输入）、
 *    且这对端口之间还没有线（已经有了就跳过，试下一对 —— 导演台第二次连到视频生成，会落到 video 那对上）；
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

  if (!hasSide(sourceType, 'outputs')) return { ok: false, reason: `${sourceType} 没有输出端口` }
  if (!hasSide(targetType, 'inputs')) return { ok: false, reason: `${targetType} 没有输入端口` }

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

/**
 * 从一个节点的某一侧「长出」新节点时该长成什么：按 `types` 的顺序，第一个能和它连上的类型
 * （由 `attempt` 判 —— 调用方拿 `resolveConnection` 去试，规则和真连线是同一套）。
 *
 * 只看**声明了端口**的类型 —— 没声明端口的节点和谁都兼容，算进来的话永远是它赢。
 * 找不到返回 null，调用方退回默认的新建类型。
 */
export function findGrowType(
  types: Iterable<string>,
  attempt: (type: string) => ConnectionVerdict,
): { type: string; ports: ResolvedPorts } | null {
  for (const type of types) {
    if (!hasPorts(type)) continue
    const verdict = attempt(type)
    if (verdict.ok) return { type, ports: { sourcePort: verdict.sourcePort, targetPort: verdict.targetPort } }
  }
  return null
}
