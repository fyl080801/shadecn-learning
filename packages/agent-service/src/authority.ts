import { AccessRevocation, type FlowTarget, FlowsService, ProjectsService } from '@learning/canvas'
import {
  RunAuthorityError,
  stopsRun,
  type AgentCapability,
  type GrantRequest,
  type RunAuthority,
  type RunAuthorityProvider,
  type RunStopKind,
} from '@learning/agent-core/authority'
import type { AgentRunStatus } from '@learning/agent-core/store'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { AgentGrants } from './stores.js'

/**
 * 一轮 agent 的执行身份：签发 Grant、每次判权、对账（docs/22 §3、§5）。编排层只认 `@learning/agent-core/authority` 的接口。
 *
 * **有效权限 = 授予范围 ∩ 发起人此刻的权限 ∩ 服务端配置**。一次判权依次看：
 * 1. 已判死 → 直接拒；2. 过了 `expiresAt` → expired；3. 能力不在授予范围 → denied（只拒这一次）；
 * 4. 库里这一行 `revokedAt` 已写 → revoked；
 * 5. 发起人此刻还能进这张画布（`FlowMemberGuard` 同口径），**且画布仍在签发时那个项目里、个人画布仍是同一个所有者** → 否则 revoked。
 * 4、5 的结论缓存 {@link VERDICT_TTL_MS}（缓存 Promise，并发判权共用一次查询）；查不了库 → denied，不缓存，不因为一次瞬时故障停掉整轮。
 *
 * **失效即 stop**：先经 `GrantRequest.stop` 当场叫停这一轮，再把库里这一行标成已撤销。
 *
 * **对账**逐份重判（不用缓存）：`AccessRevocation.onRevoked`（本进程的路由 await 它，所以 204 时失权的那一轮已经被叫停；别的进程的经协同的世代号轮询）和定时全量对账（默认 10 分钟，先把库里过期未撤销的标掉，含进程崩溃留下的孤儿）。
 *
 * **不看会话**：退出登录、会话过期不会让任何一轮停下（docs/22 §6）。
 */

export const AGENT_AUTHORITY_OPTIONS = Symbol('AGENT_AUTHORITY_OPTIONS')

/** 判权结论的缓存时长：权限变化事件会清掉它，这个时长只兜底「没发事件的改动」 */
export const VERDICT_TTL_MS = 3000
/** 定时全量对账的间隔（docs/22 §5） */
export const RECONCILE_INTERVAL_MS = 10 * 60_000

/** 发起时就进不了这张画布：和 404 同一个口径，不区分「画布没了」和「你不是成员」 */
export const ACCESS_LOST = '这张画布已不存在，或你已无权访问它'
/** 运行中失权（被移出项目 / 画布或项目被删 / 画布挪走）时这一轮的收尾原因 */
export const ACCESS_REVOKED = '发起人已失去这张画布的访问权限，agent 已停止'
export const GRANT_EXPIRED = '这一轮的授权已到期，agent 已停止'
/** 判权本身做不了（查库失败）：只拒这一次 */
export const AUTHORIZE_UNAVAILABLE = '暂时无法确认这一轮的授权，这次操作没有执行'

const STATUS_LABEL: Record<Exclude<AgentRunStatus, 'running'>, string> = {
  success: '完成',
  cancelled: '已中止',
  error: '出错',
  expired: '到期',
}

type Verdict = { ok: true } | { ok: false; kind: RunStopKind; reason: string }

interface LiveGrant {
  grantId: string
  request: GrantRequest
  scopes: ReadonlySet<AgentCapability>
  /** 签发时的快照：判权时画布必须还在这个项目里、个人画布还是这个所有者 */
  snapshot: FlowTarget
  /** UTC epoch 毫秒 */
  expiresAt: number
  dead: { kind: RunStopKind; reason: string } | null
  verdict: { at: number; promise: Promise<Verdict> } | null
}

export interface LiveGrantView {
  grantId: string
  runId: string
  flowId: string
  userId: string
}

export interface AgentAuthorityOptions {
  /** 绝对过期时间 = 签发时刻 + 这一轮的总时长上限 + 它 */
  expiryMarginMs: number
  /** 服务端配置允许的能力（docs/22 §5 的 entitlements） */
  entitled: (capability: AgentCapability) => boolean
  verdictTtlMs?: number
  reconcileIntervalMs?: number
  now?: () => number
}

