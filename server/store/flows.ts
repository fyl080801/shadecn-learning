import { prisma } from '../db.ts'
import {
  type FlowGraph,
  type FlowTransaction,
  type FlowUserState,
  emptyGraph,
  readGraph,
} from './flow-types.ts'
import { flowUserState } from './flow-user-state.ts'
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

export interface FlowSummary {
  id: string
  projectId: string
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

export interface FlowOperationView {
  id: string
  seq: number
  txId: string
  kind: string
  label: string
  ops: unknown
  actorId: string | null
  /** 客户端产生这次事务的时刻（UTC epoch ms） */
  clientTs: number
  /** 服务端落库时刻（UTC epoch ms）；排序以它为准 */
  serverTs: number
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

  /** 只取归属信息，给鉴权中间件用 —— 不读 graph */
  async projectIdOf(flowId: string): Promise<string | null> {
    const row = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null, project: { deletedAt: null } },
      select: { projectId: true },
    })
    return row?.projectId ?? null
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

  /** 复制到同一项目下；操作日志不复制，新画布 revision 从 0 起 */
  async duplicate(flowId: string, createdById: string): Promise<FlowDetail | null> {
    const source = await prisma.flow.findFirst({
      where: { id: flowId, deletedAt: null },
      select: { ...SUMMARY_SELECT, graph: true },
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
   * 提交事务：乐观锁 + 追加日志 + 覆盖快照，全在一个数据库事务里。
   *
   * - baseRevision 对不上 → conflict，调用方回 409
   * - txId 已经存在 → 幂等跳过（网络重试会走到这里），不重复写日志、不涨 revision
   */
  async commit(input: {
    flowId: string
    baseRevision: number
    transactions: FlowTransaction[]
    graph: FlowGraph
    actorId: string | null
  }): Promise<
    { ok: true; revision: number } | { ok: false; reason: 'conflict'; revision: number }
  > {
    return prisma.$transaction(async (tx) => {
      const current = await tx.flow.findFirst({
        where: { id: input.flowId, deletedAt: null },
        select: { revision: true },
      })
      if (!current) return { ok: false as const, reason: 'conflict' as const, revision: 0 }

      // 已经落库的事务先剔掉：重试上来的那批里可能只有一部分是新的
      const known = await tx.flowOperation.findMany({
        where: { flowId: input.flowId, txId: { in: input.transactions.map((item) => item.id) } },
        select: { txId: true },
      })
      const knownIds = new Set(known.map((row) => row.txId))
      const fresh = input.transactions.filter((item) => !knownIds.has(item.id))

      // 整批都是重试 —— 快照也就没什么可写的，直接把当前 revision 还回去
      if (fresh.length === 0) return { ok: true as const, revision: current.revision }

      if (current.revision !== input.baseRevision) {
        return { ok: false as const, reason: 'conflict' as const, revision: current.revision }
      }

      // 同一批用同一个 serverTs：它们是一次提交落库的，时间上不该分先后
      const serverTs = BigInt(Date.now())

      let seq = current.revision
      for (const transaction of fresh) {
        seq += 1
        await tx.flowOperation.create({
          data: {
            flowId: input.flowId,
            seq,
            txId: transaction.id,
            kind: transaction.kind,
            label: transaction.label,
            ops: JSON.stringify(transaction.ops),
            actorId: input.actorId,
            clientTs: BigInt(transaction.ts),
            serverTs,
          },
        })
      }

      await tx.flow.update({
        where: { id: input.flowId },
        data: {
          graph: JSON.stringify(input.graph),
          nodeCount: input.graph.nodes.length,
          edgeCount: input.graph.edges.length,
          revision: seq,
        },
      })

      return { ok: true as const, revision: seq }
    })
  },

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
      }),
    ])

    const items: FlowOperationView[] = rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      txId: row.txId,
      kind: row.kind,
      label: row.label,
      ops: JSON.parse(row.ops) as unknown,
      actorId: row.actorId,
      // 库里是 BigInt，出口转成 number：epoch ms 远在 2^53 以内，JSON 也认
      clientTs: Number(row.clientTs),
      serverTs: Number(row.serverTs),
    }))

    return { items, total }
  },
}
