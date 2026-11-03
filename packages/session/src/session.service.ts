import { Cluster, type SharedLock, SharedLockUnavailableError } from '@learning/cluster'
import { DataAccess, User } from '@learning/data-access'
import { Inject, Injectable } from '@nestjs/common'
import { Session } from './entities.js'
import { describeError } from './errors.js'
import { HTTP_TIMEOUT, OidcError, type ProviderTokens } from './oauth/index.js'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'
import { deriveSecretFrom, newSessionToken, sessionTokenId } from './session-token.js'
import { type RefreshTokens, TokenRefresher } from './token-refresher.js'

/** access_token 还剩这么久以内就顺手续一次 */
const RENEW_WINDOW_MS = 30_000
/** 刷新暂时失败（连不上、超时、5xx）后，这段时间内不再撞第二次 */
const REFRESH_COOLDOWN_MS = 15_000
/**
 * 续期锁的存活上限。**必须大于持锁期间最坏的耗时**，否则锁过期后另一个进程抢到锁，拿同一个 refresh token 再换一次，被判 `invalid_grant` 后注销会话。
 * 最坏情况：发现文档缓存刚好过期（一次 HTTP 超时）+ token 端点（一次 HTTP 超时）+ 写库。写库没有超时上限，留出余量。
 * 等锁的进程最多也等这么久：赢家崩溃时这是一个请求的最坏延迟，所以不能给得太大。
 */
export const RENEW_LOCK_TTL_MS = 2 * HTTP_TIMEOUT + 14_000
/** 本进程续不了某个提供方的会话时，多久提醒一次：每个请求都打就是刷屏 */
const NO_CLIENT_WARN_INTERVAL_MS = 5 * 60 * 1000

/** 对应 Session 表里的 token 列 */
export type SessionTokens = ProviderTokens

export interface CreateSessionInput {
  userId: string
  /** 这个会话是从哪个提供方登进来的 */
  provider: string
  tokens: SessionTokens
  userAgent?: string | null
  ip?: string | null
}

export interface LoadSessionOptions {
  /**
   * access_token 快过期时要不要顺手续一次，默认 true。
   * 传 `false` 的是**背后没有真实用户动作**的调用（协同长连接的复验、写闸门）：refresh token 的空闲超时掌握在提供方手里，每续一次就往后推一次，
   * 复验定时跑的话，开着标签页不动的人永远不会空闲超时。只读调用只回答「此刻还有效吗」：不续期，也**不写库、不删行**，清理留给真实请求和 `SessionSweeper`。
   */
  refresh?: boolean
}

/** 带着用户档案的会话。**含 access_token 等列，只在服务端用**，给请求的只有 `toSessionUser` 的结果 */
export type LoadedSession = Session & { user: User }

