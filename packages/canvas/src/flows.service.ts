import type { FlowDetail, FlowMode, FlowStatus, FlowSummary, ProjectKind } from '@learning/contracts/canvas'
import { emptyGraph, type FlowUserState as FlowUserStateValue } from '@learning/contracts/flow-graph'
import { containsIgnoreCase, DataAccess, newId } from '@learning/data-access'
import { Inject, Injectable } from '@nestjs/common'
import { Flow, FlowUserState, Project } from './entities.js'
import { FLOW_USER_STATE_PARSERS, readGraph } from './flow-types.js'

export const FLOW_STATUSES: readonly FlowStatus[] = ['draft', 'published', 'archived']

export type FlowSort = 'updatedAt' | 'createdAt' | 'name'

export interface ListFlowsOptions {
  page: number
  pageSize: number
  keyword?: string
  status?: FlowStatus
  sort: FlowSort
  order: 'asc' | 'desc'
}

/** 一张画布的归属（画布和它的项目都没删时才有） */
export interface FlowTarget {
  projectId: string
  kind: ProjectKind
  /** 个人空间的所有者；团队项目 = null */
  personalOwnerId: string | null
}

/** 这张画布走哪种模式：**派生自所属项目的 `kind`，不落库**（docs/16 §3.2） */
export function modeOfKind(kind: ProjectKind): FlowMode {
  return kind === 'personal' ? 'solo' : 'collab'
}

const toStatus = (value: string): FlowStatus => (FLOW_STATUSES.includes(value as FlowStatus) ? (value as FlowStatus) : 'draft')

function readTags(serialized: string): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

/** 拼 FlowSummary 要用的那一行：`project` 必须已经 populate 过（mode 从它的 kind 派生）。`graph` / `ydoc` 是 lazy 列，这里用不到也不会被取出来 */
type FlowRow = Omit<Flow, 'project'> & { project: Pick<Project, 'id' | 'kind'> }

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

/**
 * 画布元数据的读写和「每人自己一份」的画布状态。内容的事实源是 `Flow.ydoc`，存取在 `FlowDocStore`；
 * 这里读的 `graph` 是服务端从它派生的只读投影。接口形状在 `@learning/contracts/canvas`。
 */
@Injectable()
export class FlowsService {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /** 项目内的画布列表；响应里没有 graph（lazy 列，不 populate 就不取） */
  async listByProject(projectId: string, options: ListFlowsOptions) {
    const where = {
      project: projectId,
      deletedAt: null,
      ...(options.keyword ? containsIgnoreCase('name', options.keyword) : {}),
      ...(options.status ? { status: options.status } : {}),
    }
    const [rows, total] = await this.dataAccess.em().findAndCount(Flow, where, {
      populate: ['project'],
      orderBy: { [options.sort]: options.order } as Record<FlowSort, 'asc' | 'desc'>,
      offset: (options.page - 1) * options.pageSize,
      limit: options.pageSize,
    })
    return { items: rows.map(toSummary), total }
  }

  countByProject(projectId: string): Promise<number> {
    return this.dataAccess.em().count(Flow, { project: projectId, deletedAt: null })
  }

  async create(input: { projectId: string; name: string; description?: string | null; createdById: string }): Promise<FlowDetail> {
    const graph = emptyGraph()
    const em = this.dataAccess.em()
    // 先取项目：summary 里的 mode 要从它的 kind 派生
    const project = await em.findOneOrFail(Project, input.projectId)
    const row = em.create(Flow, {
      project,
      name: input.name,
      description: input.description ?? null,
      thumbnail: null,
      createdById: input.createdById,
      graph: JSON.stringify(graph),
      deletedAt: null,
    })
    await em.flush()
    return { ...toSummary(row), graph, userState: {} }
  }

