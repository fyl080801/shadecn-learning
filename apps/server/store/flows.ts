import type { FlowDetail, FlowMode, FlowStatus, FlowSummary } from '@shadecn/shared/canvas'
import { emptyGraph } from '@shadecn/shared/flow-graph'
import { db } from '../db.ts'
import { Flow, Project } from '../db/entities/index.ts'
import { containsIgnoreCase } from '../db/query.ts'
import { readGraph } from './flow-types.ts'
import { flowUserState } from './flow-user-state.ts'
import type { ProjectKind } from './projects.ts'

/**
 * 画布的数据访问层。
 *
 * 内容的事实源是 `Flow.ydoc`（Yjs 状态）；这里读的 `graph` 是服务端从它派生的
 * 只读投影，列表计数、缩略图走它，读是 O(1)。
 *
 * 接口形状（`FlowSummary` / `FlowDetail` / `FlowStatus` / `FlowMode`）在
 * `@shadecn/shared/canvas`，前端消费的是同一份；这里转出去，服务端各处照旧从本模块取。
 */

export type { FlowDetail, FlowMode, FlowStatus, FlowSummary }

export const FLOW_STATUSES: readonly FlowStatus[] = ['draft', 'published', 'archived']

export type FlowSort = 'updatedAt' | 'createdAt' | 'name'

/**
 * 这张画布走哪条同步通道（REQ-SOLO）。
 *
 * **派生自所属项目的 `kind`，不落库**：一张画布在个人空间里就是 solo，
 * 挪进团队项目就是 collab。存一份标记在 `Flow` 上，早晚会和归属对不上，
 * 而对不上的那一刻没人看得出是哪边错了。
 */
export function modeOfKind(kind: ProjectKind): FlowMode {
  return kind === 'personal' ? 'solo' : 'collab'
}

export interface ListFlowsOptions {
  page: number
  pageSize: number
  keyword?: string
  status?: FlowStatus
  sort: FlowSort
  order: 'asc' | 'desc'
}

/**
 * 拼 FlowSummary 要用的那一行：`project` 必须已经 populate 过 ——
 * mode 是从所属项目的 kind 派生的，所以每次查画布都顺带把项目取出来。
 * `graph` / `ydoc` 是 lazy 列（见实体定义），这里用不到也不会被取出来。
 */
type FlowRow = Omit<Flow, 'project'> & { project: Pick<Project, 'id' | 'kind'> }

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
    projectId: row.project.id,
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

export const flows = {
  /** 项目内的画布列表；响应里没有 graph（lazy 列，不 populate 就不取） */
  async listByProject(projectId: string, options: ListFlowsOptions) {
    const where = {
      project: projectId,
      deletedAt: null,
      ...(options.keyword ? containsIgnoreCase('name', options.keyword) : {}),
      ...(options.status ? { status: options.status } : {}),
    }

    const [rows, total] = await db().findAndCount(Flow, where, {
      populate: ['project'],
      orderBy: { [options.sort]: options.order } as Record<FlowSort, 'asc' | 'desc'>,
      offset: (options.page - 1) * options.pageSize,
      limit: options.pageSize,
    })

    return { items: rows.map(toSummary), total }
  },

  countByProject(projectId: string) {
    return db().count(Flow, { project: projectId, deletedAt: null })
  },

  async create(input: {
    projectId: string
    name: string
    description?: string | null
    createdById: string
  }): Promise<FlowDetail> {
    const graph = emptyGraph()
    const em = db()
    // 先取项目：summary 里的 mode 要从它的 kind 派生
    const project = await em.findOneOrFail(Project, input.projectId)
    const row = em.create(Flow, {
      project,
      name: input.name,
      description: input.description ?? null,
      thumbnail: null,
      createdById: input.createdById,
      graph: JSON.stringify(graph),
    })
    await em.flush()
    return { ...toSummary(row), graph, userState: {} }
  },

  /**
   * 只取归属信息，给鉴权用 —— 不读 graph。
   *
   * 连 `kind` 一起给：调用方除了「谁能进」还要知道「这是不是个人画布」
   * （路由要据此拒掉走错通道的写入）；个人画布再带上所有者 —— 协同握手只放所有者本人进房间
   * （REQ-AGENT §3.3.2，`auth/ws.ts`）。所有者认的是 `Project.personalOwner`，不是成员表：
   * 那一列有唯一约束、是个人空间身份的定义本身。
   */
  async locate(
    flowId: string,
  ): Promise<{ projectId: string; kind: ProjectKind; personalOwnerId: string | null } | null> {
    const row = await db().findOne(
      Flow,
      { id: flowId, deletedAt: null, project: { deletedAt: null } },
      { populate: ['project'] },
    )
    if (!row) return null
    const kind: ProjectKind = row.project.kind === 'personal' ? 'personal' : 'team'
    return {
      projectId: row.project.id,
      kind,
      // 外键引用不 populate 也带着 id
      personalOwnerId: kind === 'personal' ? (row.project.personalOwner?.id ?? null) : null,
    }
  },

  /** 详情永远是「谁在看」的详情：userState 那部分因人而异 */
  async get(flowId: string, userId: string): Promise<FlowDetail | null> {
    const row = await db().findOne(
      Flow,
      { id: flowId, deletedAt: null, project: { deletedAt: null } },
      { populate: ['project', 'graph'] },
    )
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
    // 直接发 SQL 的更新不触发 onUpdate，updatedAt 得自己写（Prisma 的 @updatedAt 是自动带上的）
    const em = db()
    await em.nativeUpdate(
      Flow,
      { id: flowId },
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tags !== undefined ? { tags: JSON.stringify(patch.tags) } : {}),
        updatedAt: new Date(),
      },
    )
    // 调用方（路由）在鉴权中间件里已经确认过这张画布存在；真不在了就是并发删除，抛出去
    return toSummary(await em.findOneOrFail(Flow, flowId, { populate: ['project'] }))
  },

  async softDelete(flowId: string) {
    await db().nativeUpdate(Flow, { id: flowId }, { deletedAt: new Date(), updatedAt: new Date() })
  },

  /**
   * 复制到同一项目下；新画布 revision 从 0 起。
   *
   * **ydoc 要一起复制**：它才是内容，graph 只是投影。
   * 直接拷二进制就行 —— Yjs 的状态是自包含的，换个文档 id 照样能加载。
   */
  async duplicate(flowId: string, createdById: string): Promise<FlowDetail | null> {
    const em = db()
    const source = await em.findOne(
      Flow,
      { id: flowId, deletedAt: null },
      { populate: ['project', 'graph', 'ydoc'] },
    )
    if (!source) return null

    const row = em.create(Flow, {
      project: source.project,
      name: `${source.name} 副本`,
      description: source.description,
      // 缩略图不随副本走：它描述的是那张画布，副本还没被打开渲染过
      thumbnail: null,
      status: source.status,
      tags: source.tags,
      graph: source.graph,
      ydoc: source.ydoc,
      nodeCount: source.nodeCount,
      edgeCount: source.edgeCount,
      createdById,
    })
    await em.flush()
    // 副本是新画布：谁都还没在它上面留下过视口
    return { ...toSummary(row), graph: readGraph(row.graph), userState: {} }
  },
}
