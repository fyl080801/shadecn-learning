import { APP_TASK_ACTIVE_STATUSES, type AppOutputView, type AppTaskProgress, type AppTaskStatus, type AppTaskView } from '@shadecn/shared/apps'
import { db, newId } from '@shadecn/server-kit/db'
import { users } from '@shadecn/server-kit/identity'
import type { AppsService, TaskHandle } from './contract.ts'
import { AppTask } from './entities.ts'

/**
 * 生成任务表的读写（docs/29 §3.10）。**每一次状态变化都是带条件的 `nativeUpdate`**（返回受影响行数），
 * 条件里带着「我以为它现在是什么样」—— 两个副本 / 取消和执行之间的竞态靠它收敛，不靠先读后写：
 *
 * - 接手（`claim`）：进行中 且 没有租约或租约已过期 → 写上自己；
 * - 执行副本的每一笔写（续租、开始、句柄、进度、收尾）都带 `leaseOwner = 我` 且仍是进行中 —— 被取消、被别人接手之后一笔也写不进去；
 * - 取消（`cancel`）：仍是进行中 → `canceled`，不看租约。
 *
 * `nativeUpdate` 不触发 `onUpdate`，`updatedAt` 每笔自己写（database.md）。
 */

export type AppTaskRow = AppTask

const ACTIVE = { $in: [...APP_TASK_ACTIVE_STATUSES] }

const parseJson = <T>(text: string | null): T | undefined => {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export const handleOf = (row: AppTaskRow): TaskHandle | undefined => parseJson<TaskHandle>(row.handle)
export const paramsOf = (row: AppTaskRow): Record<string, unknown> => parseJson<Record<string, unknown>>(row.params) ?? {}

export const appTasks = {
  async create(input: { flowId: string; nodeId: string; userId: string; appId: string; model: string | undefined; params: Record<string, unknown> }) {
    const em = db()
    const row = em.create(AppTask, {
      id: newId(),
      flowId: input.flowId,
      nodeId: input.nodeId,
      userId: input.userId,
      appId: input.appId,
      model: input.model ?? null,
      params: JSON.stringify(input.params),
      status: 'queued',
      // em.create 不会替没给的可空字段填 null（database.md）
      progress: null,
      handle: null,
      error: null,
      outputs: null,
      leaseOwner: null,
      leaseUntil: null,
      startedAt: null,
      finishedAt: null,
    })
    await em.flush()
    return row
  },

  get: (id: string) => db().findOne(AppTask, { id }),

  /** 这张画布进行中的任务，按创建先后 */
  listActive: (flowId: string) => db().find(AppTask, { flowId, status: ACTIVE }, { orderBy: { createdAt: 'asc' } }),

  /** 这个节点上进行中的那个（同一节点同时只许一个） */
  activeOnNode: (flowId: string, nodeId: string) => db().findOne(AppTask, { flowId, nodeId, status: ACTIVE }),

  /** 进行中、租约过期（或从没被接手）的任务：对账时接手 */
  reclaimable: (limit: number) =>
    db().find(
      AppTask,
      { status: ACTIVE, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] },
      { orderBy: { createdAt: 'asc' }, limit },
    ),

  /** 接手：原子地写上自己的租约。抢到返回 true */
  async claim(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = new Date()
    const count = await db().nativeUpdate(
      AppTask,
      { id, status: ACTIVE, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
      { leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
    )
    return count > 0
  },

  /** 续租。false = 租约没了（被取消、被别人接手、已结束）—— 执行方应当停下 */
  async renew(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = new Date()
    const count = await db().nativeUpdate(
      AppTask,
      { id, leaseOwner: owner, status: ACTIVE },
      { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now },
    )
    return count > 0
  },

  /** 进程退出：放掉租约，让别的副本（或重启后的自己）马上能接手 */
  release: (id: string, owner: string) =>
    db().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { leaseOwner: null, leaseUntil: null, updatedAt: new Date() }),

  /** 开始执行：`running`；`startedAt` 只在第一次写（续查不重置时限） */
  async start(row: AppTaskRow, owner: string): Promise<Date> {
    const startedAt = row.startedAt ?? new Date()
    await db().nativeUpdate(AppTask, { id: row.id, leaseOwner: owner, status: ACTIVE }, { status: 'running', startedAt, updatedAt: new Date() })
    return startedAt
  },

  saveHandle: (id: string, owner: string, handle: TaskHandle) =>
    db().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { handle: JSON.stringify(handle), updatedAt: new Date() }),

  saveProgress: (id: string, owner: string, progress: AppTaskProgress) =>
    db().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { progress: JSON.stringify(progress), updatedAt: new Date() }),

  /** 执行方收尾。false = 已经不归我了（期间被取消 / 被接手），不要再写回节点 */
  async finish(
    id: string,
    owner: string,
    result: { status: 'succeeded'; outputs: AppOutputView[] } | { status: 'failed'; error: string },
  ): Promise<boolean> {
    const now = new Date()
    const count = await db().nativeUpdate(
      AppTask,
      { id, leaseOwner: owner, status: ACTIVE },
      {
        status: result.status,
        ...(result.status === 'succeeded' ? { outputs: JSON.stringify(result.outputs) } : { error: result.error }),
        leaseUntil: null,
        finishedAt: now,
        updatedAt: now,
      },
    )
    return count > 0
  },

  /** 没有执行方可以收尾时（派发不出去）直接记失败 */
  fail: (id: string, error: string) =>
    db().nativeUpdate(AppTask, { id, status: ACTIVE }, { status: 'failed', error, finishedAt: new Date(), updatedAt: new Date() }),

  /** 取消：仍在进行中才改。返回改之前是不是进行中（false = 已经结束了，幂等） */
  async cancel(id: string): Promise<boolean> {
    const now = new Date()
    const count = await db().nativeUpdate(AppTask, { id, status: ACTIVE }, { status: 'canceled', finishedAt: now, updatedAt: now })
    return count > 0
  },
}

/** 任务行 → 线上形状（发起人的名字 / 头像一次查齐；应用标题取应用表，删掉了就用 id） */
export async function taskViews(rows: readonly AppTaskRow[], service: Pick<AppsService, 'get'>): Promise<AppTaskView[]> {
  const briefs = await users.briefs(rows.map((row) => row.userId))
  return rows.map((row) => {
    const brief = briefs.get(row.userId)
    const progress = parseJson<AppTaskProgress>(row.progress)
    return {
      id: row.id,
      flowId: row.flowId,
      nodeId: row.nodeId,
      appId: row.appId,
      appTitle: service.get(row.appId)?.title ?? row.appId,
      ...(row.model ? { model: row.model } : {}),
      status: row.status as AppTaskStatus,
      ...(progress ? { progress } : {}),
      ...(row.error ? { error: row.error } : {}),
      owner: { id: row.userId, name: brief?.name ?? '', avatarUrl: brief?.avatarUrl ?? null },
      createdAt: row.createdAt.getTime(),
      ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    }
  })
}
