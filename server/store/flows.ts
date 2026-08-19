import { prisma } from '../db.ts'
import { type FlowGraph, type FlowUserState, emptyGraph, readGraph } from './flow-types.ts'
import { flowUserState } from './flow-user-state.ts'
import type { ProjectKind } from './projects.ts'
import { nameContains } from './text.ts'

/**
 * 画布与操作日志的数据访问层。
 *
 * 快照 + 日志双写：graph 是全量快照（读走它，O(1)），
 * FlowOperation 只追加、不修改、不删除，作为审计与将来回放的旁路。
 */

export type FlowStatus = 'draft' | 'published' | 'archived'
export const FLOW_STATUSES: readonly FlowStatus[] = ['draft', 'published', 'archived']

export type FlowSort = 'updatedAt' | 'createdAt' | 'name'

/**
 * 这张画布走哪条同步通道（REQ-SOLO）。
 *
 * **派生自所属项目的 `kind`，不落库**：一张画布在个人空间里就是 solo，
 * 挪进团队项目就是 collab。存一份标记在 `Flow` 上，早晚会和归属对不上，
 * 而对不上的那一刻没人看得出是哪边错了。
 */
export type FlowMode = 'solo' | 'collab'

export function modeOfKind(kind: ProjectKind): FlowMode {
  return kind === 'personal' ? 'solo' : 'collab'
}

export interface FlowSummary {
  id: string
  projectId: string
  /** solo = 不走协同（个人画布）；collab = 走 WebSocket 房间 */
  mode: FlowMode
  name: string
  description: string | null
  status: FlowStatus
  tags: string[]
  thumbnail: string | null
  nodeCount: number
  edgeCount: number
  revision: number
  createdById: string
  createdAt: string
  updatedAt: string
}

export interface FlowDetail extends FlowSummary {
  graph: FlowGraph
  /**
   * 请求者**自己**的画布状态（视口等），刚建/刚复制出来的是空对象。
   * 没有的分区前端各自回落到默认值（视口回落到 graph.viewport）。
   */
  userState: FlowUserState
}

/** 操作日志的一行。`update` 二进制本身不出接口，只给量感和「谁在何时」 */
export interface FlowOperationView {
  id: string
  seq: number
  actorId: string | null
  /** 服务端收到这次更新的时刻（UTC epoch ms）；排序以它为准 */
  serverTs: number
  /** 这次 Yjs 更新的字节数 */
  size: number
}

export interface ListFlowsOptions {
  page: number
  pageSize: number
  keyword?: string
  status?: FlowStatus
  sort: FlowSort
  order: 'asc' | 'desc'
}

/** 库里那一行的形状（不含 graph），用来拼 FlowSummary */
type FlowRow = {
  id: string
  projectId: string
  /** 所属项目的形态，mode 从它派生 —— 每次查画布都顺带取出来 */
  project: { kind: string }
  name: string
  description: string | null
  status: string
  tags: string
  thumbnail: string | null
  nodeCount: number
  edgeCount: number
  revision: number
  createdById: string
  createdAt: Date
  updatedAt: Date
}

function toStatus(value: string): FlowStatus {
  return FLOW_STATUSES.includes(value as FlowStatus) ? (value as FlowStatus) : 'draft'
}

function readTags(serialized: string): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function toSummary(row: FlowRow): FlowSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    mode: modeOfKind(row.project.kind === 'personal' ? 'personal' : 'team'),
    name: row.name,
    description: row.description,
    status: toStatus(row.status),
    tags: readTags(row.tags),
    thumbnail: row.thumbnail,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    revision: row.revision,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 列表查询要用的列 —— 显式列出来，保证 graph 永远不会漏进列表响应 */
