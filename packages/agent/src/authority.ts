/**
 * 一轮 agent 的执行身份：委托授权（Grant）与每次用能力之前的判权（docs/22 §3、§5）。
 *
 * ## 谁是主体
 *
 * 每一轮（run）是一个独立的授权主体，凭发起人在开始时签发的 Grant 运行 —— **不是发起人的登录态**。
 * 会话过期、退出登录都不影响已经在跑的一轮（docs/22 §6）；能让它停下的是 Grant 失效：
 * 发起人失去这张画布的访问权限、Grant 到期、账号级撤销。
 *
 * ## 本包只认这个接口
 *
 * Grant 存在哪、怎么判「发起人此刻还有没有权限」，本包一概不知（**不碰数据库、不碰会话**）；
 * 宿主注入 {@link RunAuthorityProvider}（apps/server 的 `agent/authority.ts`）。
 * 编排层在每一轮开始时 `issue` 一份，之后：
 *
 * - 每个工具执行之前 `authorize(tool.capability)`（`session.ts` 统一包一层，工具自己不调）；
 * - 每次请求模型之前 `authorize('llm:invoke')`（二期起在网关的模型代理里 —— 判权通过后才注入真实 key）；
 * - 画布的每次读写由宿主的 `CanvasHandle` 实现按 `flow:read` / `flow:write` 判（`openCanvas` 拿到同一份 authority）。
 *
 * 判权结果可以缓存（数秒），所以同一次工具调用里「工具一道、画布一道」不会真的查两次库。
 *
 * ## 失败语义：stop 是整轮停，不是拒掉一次调用
 *
 * {@link RunAuthorityError} 的 `kind`：
 * - `revoked` / `expired`：Grant 已失效（失权、被撤销、到期）。这一轮**立即中止**（scope 的 `on_revoke` 一期只实现 `stop`），
 *   以 cancelled / expired 收尾并写明原因 —— 只回给模型一个工具错误是不够的，被注入的模型可以无视它接着试。
 *   宿主负责把 Grant 标成已撤销；编排层负责停掉这一轮（两边都做，幂等）。
 * - `denied`：这一项能力不在授予范围里，或判权本身暂时做不了（库挂了）。只拒这一次，回给模型。
 *
 * 宿主的对账（权限变化事件、定时全量对账）发现失效时，经 {@link GrantRequest.stop} 主动停掉这一轮 ——
 * 不必等它下一次调工具（它可能正卡在一次很长的模型请求里）。
 */

import type { AgentRunStatus } from './store.ts'

/** 一轮能用的能力（docs/22 §3 的 scope） */
export const AGENT_CAPABILITIES = ['flow:read', 'flow:write', 'flow:delete', 'llm:invoke', 'sandbox:exec'] as const
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

/**
 * 一项 scope 失效时怎么处置。列全四种是为了让表结构和接口一步到位（docs/22 §9 第六期的部分撤销）；
 * **一期只实现 `stop`**，其余三种宿主签发时不会用到。
 */
export const GRANT_ON_REVOKE = ['stop', 'pause', 'degrade', 'finish_current'] as const
export type GrantOnRevoke = (typeof GRANT_ON_REVOKE)[number]

/** Grant 失效的两种来路：撤销（失权 / 显式撤销）、到期 */
export type RunStopKind = 'revoked' | 'expired'

export class RunAuthorityError extends Error {
  readonly kind: RunStopKind | 'denied'

  constructor(kind: RunStopKind | 'denied', message: string) {
    super(message)
    this.name = 'RunAuthorityError'
    this.kind = kind
  }
}

/** 不用 instanceof：宿主和本包万一各打包了一份类定义，按形状认也认得出 */
export function isRunAuthorityError(err: unknown): err is RunAuthorityError {
  if (!(err instanceof Error) || err.name !== 'RunAuthorityError') return false
  const kind = (err as { kind?: unknown }).kind
  return kind === 'revoked' || kind === 'expired' || kind === 'denied'
}

/** Grant 失效 → 整轮停（对比 `denied`：只拒这一次） */
export const stopsRun = (err: unknown): err is RunAuthorityError & { kind: RunStopKind } =>
  isRunAuthorityError(err) && err.kind !== 'denied'

/** 一轮怎么结束的 —— 宿主据此关掉 Grant（之后它不能再被用来做任何事） */
export interface RunAuthorityEnd {
  status: Exclude<AgentRunStatus, 'running'>
  reason: string | null
}

