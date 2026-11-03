import type { FlowTarget } from '@learning/canvas'

/**
 * 一个生成任务的执行身份（docs/29 §3.10）—— 和画布 agent 的 Grant（docs/22 §5）同一个口径：
 * **任务凭发起人运行**，接手时按发起人签一份，之后每次用画布之前判一次。
 *
 * ## 有效权限 = 发起人此刻的权限 ∩ 签发时的快照
 *
 * 一次判权（`authorize`）：
 * 1. 已判死 → 直接拒；
 * 2. 这项能力不在签发的范围里 → denied；
 * 3. 发起人此刻还能进这张画布（`FlowMemberGuard` 同口径：画布和项目没删、是项目成员），
 *    **且画布仍在签发时那个项目里、个人画布仍是同一个所有者** → 否则 revoked。
 *
 * 第 3 项的结论缓存 {@link VERDICT_TTL_MS}（缓存 Promise，并发判权共用一次查询）；查不了库 → denied（只拒这一次，不缓存）。
 *
 * ## 失效即停
 *
 * revoked：经签发时给的 `stop` **当场叫停这个任务**（执行方撤上游、任务记失败），之后每次判权都直接拒。
 * 三条路发现失效：每次判权（写节点、读参考图、存产物之前）、执行方每次续租时的判权、权限变化事件（{@link TaskAuthorities.reconcileLive}）。
 *
 * ## 与登录态无关
 *
 * 不看会话：发起人退出登录、会话过期不影响已经在跑的任务（同 docs/22 §6）。
 * 不落 Grant 表：任务行（`app_task`）本身就记着发起人、画布、起止时间和结果，是这次执行的审计。
 */

/** 判权结论的缓存时长（权限变化事件触发的对账不用缓存） */
export const VERDICT_TTL_MS = 3000

/** 任务能用的能力：读参考图 / 读节点、写节点 / 存产物 */
export const TASK_CAPABILITIES = ['flow:read', 'flow:write'] as const
export type TaskCapability = (typeof TASK_CAPABILITIES)[number]

/** 接手时发起人就进不了这张画布（和 404 同口径，不区分「画布没了」和「不是成员」） */
export const TASK_ACCESS_LOST = '发起人已不能访问这张画布，任务没有执行'
/** 执行中失权（被移出项目 / 画布或项目被删 / 画布挪走） */
export const TASK_ACCESS_REVOKED = '发起人已失去这张画布的访问权限，生成已停止'
export const TASK_AUTHORIZE_UNAVAILABLE = '暂时无法确认发起人的权限，这次操作没有执行'

export class TaskAuthorityError extends Error {
  readonly kind: 'revoked' | 'denied'

  constructor(kind: 'revoked' | 'denied', message: string) {
    super(message)
    this.name = 'TaskAuthorityError'
    this.kind = kind
  }
}

export const isTaskRevoked = (err: unknown): err is TaskAuthorityError => err instanceof TaskAuthorityError && err.kind === 'revoked'

export interface TaskAuthority {
  readonly taskId: string
  readonly userId: string
  readonly scopes: ReadonlySet<TaskCapability>
  /** 用能力之前调：过了返回，不过抛 {@link TaskAuthorityError}（revoked 时已经叫停了任务） */
  authorize(capability: TaskCapability): Promise<void>
  /** 任务收尾：不再对账 */
  release(): void
}

export interface TaskAuthorityRequest {
  taskId: string
  flowId: string
  userId: string
  /** 失效时叫停这个任务（对账发现的也走它） */
  stop(reason: string): void
}

type Verdict = { ok: true } | { ok: false; reason: string }

interface Entry {
  request: TaskAuthorityRequest
  snapshot: FlowTarget
  dead: string | null
  verdict: { at: number; promise: Promise<Verdict> } | null
}

export interface TaskAuthoritiesOptions {
  /** `FlowsService` / `ProjectsService` 的那两个方法 */
  canvas: {
    locate(flowId: string): Promise<FlowTarget | null>
    roleOf(projectId: string, userId: string): Promise<unknown>
  }
  verdictTtlMs?: number
  now?: () => number
}

export class TaskAuthorities {
  private readonly nowOf: () => number
  private readonly verdictTtlMs: number
  private readonly liveEntries = new Map<string, Entry>()

  constructor(private readonly options: TaskAuthoritiesOptions) {
    this.nowOf = options.now ?? Date.now
    this.verdictTtlMs = options.verdictTtlMs ?? VERDICT_TTL_MS
  }

  /** `FlowMemberGuard` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者） */
  private async currentAccess(flowId: string, userId: string): Promise<FlowTarget | null> {
    const target = await this.options.canvas.locate(flowId)
    if (!target) return null
    return (await this.options.canvas.roleOf(target.projectId, userId)) ? target : null
  }

