import {
  RunAuthorityError,
  stopsRun,
  type AgentCapability,
  type GrantRequest,
  type RunAuthority,
  type RunAuthorityProvider,
  type RunStopKind,
} from '@shadecn/agent/authority'
import type { AgentRunStatus } from '@shadecn/agent/store'
import { agentConfig } from '../config.ts'
import { announceRevocation, onAccessRevoked } from '../collab/revocation.ts'
import { agentGrants } from '../store/agent.ts'
import { flows } from '../store/flows.ts'
import { projects } from '../store/projects.ts'

/**
 * 画布 agent 的执行身份在本服务里的实现：签发 Grant、每次判权、对账（docs/22 §3、§5）。
 * 编排层（`@shadecn/agent/session`）只认 `@shadecn/agent/authority` 的接口，Grant 存在哪、权限怎么查都在这里。
 *
 * ## 有效权限 = 授予范围 ∩ 发起人此刻的权限 ∩ 服务端配置
 *
 * 一次判权（{@link GrantAuthority} 的 `authorize`）依次看：
 * 1. 这份 Grant 在本进程里已经判死过 → 直接拒（不再查库）；
 * 2. 过了 `expiresAt` → **expired**；
 * 3. 这项能力不在授予范围里 → denied（只拒这一次）；
 * 4. 库里这一行 `revokedAt` 已写（别的实例做的账号级撤销也在这里被看见）→ revoked；
 * 5. 发起人此刻还能进这张画布（`requireFlowMember` 同口径：画布和项目没删、是项目成员），
 *    **且画布仍在签发时那个项目里、个人画布仍是同一个所有者**（签发时的快照）→ 否则 revoked。
 *
 * 4、5 两项的结论缓存 {@link VERDICT_TTL_MS}（缓存的是 Promise，并发的判权共用一次查询）；
 * 1–3 每次都判。所以一次工具调用里「工具那道」和「画布读写那道」只查一次库。
 * 判权本身查不了库（库挂了）→ denied：这次调用不执行、回给模型，但不因为一次瞬时故障停掉整轮；结果不缓存。
 *
 * ## 失效即 stop（docs/22 §5）
 *
 * revoked / expired：先经 `GrantRequest.stop` **当场叫停这一轮**，再把库里这一行标成已撤销（原因写进 `revokeReason`），
 * 之后这份 Grant 的每次判权都直接拒。编排层收到 {@link RunAuthorityError} 也会叫停（两边都做，幂等）。
 *
 * ## 对账（Reconciler）
 *
 * 在跑的 Grant 记在本进程的 `live` 表里（一轮收尾 `release` 时拿掉）。三条路触发对账，**逐份重判（不用缓存）**：
 * - **权限变化事件**：`collab/revocation.ts` 的 `onAccessRevoked` —— 本实例的 `revokeCollabAccess()`（移除成员 / 删项目 / 删画布，
 *   路由 await 它，所以 204 时失权的那一轮已经被叫停）当场触发；别的实例做的经撤销世代号巡检，最迟一个巡检周期；
 * - **定时全量对账**（{@link startAgentReconciler}，默认每 10 分钟）：先把库里过期未撤销的 Grant 标成到期
 *   （含进程崩溃留下的孤儿），再重判 `live` 里的每一份；
 * - **账号级撤销**（{@link revokeAllGrantsForUser}）。
 * 同一个「画布 + 发起人」在一次对账里只查一次权限；不受影响的轮次（同一个人在别的画布上的）照常跑。
 *
 * ## 与登录态无关（docs/22 §6）
 *
 * 这里**不看会话**：退出登录、会话过期不会让任何一轮停下。一轮由一次带着有效会话的请求发起，之后凭的只是 Grant。
 */

/** 判权结论的缓存时长：权限变化事件会清掉它（对账逐份重判），这个时长只兜底「没发事件的改动」 */
export const VERDICT_TTL_MS = 3000

/** 定时全量对账的间隔（docs/22 §5） */
export const RECONCILE_INTERVAL_MS = 10 * 60_000