/** 一轮拿到的授权。编排层持有它直到这一轮彻底收尾 */
export interface RunAuthority {
  readonly grantId: string
  /** 签发时实际授予的能力（请求的 ∩ 发起人当时的权限 ∩ 服务端配置）。**只缩不扩**：之后新获得的权限不加进来 */
  readonly scopes: ReadonlySet<AgentCapability>
  /**
   * 用一项能力之前调：通过就返回，不通过抛 {@link RunAuthorityError}。
   * 实现判的是「授予范围 ∩ 发起人此刻的权限」，结果最多缓存数秒。
   */
  authorize(capability: AgentCapability): Promise<void>
  /** 这一轮结束了：关掉 Grant、从对账表里拿掉。不抛（失败只记日志） */
  release(end: RunAuthorityEnd): Promise<void>
}

export interface GrantRequest {
  runId: string
  flowId: string
  /** 发起人 */
  userId: string
  conversationId: string
  /** 请求的能力；宿主按发起人此刻的权限和服务端配置取交集 */
  capabilities: readonly AgentCapability[]
  /** 给人看的模型名（`llm:invoke` 的资源标识） */
  model: string | null
  /**
   * 这一轮的**总**时长上限（含被调用的 agent，docs/20 §3.10.11）；宿主据此定 Grant 的绝对过期时间（再加一点余量）。
   * 不是单轮上限：等被调用的 agent 的时间不算进单轮上限，一轮开始时不知道它会不会发起任务
   */
  timeoutMs: number
  /**
   * 宿主发现 Grant 失效（对账、账号级撤销）时调：编排层立即中止这一轮。同步、幂等；
   * 这一轮已经结束时是空操作。
   */
  stop: (kind: RunStopKind, reason: string) => void
}

export interface RunAuthorityProvider {
  /**
   * 签发一份 Grant。发起人此刻就没有这张画布的权限 → 抛（这一轮以 RUN_ERROR 收尾，不调模型）。
   */
  issue(request: GrantRequest): Promise<RunAuthority>
}

// —— 内存实现（测试用） ——

export interface MemoryGrant {
  request: GrantRequest
  grantId: string
  scopes: Set<AgentCapability>
  revoked: { kind: RunStopKind; reason: string } | null
  released: RunAuthorityEnd | null
  /** 每次 authorize 的能力，按调用顺序 */
  calls: AgentCapability[]
}

export interface MemoryAuthorityProvider extends RunAuthorityProvider {
  readonly grants: MemoryGrant[]
  /** 模拟宿主的对账：撤销某一轮的 Grant 并叫停它 */
  revoke(runId: string, reason: string, kind?: RunStopKind): void
}

export interface MemoryAuthorityOptions {
  /** 签发时去掉的能力（模拟「服务端没配」或「发起人没有」） */
  withhold?: readonly AgentCapability[]
  /** 签发失败（模拟「发起人此刻就没有权限」） */
  refuse?: string
}

/** 包内测试用：签发即授予请求的全部能力（减去 `withhold`），记下每次判权 */
export function createMemoryAuthorityProvider(options: MemoryAuthorityOptions = {}): MemoryAuthorityProvider {
  const grants: MemoryGrant[] = []
  let seq = 0
  return {
    grants,
    async issue(request) {
      if (options.refuse) throw new RunAuthorityError('revoked', options.refuse)
      seq += 1
      const grant: MemoryGrant = {
        request,
        grantId: `grant_${seq}`,
        scopes: new Set(request.capabilities.filter((cap) => !options.withhold?.includes(cap))),
        revoked: null,
        released: null,
        calls: [],
      }
      grants.push(grant)
      return {
        grantId: grant.grantId,
        scopes: grant.scopes,
        async authorize(capability) {
          grant.calls.push(capability)
          if (grant.revoked) throw new RunAuthorityError(grant.revoked.kind, grant.revoked.reason)
          if (!grant.scopes.has(capability)) {
            throw new RunAuthorityError('denied', `这一轮没有被授予 ${capability}`)
          }
        },
        async release(end) {
          grant.released = end
        },
      }
    },
    revoke(runId, reason, kind = 'revoked') {
      for (const grant of grants) {
        if (grant.request.runId !== runId || grant.revoked) continue
        grant.revoked = { kind, reason }
        grant.request.stop(kind, reason)
      }
    },
  }
}
