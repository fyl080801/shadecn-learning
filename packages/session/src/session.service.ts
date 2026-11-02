import { AuthRequest, DataAccess, newSessionToken, OidcError, Session, sessionTokenId, User } from '@learning/data-access'
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { AuthProviders } from './auth-providers.js'
import { describeError } from './errors.js'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'

/** access_token 还剩这么久以内就顺手续一次 */
const RENEW_WINDOW_MS = 30_000
/** 刷新暂时失败（连不上、超时、5xx）后，这段时间内不再撞第二次 */
const REFRESH_COOLDOWN_MS = 15_000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** 对应 Session 表里的 token 列。形状和 `@shadecn/mod-auth` 的 `ProviderTokens` 一致，但不依赖它 */
export interface SessionTokens {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresAt: Date
  refreshExpiresAt: Date | null
  sessionState: string | null
}

export interface CreateSessionInput {
  userId: string
  /** 这个会话是从哪个提供方登进来的 */
  provider: string
  tokens: SessionTokens
  userAgent?: string | null
  ip?: string | null
}

/** 带着用户档案的会话。**含 access_token 等列，只在服务端用**，给请求的只有 `toSessionUser` 的结果 */
export type LoadedSession = Session & { user: User }

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  /**
   * 同一个会话的并发刷新合并成一次：refresh token 轮换后，第二个请求拿旧的去换会被判 `invalid_grant`，把好端端的会话注销掉。
   * 只管这一个进程。多副本要换成共享锁（mod-auth 的 `sharedLock`），`apps/platform` 现在是单进程。
   */
  private readonly renewing = new Map<string, Promise<LoadedSession | null>>()
  /** 会话 id → 可以再试的时刻 */
  private readonly cooldown = new Map<string, number>()
  private sweepTimer: NodeJS.Timeout | undefined

  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(SESSION_OPTIONS) private readonly options: ResolvedSessionOptions,
    @Inject(AuthProviders) private readonly providers: AuthProviders,
  ) {}

  async onModuleInit() {
    await this.runSweep()
    this.sweepTimer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
  }

  onModuleDestroy() {
    clearInterval(this.sweepTimer)
  }

  /** 清理失败只记日志：既不该挡住启动，下一轮也还会再来 */
  private async runSweep() {
    try {
      const { sessions, authRequests } = await this.sweepExpired()
      if (sessions || authRequests) console.log(`[session] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条`)
    } catch (err) {
      console.error(`[session] 清理过期数据失败：${describeError(err)}`)
    }
  }

  /** 守卫要知道读哪个 cookie。放在这里而不是导出配置 token：`SessionGuard` 是在使用它的模块里实例化的，只依赖这个 service 就够了 */
  get cookieName(): string {
    return this.options.cookieName
  }

  private idOf(token: string): string {
    return sessionTokenId(this.options.secret, token)
  }

  /** 建会话，返回要写进 cookie 的原始 token。库里只存它的 HMAC */
  async create(input: CreateSessionInput): Promise<string> {
    const token = newSessionToken()
    const em = this.dataAccess.em()
    em.create(Session, {
      // 主键就是 token 的 HMAC，实体上故意没有自动生成主键
      id: this.idOf(token),
      user: input.userId,
      provider: input.provider,
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
      idToken: input.tokens.idToken,
      expiresAt: input.tokens.expiresAt,
      refreshExpiresAt: input.tokens.refreshExpiresAt,
      sessionState: input.tokens.sessionState,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    await em.flush()
    return token
  }

  private find(id: string): Promise<LoadedSession | null> {
    return this.dataAccess.em().findOne(Session, id, { populate: ['user'] })
  }

  /**
   * 按原始 token 取会话；access_token 快过期就顺手续一次，**会话就是被请求养活的**。语义同 `@shadecn/mod-auth` 的 `loadSession`：
   * 不存在 → null；活过 ttl → 删行并返回 null（防止一直续下去）；还有 30 秒以上 → 直接用；否则续期，见 {@link renew}。
   */
  async load(token: string | undefined): Promise<LoadedSession | null> {
    if (!token) return null

    const id = this.idOf(token)
    const running = this.renewing.get(id)
    if (running) return running

    const session = await this.find(id)
    if (!session) return null

    const now = Date.now()
    if (now - session.createdAt.getTime() > this.options.ttlSeconds * 1000) {
      await this.deleteById(id)
      return null
    }
    if (session.expiresAt.getTime() - now > RENEW_WINDOW_MS) return session

    // 上一次是「连不上」失败的：冷却期内先用着旧会话，别让每个请求都去撞一次超时
    const retryAt = this.cooldown.get(id)
    if (retryAt !== undefined && now < retryAt && this.canRefresh(session)) return session

    let renewal = this.renewing.get(id)
    if (!renewal) {
      renewal = this.renew(id).finally(() => this.renewing.delete(id))
      this.renewing.set(id, renewal)
    }
    return renewal
  }

  /** 还有没有可用的 refresh token：这一条本地就能判。GitHub 不发 refresh_token，会话走不到续期，到点就是到了上限 */
  private canRefresh(session: Session): boolean {
    if (!session.refreshToken || !this.providers.get(session.provider)?.refresh) return false
    return !session.refreshExpiresAt || session.refreshExpiresAt.getTime() > Date.now()
  }

  /**
   * **失败不是一律致命**：只有提供方明确回绝（4xx，`invalid_grant`）才删会话。连不上、超时、5xx、本地写库失败都没证明凭证失效，
   * 这时候注销，一次网络抖动就能把人踢回登录页，所以保留会话，冷却后由下一个请求再试。
   */
  private async renew(id: string): Promise<LoadedSession | null> {
    // 重新读一遍：这个请求读到旧行之后、抢到续期之前，可能刚有一次续期完成。拿旧 refresh token 再换一次就是自己注销自己
    const session = await this.find(id)
    if (!session) return null
    if (session.expiresAt.getTime() - Date.now() > RENEW_WINDOW_MS) return session

    const refresh = this.providers.get(session.provider)?.refresh
    if (!refresh || !session.refreshToken || !this.canRefresh(session)) {
      await this.deleteById(id)
      return null
    }

    try {
      const { tokens, roles } = await refresh(session.refreshToken)
      const now = new Date()
      const updated = await this.dataAccess.transactional(async (em) => {
        await em.nativeUpdate(
          Session,
          { id },
          {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? session.refreshToken,
            idToken: tokens.idToken ?? session.idToken,
            expiresAt: tokens.expiresAt,
            refreshExpiresAt: tokens.refreshExpiresAt,
            // 直接发 SQL 的更新不触发 onUpdate，updatedAt 得自己写
            updatedAt: now,
          },
        )
        // 角色可能在提供方被改过，刷新时一并同步。能续期的只有拥有角色的提供方
        await em.nativeUpdate(User, { id: session.user.id }, { roles: JSON.stringify(roles), updatedAt: now })
        // 续期这段时间里登出了就是登出了，别按「暂时失败」把旧会话交回去
        return em.findOne(Session, id, { populate: ['user'] })
      })
      this.cooldown.delete(id)
      return updated
    } catch (err) {
      if (err instanceof OidcError && !err.retryable) {
        console.warn(`[session] 刷新会话被拒绝，已注销：${describeError(err)}`)
        await this.deleteById(id)
        return null
      }
      console.warn(`[session] 刷新会话暂时失败，保留会话稍后再试：${describeError(err)}`)
      this.cooldown.set(id, Date.now() + REFRESH_COOLDOWN_MS)
      return session
    }
  }

  private async deleteById(id: string): Promise<void> {
    this.cooldown.delete(id)
    // 已经不在了（并发的另一个请求先删了）不算错：nativeDelete 删 0 行就是 0，不抛
    await this.dataAccess.em().nativeDelete(Session, { id })
  }

  /** 按原始 token 删会话；已经不在了也不算错 */
  async deleteByToken(token: string | undefined): Promise<void> {
    if (!token) return
    await this.deleteById(this.idOf(token))
  }

  /**
   * 清掉活过 ttl 的会话和没用掉的授权请求。启动时跑一次，之后每小时跑一次。
   * access_token 过期的会话不在其列：refresh token 还可能续得回来，续不回来的由 {@link load} 删。
   */
  async sweepExpired(): Promise<{ sessions: number; authRequests: number }> {
    const now = Date.now()
    for (const [id, retryAt] of this.cooldown) {
      if (retryAt <= now) this.cooldown.delete(id)
    }
    const [sessions, authRequests] = await Promise.all([
      this.dataAccess.em().nativeDelete(Session, { createdAt: { $lt: new Date(now - this.options.ttlSeconds * 1000) } }),
      this.dataAccess.em().nativeDelete(AuthRequest, { expiresAt: { $lt: new Date(now) } }),
    ])
    return { sessions, authRequests }
  }
}