const SUMMARY_SELECT = {
  id: true,
  projectId: true,
  // mode 是派生的，所以每次都要把归属项目的形态带出来
  project: { select: { kind: true } },
  name: true,
  description: true,
  status: true,
  tags: true,
  thumbnail: true,
  nodeCount: true,
  edgeCount: true,
  revision: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const

export const flows = {
  /** 项目内的画布列表；响应里没有 graph */
  async listByProject(projectId: string, options: ListFlowsOptions) {
    const where = {
      projectId,
      deletedAt: null,
      ...(options.keyword ? { name: nameContains(options.keyword) } : {}),
      ...(options.status ? { status: options.status } : {}),
    }

    const [total, rows] = await Promise.all([
      prisma.flow.count({ where }),
      prisma.flow.findMany({
        where,
        orderBy: { [options.sort]: options.order },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        select: SUMMARY_SELECT,
      }),
    ])

    return { items: rows.map(toSummary), total }
  },

  countByProject(projectId: string) {
    return prisma.flow.count({ where: { projectId, deletedAt: null } })
  },

  async create(input: {
    projectId: string
    name: string
    description?: string | null
    createdById: string
  }): Promise<FlowDetail> {
    const graph = emptyGraph()
    const row = await prisma.flow.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        createdById: input.createdById,
        graph: JSON.stringify(graph),
      },
      select: SUMMARY_SELECT,
    })
    return { ...toSummary(row), graph, userState: {} }
  },

  /**
   * 只取归属信息，给鉴权用 —— 不读 graph。
   *
   * 连 `kind` 一起给：调用方除了「谁能进」还要知道「这是不是个人画布」
   * （协同握手要据此拒掉 solo 画布，路由要据此拒掉走错通道的写入）。
   */
  async locate(flowId: string): Promise<{ projectId: string; kind: ProjectKind } | null> {
    const row = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
      select: { projectId: true, project: { select: { kind: true } } },
    })
    if (!row) return null
    return {
      projectId: row.projectId,
      kind: row.project.kind === 'personal' ? 'personal' : 'team',
    }
  },

  /** 详情永远是「谁在看」的详情：userState 那部分因人而异 */
  async get(flowId: string, userId: string): Promise<FlowDetail | null> {
    const row = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
      select: { ...SUMMARY_SELECT, graph: true },
    })
    if (!row) return null

    return {
      ...toSummary(row),
      graph: readGraph(row.graph),
      userState: await flowUserState.get(flowId, userId),
    }
  },

  async update(
    flowId: string,
    patch: {
      name?: string
      description?: string | null
      status?: FlowStatus
      tags?: string[]
    },
  ): Promise<FlowSummary> {
    const row = await prisma.flow.update({
      where: { id: flowId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tags !== undefined ? { tags: JSON.stringify(patch.tags) } : {}),
      },
      select: SUMMARY_SELECT,
    })
    return toSummary(row)
  },

  async softDelete(flowId: string) {
    await prisma.flow.update({ where: { id: flowId }, data: { deletedAt: new Date() } })
  },

  /**
   * 复制到同一项目下；操作日志不复制，新画布 revision 从 0 起。
   *
   * **ydoc 要一起复制**：它才是内容，graph 只是投影。
   * 直接拷二进制就行 —— Yjs 的状态是自包含的，换个文档 id 照样能加载。
   */
  async duplicate(flowId: string, createdById: string): Promise<FlowDetail | null> {
    const source = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null },
      select: { ...SUMMARY_SELECT, graph: true, ydoc: true },
    })
    if (!source) return null

    const row = await prisma.flow.create({
      data: {
        projectId: source.projectId,
        name: `${source.name} 副本`,
        description: source.description,
        status: source.status,
        tags: source.tags,
        graph: source.graph,
        ydoc: source.ydoc,
        nodeCount: source.nodeCount,
        edgeCount: source.edgeCount,
        createdById,
      },
      select: { ...SUMMARY_SELECT, graph: true },
    })
    // 副本是新画布：谁都还没在它上面留下过视口
    return { ...toSummary(row), graph: readGraph(row.graph), userState: {} }
  },

  /**
   * 操作日志。
   *
   * 每条是一次 Yjs 增量更新（`update` 二进制），由 WebSocket 那边的 persistence 写入 ——
   * **没有 REST 提交入口了**，内容的写入路径只有一条：客户端改 Y.Doc → 同步到服务端 →
   * 落库（见 `server/collab/persistence.ts`）。
   *
   * 这里不返回 `update` 本身：它是二进制，塞进 JSON 只会把响应撑大，
   * 而列表页要的只是「谁在什么时候动过」。真要回放就按 seq 顺序取出来
   * `Y.applyUpdate` 到一个空文档。
   */
  async listOperations(
    flowId: string,
    options: { page: number; pageSize: number; sinceSeq?: number },
  ) {
    const where = {
      flowId,
      ...(options.sinceSeq !== undefined ? { seq: { gt: options.sinceSeq } } : {}),
    }

    const [total, rows] = await Promise.all([
      prisma.flowOperation.count({ where }),
      prisma.flowOperation.findMany({
        where,
        orderBy: { seq: 'asc' },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        select: { id: true, seq: true, actorId: true, serverTs: true, update: true },
      }),
    ])

    const items: FlowOperationView[] = rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      actorId: row.actorId,
      // 库里是 BigInt，出口转成 number：epoch ms 远在 2^53 以内，JSON 也认
      serverTs: Number(row.serverTs),
      /** 这次更新有多大（字节），给「改了多少」一个粗略的量感 */
      size: row.update.length,
    }))

    return { items, total }
  },
}