/** 发起时就进不了这张画布 —— 和 404 同一个口径，不区分「画布没了」和「你不是成员」 */
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

/** 签发时（以及每次判权时）画布所在的项目；发起人不是成员 / 画布不在了 → null */
interface FlowAccess {
  projectId: string
  kind: 'team' | 'personal'
  personalOwnerId: string | null
}

/** 和 `requireFlowMember` 同口径：画布（及其项目）没被删，且这个人是项目成员（个人空间即所有者） */
export async function currentFlowAccess(flowId: string, userId: string): Promise<FlowAccess | null> {
  const target = await flows.locate(flowId)
  if (!target) return null
  return (await projects.membershipOf(target.projectId, userId)) ? target : null
}

type Verdict = { ok: true } | { ok: false; kind: RunStopKind; reason: string }

interface LiveGrant {
  grantId: string
  request: GrantRequest
  scopes: ReadonlySet<AgentCapability>
  /** 签发时的快照：判权时画布必须还在这个项目里、个人画布还是这个所有者 */
  snapshot: FlowAccess
  /** UTC epoch 毫秒 */
  expiresAt: number
  /** 已判死（之后的判权直接拒，不再查库） */
  dead: { kind: RunStopKind; reason: string } | null
  verdict: { at: number; promise: Promise<Verdict> } | null
}

export interface LiveGrantView {
  grantId: string
  runId: string
  flowId: string
  userId: string
}

export interface GrantAuthority extends RunAuthorityProvider {
  /** 重判本进程里每一份在跑的 Grant（不用缓存），失效的叫停 —— 权限变化事件触发 */
  reconcileLive(): Promise<void>
  /** 定时全量对账：先把库里过期未撤销的标成到期，再 {@link reconcileLive} */
  reconcileAll(): Promise<void>
  /** 账号级撤销（见 {@link revokeAllGrantsForUser}）；返回本进程叫停了几轮 */
  revokeAllForUser(userId: string, reason: string): Promise<number>
  /** 本进程在跑的 Grant（测试、排查用） */
  live(): LiveGrantView[]
}

export interface GrantAuthorityOptions {
  /** 绝对过期时间 = 签发时刻 + 这一轮的时长上限 + 它 */
  expiryMarginMs: number
  verdictTtlMs?: number
  /** 服务端配置允许的能力（docs/22 §5 的 entitlements） */
  entitled: (capability: AgentCapability) => boolean
  now?: () => number
}

function resourceOf(capability: AgentCapability, request: GrantRequest): string {
  if (capability === 'llm:invoke') return `model:${request.model ?? 'unknown'}`
  if (capability === 'sandbox:exec') return `run:${request.runId}`
  return `flow:${request.flowId}`
}