  /**
   * 只取归属信息，给判权用，不读 graph。
   * 个人画布带上所有者：协同握手只放所有者本人进房间。所有者认的是 `Project.personalOwner`，不是成员表：那一列有唯一约束、是个人空间身份的定义本身。
   */
  async locate(flowId: string): Promise<FlowTarget | null> {
    const row = await this.dataAccess
      .em()
      .findOne(Flow, { id: flowId, deletedAt: null, project: { deletedAt: null } }, { populate: ['project'] })
    if (!row) return null
    const kind: ProjectKind = row.project.kind === 'personal' ? 'personal' : 'team'
    return {
      projectId: row.project.id,
      kind,
      // 外键引用不 populate 也带着 id
      personalOwnerId: kind === 'personal' ? (row.project.personalOwner?.id ?? null) : null,
    }
  }

  /** 详情永远是「谁在看」的详情：userState 那部分因人而异 */
  async get(flowId: string, userId: string): Promise<FlowDetail | null> {
    const row = await this.dataAccess
      .em()
      .findOne(Flow, { id: flowId, deletedAt: null, project: { deletedAt: null } }, { populate: ['project', 'graph'] })
    if (!row) return null
    return { ...toSummary(row), graph: readGraph(row.graph), userState: await this.getUserState(flowId, userId) }
  }

  async update(flowId: string, patch: { name?: string; description?: string | null; status?: FlowStatus; tags?: string[] }): Promise<FlowSummary> {
    const em = this.dataAccess.em()
    // 直接发 SQL 的更新不触发 onUpdate，updatedAt 得自己写
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
    // 调用方（路由）在守卫里已经确认过这张画布存在；真不在了就是并发删除，抛出去
    return toSummary(await em.findOneOrFail(Flow, flowId, { populate: ['project'] }))
  }

  async softDelete(flowId: string): Promise<void> {
    const now = new Date()
    await this.dataAccess.em().nativeUpdate(Flow, { id: flowId }, { deletedAt: now, updatedAt: now })
  }

  /**
   * 复制到同一项目下；新画布 revision 从 0 起。
   * **ydoc 要一起复制**：它才是内容，graph 只是投影。直接拷二进制就行 —— Yjs 的状态是自包含的，换个文档 id 照样能加载。
   */
  async duplicate(flowId: string, createdById: string): Promise<FlowDetail | null> {
    const em = this.dataAccess.em()
    const source = await em.findOne(Flow, { id: flowId, deletedAt: null }, { populate: ['project', 'graph', 'ydoc'] })
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
      deletedAt: null,
    })
    await em.flush()
    // 副本是新画布：谁都还没在它上面留下过视口
    return { ...toSummary(row), graph: readGraph(row.graph), userState: {} }
  }

  /** 取某人在某张画布上的全部分区；没存过的 key 不出现在结果里 */
  async getUserState(flowId: string, userId: string): Promise<FlowUserStateValue> {
    const rows = await this.dataAccess.em().find(FlowUserState, { flow: flowId, user: userId }, { fields: ['key', 'value'] })
    const state: Record<string, unknown> = {}
    for (const row of rows) {
      // 现在不认识的 key（已经下线的分区）直接跳过，不回给前端
      if (!Object.hasOwn(FLOW_USER_STATE_PARSERS, row.key)) continue
      try {
        state[row.key] = JSON.parse(row.value) as unknown
      } catch {
        // 坏数据当没存过：这类状态丢了只是回到默认视图，不值得报错
      }
    }
    return state as FlowUserStateValue
  }

  /** PATCH 语义：只覆盖 patch 里出现的分区，其余的原样留着。入参必须已经过 parseUserStatePatch */
  async patchUserState(flowId: string, userId: string, patch: FlowUserStateValue): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      // upsert 直接发 SQL，id / updatedAt 的 onCreate、onUpdate 都不会触发，得自己给。撞上 (flow, user, key) 时只改 value 和 updatedAt
      await this.dataAccess.em().upsert(
        FlowUserState,
        { id: newId(), flow: flowId, user: userId, key, value: JSON.stringify(value), updatedAt: new Date() },
        { onConflictFields: ['flow', 'user', 'key'], onConflictMergeFields: ['value', 'updatedAt'] },
      )
    }
  }
}
