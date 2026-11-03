import { type AppOutputView, APP_TASK_ACTIVE_STATUSES, type AppTaskProgress, type AppTaskStatus, type AppTaskView } from '@learning/contracts/apps'
import { DataAccess, newId, User } from '@learning/data-access'
import { displayNameOf } from '@learning/session'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'
import type { TaskHandle } from './contract.js'
import { AppTask } from './entities.js'

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

const activeKeyOf = (flowId: string, nodeId: string) => `${flowId}/${nodeId}`

/**
 * 生成任务表的读写（docs/29 §3.10）。**每一次状态变化都是带条件的 `nativeUpdate`**（返回受影响行数），
 * 条件里带着「我以为它现在是什么样」—— 两个进程 / 取消和执行之间的竞态靠它收敛，不靠先读后写：
 *
 * - 接手（{@link claim}）：进行中 且 没有租约或租约已过期 → 写上自己；
 * - 执行方的每一笔写（续租、开始、句柄、进度、收尾）都带 `leaseOwner = 我` 且仍是进行中 —— 被取消、被别人接手之后一笔也写不进去；
 * - 取消（{@link cancel}）：仍是进行中 → `canceled`，不看租约。
 *
 * 走到终态的两条路（{@link finish}、{@link cancel}）都要清 `activeKey`，否则这个节点再也提交不了。
 * `nativeUpdate` 不触发 `onUpdate`，`updatedAt` 每笔自己写（database.md）。
 */
@Injectable()
export class AppTasks {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /** 建任务行。同一个节点已有进行中的任务回 null：靠 `activeKey` 的唯一约束判输赢，不先查后插 */
  async create(input: { flowId: string; nodeId: string; userId: string; appId: string; model: string | undefined; params: Record<string, unknown> }): Promise<AppTaskRow | null> {
    const em = this.dataAccess.em()
    const row = em.create(AppTask, {
      id: newId(),
      flowId: input.flowId,
      nodeId: input.nodeId,
      userId: input.userId,
      appId: input.appId,
      model: input.model ?? null,
      params: JSON.stringify(input.params),
      status: 'queued',
      activeKey: activeKeyOf(input.flowId, input.nodeId),
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
    try {
      await em.flush()
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) return null
      throw err
    }
    return row
  }

  get(id: string): Promise<AppTaskRow | null> {
    return this.dataAccess.em().findOne(AppTask, { id })
  }

  /** 这张画布进行中的任务，按创建先后 */
  listActive(flowId: string): Promise<AppTaskRow[]> {
    return this.dataAccess.em().find(AppTask, { flowId, status: ACTIVE }, { orderBy: { createdAt: 'asc' } })
  }

  /** 进行中、租约过期（或从没被接手）的任务：对账时接手 */
  reclaimable(limit: number): Promise<AppTaskRow[]> {
    return this.dataAccess.em().find(AppTask, { status: ACTIVE, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] }, { orderBy: { createdAt: 'asc' }, limit })
  }

  /** 接手：原子地写上自己的租约。抢到返回 true */
  async claim(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = new Date()
    const count = await this.dataAccess
      .em()
      .nativeUpdate(AppTask, { id, status: ACTIVE, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    return count > 0
  }

  /** 续租。false = 租约没了（被取消、被别人接手、已结束），执行方应当停下 */
  async renew(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = new Date()
    const count = await this.dataAccess.em().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    return count > 0
  }

  /** 进程退出：放掉租约，让别的进程（或重启后的自己）马上能接手 */
  release(id: string, owner: string): Promise<number> {
    return this.dataAccess.em().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
  }

  /** 开始执行：`running`；`startedAt` 只在第一次写（续查不重置时限） */
  async start(row: AppTaskRow, owner: string): Promise<Date> {
    const startedAt = row.startedAt ?? new Date()
    await this.dataAccess.em().nativeUpdate(AppTask, { id: row.id, leaseOwner: owner, status: ACTIVE }, { status: 'running', startedAt, updatedAt: new Date() })
    return startedAt
  }

  saveHandle(id: string, owner: string, handle: TaskHandle): Promise<number> {
    return this.dataAccess.em().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { handle: JSON.stringify(handle), updatedAt: new Date() })
  }

  saveProgress(id: string, owner: string, progress: AppTaskProgress): Promise<number> {
    return this.dataAccess.em().nativeUpdate(AppTask, { id, leaseOwner: owner, status: ACTIVE }, { progress: JSON.stringify(progress), updatedAt: new Date() })
  }

  /** 执行方收尾。false = 已经不归我了（期间被取消 / 被接手），不要再写回节点 */
  async finish(id: string, owner: string, result: { status: 'succeeded'; outputs: AppOutputView[] } | { status: 'failed'; error: string }): Promise<boolean> {
    const now = new Date()
    const count = await this.dataAccess.em().nativeUpdate(
      AppTask,
      { id, leaseOwner: owner, status: ACTIVE },
      {
        status: result.status,
        ...(result.status === 'succeeded' ? { outputs: JSON.stringify(result.outputs) } : { error: result.error }),
        activeKey: null,
        leaseUntil: null,
        finishedAt: now,
        updatedAt: now,
      },
    )
    return count > 0
  }

  /** 取消：仍在进行中才改。返回改之前是不是进行中（false = 已经结束了，幂等） */
  async cancel(id: string): Promise<boolean> {
    const now = new Date()
    const count = await this.dataAccess.em().nativeUpdate(AppTask, { id, status: ACTIVE }, { status: 'canceled', activeKey: null, finishedAt: now, updatedAt: now })
    return count > 0
  }

  /** 任务行 → 线上形状（发起人的名字 / 头像一次查齐；应用标题取应用表，删掉了就用 id） */
  async views(rows: readonly AppTaskRow[], titleOf: (appId: string) => string | undefined): Promise<AppTaskView[]> {
    const ids = [...new Set(rows.map((row) => row.userId))]
    const users = ids.length > 0 ? await this.dataAccess.em().find(User, { id: { $in: ids } }, { fields: ['id', 'name', 'username', 'email', 'avatarUrl'] }) : []
    const byId = new Map(users.map((user) => [user.id, user]))
    return rows.map((row) => {
      const user = byId.get(row.userId)
      const progress = parseJson<AppTaskProgress>(row.progress)
      return {
        id: row.id,
        flowId: row.flowId,
        nodeId: row.nodeId,
        appId: row.appId,
        appTitle: titleOf(row.appId) ?? row.appId,
        ...(row.model ? { model: row.model } : {}),
        status: row.status as AppTaskStatus,
        ...(progress ? { progress } : {}),
        ...(row.error ? { error: row.error } : {}),
        owner: { id: row.userId, name: displayNameOf(user ?? { name: null, username: null, email: null }), avatarUrl: user?.avatarUrl ?? null },
        createdAt: row.createdAt.getTime(),
        ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
        ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
      }
    })
  }
}