export function createGrantAuthority(options: GrantAuthorityOptions): GrantAuthority {
  const now = options.now ?? Date.now
  const verdictTtlMs = options.verdictTtlMs ?? VERDICT_TTL_MS
  const live = new Map<string, LiveGrant>()

  async function evaluate(entry: LiveGrant, access: Promise<FlowAccess | null>): Promise<Verdict> {
    const [state, current] = await Promise.all([agentGrants.state(entry.grantId), access])
    if (!state) return { ok: false, kind: 'revoked', reason: ACCESS_REVOKED }
    if (state.expiresAt.getTime() <= now()) return { ok: false, kind: 'expired', reason: GRANT_EXPIRED }
    if (state.revokedAt) return { ok: false, kind: 'revoked', reason: state.revokeReason ?? ACCESS_REVOKED }
    const same =
      current !== null &&
      current.projectId === entry.snapshot.projectId &&
      current.personalOwnerId === entry.snapshot.personalOwnerId
    return same ? { ok: true } : { ok: false, kind: 'revoked', reason: ACCESS_REVOKED }
  }

  /** 判死：先叫停这一轮（立即），再把库里这一行标成已撤销 */
  async function fail(entry: LiveGrant, kind: RunStopKind, reason: string): Promise<void> {
    if (entry.dead) return
    entry.dead = { kind, reason }
    entry.verdict = null
    const { runId, flowId, userId } = entry.request
    console.warn(
      `[agent] run=${runId} flow=${flowId} user=${userId} grant=${entry.grantId} ` +
        `${kind === 'expired' ? '授权到期' : '授权撤销'}，叫停：${reason}`,
    )
    try {
      entry.request.stop(kind, reason)
    } catch (err) {
      console.error(`[agent] run=${runId} 叫停失败`, err)
    }
    try {
      await agentGrants.revoke(entry.grantId, reason)
    } catch (err) {
      // 本进程里它已经判死了；库里没标上只影响审计，下一次定时对账会按到期补标
      console.error(`[agent] grant=${entry.grantId} 撤销没能写进库`, err)
    }
  }

  /** 判一次：过了返回，不过抛（失效的顺手判死、叫停） */
  async function check(entry: LiveGrant, fresh: boolean, access?: Promise<FlowAccess | null>): Promise<void> {
    if (entry.dead) throw new RunAuthorityError(entry.dead.kind, entry.dead.reason)
    if (now() >= entry.expiresAt) {
      await fail(entry, 'expired', GRANT_EXPIRED)
      throw new RunAuthorityError('expired', GRANT_EXPIRED)
    }
    const at = now()
    let cached = entry.verdict
    if (fresh || !cached || at - cached.at >= verdictTtlMs) {
      const promise = evaluate(entry, access ?? currentFlowAccess(entry.request.flowId, entry.request.userId))
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
      await fail(entry, verdict.kind, verdict.reason)
      throw new RunAuthorityError(verdict.kind, verdict.reason)
    }
  }

  async function reconcileLive(): Promise<void> {
    const entries = [...live.values()].filter((entry) => !entry.dead)
    if (entries.length === 0) return
    // 同一个「画布 + 发起人」只查一次权限
    const accessByKey = new Map<string, Promise<FlowAccess | null>>()
    await Promise.all(
      entries.map(async (entry) => {
        const { flowId, userId } = entry.request
        const key = `${flowId}\n${userId}`
        let access = accessByKey.get(key)
        if (!access) {
          access = currentFlowAccess(flowId, userId)
          accessByKey.set(key, access)
        }
        try {
          await check(entry, true, access)
        } catch (err) {
          // 失效的已经在 check 里叫停了；查不了库的这次跳过，下一次判权 / 对账再看
          if (!stopsRun(err)) console.warn(`[agent] grant=${entry.grantId} 对账跳过`, err)
        }
      }),
    )
  }

  return {
    async issue(request) {
      const access = await currentFlowAccess(request.flowId, request.userId)
      if (!access) throw new RunAuthorityError('revoked', ACCESS_LOST)

      // 只缩不扩：请求的 ∩ 服务端配置；发起人此刻是成员 = 画布的三项都有（权限模型只有成员 / 管理员，都能编辑）
      const scopes = new Set(request.capabilities.filter((capability) => options.entitled(capability)))
      const expiresAt = now() + request.timeoutMs + options.expiryMarginMs
      const grantId = await agentGrants.create({
        userId: request.userId,
        runId: request.runId,
        flowId: request.flowId,
        projectId: access.projectId,
        projectKind: access.kind,
        personalOwnerId: access.personalOwnerId,
        expiresAt: new Date(expiresAt),
        scopes: [...scopes].map((scope) => ({
          scope,
          resource: resourceOf(scope, request),
          onRevoke: 'stop',
          required: true,
        })),
      })
      /*
       * 不预置「刚判过」的缓存：签发查权限和登记进 live 之间如果恰好来了一次撤销事件，
       * 那次对账看不到这一份 —— 第一次判权重查，窗口就合上了。
       */
      const entry: LiveGrant = { grantId, request, scopes, snapshot: access, expiresAt, dead: null, verdict: null }
      live.set(grantId, entry)
      console.info(
        `[agent] run=${request.runId} flow=${request.flowId} user=${request.userId} grant=${grantId} 已签发（${[...scopes].join(' ')}）`,
      )

      const authority: RunAuthority = {
        grantId,
        scopes,
        async authorize(capability) {
          if (entry.dead) throw new RunAuthorityError(entry.dead.kind, entry.dead.reason)
          if (!scopes.has(capability)) {
            throw new RunAuthorityError('denied', `这一轮没有被授予「${capability}」，这次操作没有执行`)
          }
          await check(entry, false)
        },
        async release(end) {
          live.delete(grantId)
          try {
            // 已因失权 / 到期撤销的，保留那个原因（revoke 只写 revokedAt 为空的行）
            await agentGrants.revoke(grantId, `本轮已结束（${STATUS_LABEL[end.status]}）`)
          } catch (err) {
            console.error(`[agent] grant=${grantId} 收尾没能关掉，等它自然到期`, err)
          }
        },
      }
      return authority
    },

    reconcileLive,

    async reconcileAll() {
      try {
        const expired = await agentGrants.expireDue(GRANT_EXPIRED)
        if (expired > 0) console.info(`[agent] 定时对账：${expired} 份过期授权已标记`)
      } catch (err) {
        console.error('[agent] 定时对账：标记过期授权失败', err)
      }
      await reconcileLive()
    },

    async revokeAllForUser(userId, reason) {
      const mine = [...live.values()].filter((entry) => entry.request.userId === userId && !entry.dead)
      await Promise.all(mine.map((entry) => fail(entry, 'revoked', reason)))
      const revoked = await agentGrants.revokeAllForUser(userId, reason)
      console.warn(`[agent] user=${userId} 账号级撤销：本实例叫停 ${mine.length} 轮，共撤销 ${revoked} 份授权（${reason}）`)
      return mine.length
    },

    live() {
      return [...live.values()].map((entry) => ({
        grantId: entry.grantId,
        runId: entry.request.runId,
        flowId: entry.request.flowId,
        userId: entry.request.userId,
      }))
    },
  }
}