@Injectable()
export class SessionService {
  /**
   * 同一个进程里，同一个会话的并发续期合并成一次：共享锁（{@link renewLock}）也能保证不并发，
   * 但没有这一层的话，redis 模式下同进程的后来者都要轮询 Redis 等自己进程的请求做完。
   */
  private readonly renewing = new Map<string, Promise<LoadedSession | null>>()
  /** 会话 id → 可以再试的时刻 */
  private readonly cooldown = new Map<string, number>()
  /** 提供方 → 上次提醒的时刻，见 {@link NO_CLIENT_WARN_INTERVAL_MS} */
  private readonly noClientWarnedAt = new Map<string, number>()
  /**
   * 跨进程的续期互斥：refresh token 轮换后，第二个进程拿旧的去换会被判 `invalid_grant`，把好端端的会话注销掉。
   * `single` 模式下是进程内实现。
   */
  private readonly renewLock: SharedLock

  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(SESSION_OPTIONS) private readonly options: ResolvedSessionOptions,
    @Inject(TokenRefresher) private readonly refresher: TokenRefresher,
    @Inject(Cluster) cluster: Cluster,
  ) {
    this.renewLock = cluster.createLock('session-renew')
  }

  /** 守卫要知道读哪个 cookie。放在这里而不是导出配置 token：`SessionGuard` 是在使用它的模块里实例化的，只依赖这个 service 就够了 */
  get cookieName(): string {
    return this.options.cookieName
  }

  private idOf(token: string): string {
    return sessionTokenId(this.options.secret, token)
  }

  /**
   * 按用途从会话密钥派生一把密钥，同一把会话密钥、同一个用途在所有进程上都得到同一个值。
   * 开发时没配 `PLATFORM_SESSION_SECRET` 的话，会话密钥是这次运行临时生成的，派生结果也只在这次运行里有效。
   */
  deriveSecret(purpose: string): string {
    return deriveSecretFrom(this.options.secret, purpose)
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
   * 按原始 token 取会话；access_token 快过期就顺手续一次，**会话就是被请求养活的**：
   * 不存在 → null；活过 ttl → 删行并返回 null（防止一直续下去）；还有 30 秒以上 → 直接用；否则续期，见 {@link renew}。
   * `refresh: false` 的只读分支见 {@link LoadSessionOptions}：refresh token 还在就算有效（下一次真实请求会去续），绝不写库。
   */
  async load(token: string | undefined, options: LoadSessionOptions = {}): Promise<LoadedSession | null> {
    if (!token) return null

    const readOnly = options.refresh === false
    const id = this.idOf(token)
    // 只读调用不搭正在进行的续期：它只看库，也不该被提供方的超时拖住
    const running = readOnly ? undefined : this.renewing.get(id)
    if (running) return running

    const session = await this.find(id)
    if (!session) return null

    const now = Date.now()
    if (now - session.createdAt.getTime() > this.options.ttlSeconds * 1000) {
      if (!readOnly) await this.deleteById(id)
      return null
    }
    if (this.isFresh(session)) return session
    if (readOnly) return this.canRefresh(session) ? session : null

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

  /** refresh token 本身还能不能用：这一条本地就能判，不用问提供方 */
  private hasLiveRefreshToken(session: Session): boolean {
    if (!session.refreshToken) return false
    return !session.refreshExpiresAt || session.refreshExpiresAt.getTime() > Date.now()
  }

  /** 这个进程能不能续：GitHub 不发 refresh_token，会话走不到续期，到点就是到了上限 */
  private canRefresh(session: Session): boolean {
    return this.hasLiveRefreshToken(session) && this.refresher.refreshOf(session.provider) !== null
  }

  private isFresh(session: Session): boolean {
    return session.expiresAt.getTime() - Date.now() > RENEW_WINDOW_MS
  }

  /**
   * 进锁之前先把本地就能判的判掉：判得出结局的会话不该因为 Redis 故障而悬着，也不必多一次 Redis 往返。
   * - refresh token 没有了或过期了：会话确实结束了，删行；
   * - refresh token 还好，只是**这个进程**没有对应的 client（少配了 `auth.oidc`）：本次按未登录处理，**不删行**，
   *   别的进程可能还续得了。行最终由 `SessionSweeper` 按 TTL 回收；
   * - 其余的经共享锁续期。
   *
   * **锁不可用**（Redis 故障）时不能续也不能注销：无锁去换就是这把锁要防的事，注销更没有依据。保留旧会话，进入冷却。
   */
  private async renew(id: string): Promise<LoadedSession | null> {
    // 重新读一遍：这个请求读到旧行之后、抢到续期之前，可能刚有一次续期完成
    const session = await this.find(id)
    if (!session) return null
    if (this.isFresh(session)) return session

    if (!this.hasLiveRefreshToken(session)) return this.deleteUnlessRenewed(session)
    const refresh = this.refresher.refreshOf(session.provider)
    if (!refresh) {
      this.warnNoClient(session.provider)
      return null
    }

    try {
      return await this.renewLock.run(id, () => this.renewHoldingLock(id, refresh), {
        ttlMs: RENEW_LOCK_TTL_MS,
        fallback: () => this.afterWaiting(id),
      })
    } catch (err) {
      if (!(err instanceof SharedLockUnavailableError)) throw err
      console.warn('[session] 共享锁不可用，保留会话稍后再试')
      this.startCooldown(id)
      return session
    }
  }

  /**
   * 持锁续期。**失败不是一律致命**：只有提供方明确回绝（4xx，`invalid_grant`）才删会话。连不上、超时、5xx、本地写库失败都没证明凭证失效，
   * 这时候注销，一次网络抖动就能把人踢回登录页，所以保留会话，冷却后由下一个请求再试。
   */
  private async renewHoldingLock(id: string, refresh: RefreshTokens): Promise<LoadedSession | null> {
    // 再读一遍，这次在锁里：别的进程可能在我们进锁之前刚放开锁。拿旧行上的 refresh token 去换就是自己注销自己
    const session = await this.find(id)
    if (!session) return null
    if (this.isFresh(session) || !session.refreshToken) return session

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
        return this.deleteUnlessRenewed(session)
      }
      console.warn(`[session] 刷新会话暂时失败，保留会话稍后再试：${describeError(err)}`)
      this.startCooldown(id)
      return session
    }
  }

  /**
   * 没抢到锁，等到之后（对方放锁、锁过期、或等的途中 Redis 坏了）看结果。**这里绝不拿 refresh token 去换**：此刻没有锁。
   * 对方续好了就用新行；行没了是对方判定注销了（或用户登出了）；都不是说明对方失败或崩溃了，保留旧会话，冷却后由下一个请求重新抢锁。
   */
  private async afterWaiting(id: string): Promise<LoadedSession | null> {
    const session = await this.find(id)
    if (!session) return null
    if (this.isFresh(session)) {
      this.cooldown.delete(id)
      return session
    }
    this.startCooldown(id)
    return session
  }

  /**
   * 删会话，但只删「还是我看到的那个 refresh token」的行：判定和删除之间，别的进程可能已经续好了
   * （比如锁过期后它抢到了，我这边的 `invalid_grant` 正是被它轮换导致的）。这时候用它的结果，不注销。
   */
  private async deleteUnlessRenewed(session: Session): Promise<LoadedSession | null> {
    this.cooldown.delete(session.id)
    const deleted = await this.dataAccess.em().nativeDelete(Session, { id: session.id, refreshToken: session.refreshToken })
    return deleted > 0 ? null : this.find(session.id)
  }

  private warnNoClient(provider: string): void {
    const now = Date.now()
    if (now - (this.noClientWarnedAt.get(provider) ?? -Infinity) < NO_CLIENT_WARN_INTERVAL_MS) return
    this.noClientWarnedAt.set(provider, now)
    console.warn(`[session] 这个进程没有配置 ${provider} 的 client，续不了它的会话：本次按未登录处理，不删行（检查 auth.oidc 和其他进程是否一致）`)
  }

  /** 顺手清掉到期的：人走了的会话不会再有请求来删它，这张表又没有定时任务管（只引入身份模块的进程不跑清理） */
  private startCooldown(id: string): void {
    const now = Date.now()
    for (const [other, retryAt] of this.cooldown) {
      if (retryAt <= now) this.cooldown.delete(other)
    }
    this.cooldown.set(id, now + REFRESH_COOLDOWN_MS)
  }

  private async deleteById(id: string): Promise<void> {
    this.cooldown.delete(id)
    // 已经不在了（并发的另一个请求先删了）不算错：nativeDelete 删 0 行就是 0，不抛
    await this.dataAccess.em().nativeDelete(Session, { id })
  }

  /**
   * 行还在不在。{@link load} 返回 null 不等于会话没了：这个进程续不了时也是 null，这时候不该清浏览器的 cookie，否则换个进程本来还能续的会话也丢了。
   */
  async exists(token: string | undefined): Promise<boolean> {
    if (!token) return false
    return (await this.dataAccess.em().count(Session, { id: this.idOf(token) })) > 0
  }

  /** 按原始 token 删会话；已经不在了也不算错 */
  async deleteByToken(token: string | undefined): Promise<void> {
    if (!token) return
    await this.deleteById(this.idOf(token))
  }
}