function resourceOf(capability: AgentCapability, request: GrantRequest): string {
  if (capability === 'llm:invoke') return `model:${request.model ?? 'unknown'}`
  if (capability === 'sandbox:exec') return `run:${request.runId}`
  return `flow:${request.flowId}`
}

@Injectable()
export class AgentAuthorities implements RunAuthorityProvider, OnModuleInit, OnModuleDestroy {
  private readonly grantsLive = new Map<string, LiveGrant>()
  private readonly now: () => number
  private readonly verdictTtlMs: number
  private stopRevocation: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    @Inject(AgentGrants) private readonly grants: AgentGrants,
    @Inject(FlowsService) private readonly flows: FlowsService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(AccessRevocation) private readonly revocation: AccessRevocation,
    @Inject(AGENT_AUTHORITY_OPTIONS) private readonly options: AgentAuthorityOptions,
  ) {
    this.now = options.now ?? Date.now
    this.verdictTtlMs = options.verdictTtlMs ?? VERDICT_TTL_MS
  }

  onModuleInit(): void {
    this.stopRevocation = this.revocation.onRevoked(() => this.reconcileLive())
    this.timer = setInterval(() => {
      void this.reconcileAll().catch((err: unknown) => console.error('[agent] 定时对账失败', err))
    }, this.options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.stopRevocation?.()
    this.stopRevocation = undefined
  }

  /** 和 `FlowMemberGuard` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者）；否则 null */
  private async flowAccess(flowId: string, userId: string): Promise<FlowTarget | null> {
    const target = await this.flows.locate(flowId)
    if (!target) return null
    return (await this.projects.roleOf(target.projectId, userId)) ? target : null
  }

  private async evaluate(entry: LiveGrant, access: Promise<FlowTarget | null>): Promise<Verdict> {
    const [state, current] = await Promise.all([this.grants.state(entry.grantId), access])
    if (!state) return { ok: false, kind: 'revoked', reason: ACCESS_REVOKED }
    if (state.expiresAt.getTime() <= this.now()) return { ok: false, kind: 'expired', reason: GRANT_EXPIRED }
    if (state.revokedAt) return { ok: false, kind: 'revoked', reason: state.revokeReason ?? ACCESS_REVOKED }
    const same = current !== null && current.projectId === entry.snapshot.projectId && current.personalOwnerId === entry.snapshot.personalOwnerId
    return same ? { ok: true } : { ok: false, kind: 'revoked', reason: ACCESS_REVOKED }
  }

  /** 判死：先叫停这一轮（立即），再把库里这一行标成已撤销 */
  private async fail(entry: LiveGrant, kind: RunStopKind, reason: string): Promise<void> {
    if (entry.dead) return
    entry.dead = { kind, reason }
    entry.verdict = null
    const { runId, flowId, userId } = entry.request
    console.warn(`[agent] run=${runId} flow=${flowId} user=${userId} grant=${entry.grantId} ${kind === 'expired' ? '授权到期' : '授权撤销'}，叫停：${reason}`)
    try {
      entry.request.stop(kind, reason)
    } catch (err) {
      console.error(`[agent] run=${runId} 叫停失败`, err)
    }
    try {
      await this.grants.revoke(entry.grantId, reason)
    } catch (err) {
      // 本进程里它已经判死了；库里没标上只影响审计，下一次定时对账会按到期补标
      console.error(`[agent] grant=${entry.grantId} 撤销没能写进库`, err)
    }
  }

  /** 判一次：过了返回，不过抛（失效的顺手判死、叫停） */
  private async check(entry: LiveGrant, fresh: boolean, access?: Promise<FlowTarget | null>): Promise<void> {
    if (entry.dead) throw new RunAuthorityError(entry.dead.kind, entry.dead.reason)
    if (this.now() >= entry.expiresAt) {
      await this.fail(entry, 'expired', GRANT_EXPIRED)
      throw new RunAuthorityError('expired', GRANT_EXPIRED)
    }
    const at = this.now()
    let cached = entry.verdict
    if (fresh || !cached || at - cached.at >= this.verdictTtlMs) {
      const promise = this.evaluate(entry, access ?? this.flowAccess(entry.request.flowId, entry.request.userId))
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
      console.warn(`[agent] grant=${entry.grantId} 判权查询失败，这次拒绝`, err)
      throw new RunAuthorityError('denied', AUTHORIZE_UNAVAILABLE)
    }
    if (!verdict.ok) {
      await this.fail(entry, verdict.kind, verdict.reason)
      throw new RunAuthorityError(verdict.kind, verdict.reason)
    }
  }

  async issue(request: GrantRequest): Promise<RunAuthority> {
    const access = await this.flowAccess(request.flowId, request.userId)
    if (!access) throw new RunAuthorityError('revoked', ACCESS_LOST)

    // 只缩不扩：请求的 ∩ 服务端配置；发起人此刻是成员 = 画布的三项都有（权限模型只有成员 / 管理员，都能编辑）
    const scopes = new Set(request.capabilities.filter((capability) => this.options.entitled(capability)))
    const expiresAt = this.now() + request.timeoutMs + this.options.expiryMarginMs
    const grantId = await this.grants.create({
      userId: request.userId,
      runId: request.runId,
      flowId: request.flowId,
      projectId: access.projectId,
      projectKind: access.kind,
      personalOwnerId: access.personalOwnerId,
      expiresAt: new Date(expiresAt),
      scopes: [...scopes].map((scope) => ({ scope, resource: resourceOf(scope, request), onRevoke: 'stop', required: true })),
    })
    // 不预置「刚判过」的缓存：签发查权限和登记进 live 之间如果恰好来了一次撤销事件，那次对账看不到这一份，第一次判权重查，窗口就合上了
    const entry: LiveGrant = { grantId, request, scopes, snapshot: access, expiresAt, dead: null, verdict: null }
    this.grantsLive.set(grantId, entry)
    console.info(`[agent] run=${request.runId} flow=${request.flowId} user=${request.userId} grant=${grantId} 已签发（${[...scopes].join(' ')}）`)

    return {
      grantId,
      scopes,
      authorize: async (capability) => {
        if (entry.dead) throw new RunAuthorityError(entry.dead.kind, entry.dead.reason)
        if (!scopes.has(capability)) throw new RunAuthorityError('denied', `这一轮没有被授予「${capability}」，这次操作没有执行`)
        await this.check(entry, false)
      },
      release: async (end) => {
        this.grantsLive.delete(grantId)
        try {
          // 已因失权 / 到期撤销的，保留那个原因（revoke 只写 revokedAt 为空的行）
          await this.grants.revoke(grantId, `本轮已结束（${STATUS_LABEL[end.status]}）`)
        } catch (err) {
          console.error(`[agent] grant=${grantId} 收尾没能关掉，等它自然到期`, err)
        }
      },
    }
  }

  /** 重判本进程里每一份在跑的 Grant（不用缓存），失效的叫停。同一个「画布 + 发起人」只查一次权限 */
  async reconcileLive(): Promise<void> {
    const entries = [...this.grantsLive.values()].filter((entry) => !entry.dead)
    if (entries.length === 0) return
    const accessByKey = new Map<string, Promise<FlowTarget | null>>()
    await Promise.all(
      entries.map(async (entry) => {
        const { flowId, userId } = entry.request
        const key = `${flowId}\n${userId}`
        let access = accessByKey.get(key)
        if (!access) {
          access = this.flowAccess(flowId, userId)
          accessByKey.set(key, access)
        }
        try {
          await this.check(entry, true, access)
        } catch (err) {
          // 失效的已经在 check 里叫停了；查不了库的这次跳过，下一次判权 / 对账再看
          if (!stopsRun(err)) console.warn(`[agent] grant=${entry.grantId} 对账跳过`, err)
        }
      }),
    )
  }

  /** 定时全量对账：先把库里过期未撤销的标成到期，再 {@link reconcileLive} */
  async reconcileAll(): Promise<void> {
    try {
      const expired = await this.grants.expireDue(GRANT_EXPIRED)
      if (expired > 0) console.info(`[agent] 定时对账：${expired} 份过期授权已标记`)
    } catch (err) {
      console.error('[agent] 定时对账：标记过期授权失败', err)
    }
    await this.reconcileLive()
  }

  /** 本进程在跑的 Grant（测试、排查用） */
  live(): LiveGrantView[] {
    return [...this.grantsLive.values()].map((entry) => ({ grantId: entry.grantId, runId: entry.request.runId, flowId: entry.request.flowId, userId: entry.request.userId }))
  }
}