/** 本进程的那一份（`agent/index.ts` 注入编排层） */
export const agentAuthority = createGrantAuthority({
  expiryMarginMs: agentConfig.grantMarginMs,
  // 没开媒体工具就不授 sandbox:exec；模型能不能用由 runtime 是否启用决定（没启用根本不会签发）
  entitled: (capability) => capability !== 'sandbox:exec' || agentConfig.sandboxExec,
})

// 权限变化事件 → 对账（本实例当场；别的实例经撤销世代号巡检）。协同层不知道订阅者是谁
onAccessRevoked(() => agentAuthority.reconcileLive())

/**
 * **账号级撤销**：停掉这个人在本实例上的全部在跑轮次，并把他在库里全部还有效的 Grant 标成已撤销（docs/22 §5、§6）。
 * 别的实例上的轮次：撤销写进了库，再广播一次撤销世代号，那些实例的对账重判时读到 `revokedAt` 即叫停（最迟一个巡检周期）。
 *
 * **目前没有调用方**。预期的接入点是账号安全事件：封禁账号、改密码 / 重置凭据、管理员强制下线、
 * 以及后续的「退出并停止所有任务」（docs/22 §6）。**普通的退出登录、会话过期不要调它** —— 会话与执行身份解耦。
 */
export async function revokeAllGrantsForUser(userId: string, reason: string): Promise<number> {
  const stopped = await agentAuthority.revokeAllForUser(userId, reason)
  await announceRevocation()
  return stopped
}

/**
 * 启动定时全量对账（index.ts 启动时调一次）。定时器 `unref()`，不挡进程退出；返回的函数停掉它（shutdown 时调）。
 */
export function startAgentReconciler(intervalMs = RECONCILE_INTERVAL_MS, authority: GrantAuthority = agentAuthority): () => void {
  const timer = setInterval(() => {
    void authority.reconcileAll().catch((err: unknown) => console.error('[agent] 定时对账失败', err))
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