  private async evaluate(entry: Entry, access: Promise<FlowTarget | null>): Promise<Verdict> {
    const current = await access
    const same = current !== null && current.projectId === entry.snapshot.projectId && current.personalOwnerId === entry.snapshot.personalOwnerId
    return same ? { ok: true } : { ok: false, reason: TASK_ACCESS_REVOKED }
  }

  private fail(entry: Entry, reason: string): void {
    if (entry.dead) return
    entry.dead = reason
    entry.verdict = null
    const { taskId, flowId, userId } = entry.request
    console.warn(`[apps] 任务 ${taskId} flow=${flowId} user=${userId} 授权撤销，叫停：${reason}`)
    try {
      entry.request.stop(reason)
    } catch (err) {
      console.error(`[apps] 任务 ${taskId} 叫停失败`, err)
    }
  }

  private async check(entry: Entry, fresh: boolean, access?: Promise<FlowTarget | null>): Promise<void> {
    if (entry.dead) throw new TaskAuthorityError('revoked', entry.dead)
    const at = this.nowOf()
    let cached = entry.verdict
    if (fresh || !cached || at - cached.at >= this.verdictTtlMs) {
      const promise = this.evaluate(entry, access ?? this.currentAccess(entry.request.flowId, entry.request.userId))
      cached = { at, promise }
      entry.verdict = cached
      // 查库失败不缓存：下一次判权重查
      promise.catch(() => {
        if (entry.verdict?.promise === promise) entry.verdict = null
      })
    }
    let verdict: Verdict
    try {
      verdict = await cached.promise
    } catch (err) {
      console.warn(`[apps] 任务 ${entry.request.taskId} 判权查询失败，这次拒绝`, err)
      throw new TaskAuthorityError('denied', TASK_AUTHORIZE_UNAVAILABLE)
    }
    if (!verdict.ok) {
      this.fail(entry, verdict.reason)
      throw new TaskAuthorityError('revoked', verdict.reason)
    }
  }

  /** 按发起人签一份；发起人此刻就进不了画布 → 抛 revoked（{@link TASK_ACCESS_LOST}） */
  async issue(request: TaskAuthorityRequest): Promise<TaskAuthority> {
    const snapshot = await this.currentAccess(request.flowId, request.userId)
    if (!snapshot) throw new TaskAuthorityError('revoked', TASK_ACCESS_LOST)
    // 权限模型只有成员 / 管理员，都能编辑：是成员 = 两项都有
    const scopes = new Set<TaskCapability>(TASK_CAPABILITIES)
    /*
     * 不预置「刚判过」的缓存：签发查权限和登记进 live 之间如果恰好来了一次撤销事件，
     * 那次对账看不到这一份 —— 第一次判权重查，窗口就合上了。
     */
    const entry: Entry = { request, snapshot, dead: null, verdict: null }
    this.liveEntries.set(request.taskId, entry)
    return {
      taskId: request.taskId,
      userId: request.userId,
      scopes,
      authorize: async (capability) => {
        if (entry.dead) throw new TaskAuthorityError('revoked', entry.dead)
        if (!scopes.has(capability)) throw new TaskAuthorityError('denied', `这个任务没有被授予「${capability}」`)
        await this.check(entry, false)
      },
      release: () => {
        if (this.liveEntries.get(request.taskId) === entry) this.liveEntries.delete(request.taskId)
      },
    }
  }

  /** 重判本进程里每一份在用的（不用缓存），失效的叫停 —— 权限变化事件触发 */
  async reconcileLive(): Promise<void> {
    const entries = [...this.liveEntries.values()].filter((entry) => !entry.dead)
    if (entries.length === 0) return
    // 同一个「画布 + 发起人」只查一次权限
    const accessByKey = new Map<string, Promise<FlowTarget | null>>()
    await Promise.all(
      entries.map(async (entry) => {
        const { flowId, userId } = entry.request
        const key = `${flowId}\n${userId}`
        let access = accessByKey.get(key)
        if (!access) {
          access = this.currentAccess(flowId, userId)
          accessByKey.set(key, access)
        }
        try {
          await this.check(entry, true, access)
        } catch (err) {
          // 失效的已经在 check 里叫停了；查不了库的这次跳过，下一次判权 / 续租再看
          if (!isTaskRevoked(err)) console.warn(`[apps] 任务 ${entry.request.taskId} 对账跳过`, err)
        }
      }),
    )
  }

  /** 本进程在用的（测试、排查用） */
  live(): { taskId: string; flowId: string; userId: string }[] {
    return [...this.liveEntries.values()].map(({ request: { taskId, flowId, userId } }) => ({ taskId, flowId, userId }))
  }
}
