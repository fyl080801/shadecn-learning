import { DataAccess } from '@learning/data-access'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'
import type { LoginProvider } from './auth-providers.js'
import { AuthRequest } from './entities.js'
import { describeError } from './errors.js'
import { IdentitiesService, type LinkFailure } from './identities.service.js'
import { resolveLoginIdentity } from './login-identity.js'
import { randomToken } from './oauth/index.js'
import { SessionService } from './session.service.js'
import { UserProfileCompleter } from './user-profile.js'

/** 授权请求的有效期：从点「登录」到提供方跳回来 */
export const AUTH_REQUEST_TTL_SECONDS = 10 * 60

/** 回调只有这一个路径，靠 `AuthRequest.provider` 分发。每个 origin 下的这个地址都要在提供方那边注册 */
const callbackUri = (origin: string) => `${origin}/api/auth/callback`

/**
 * 登录流程里不涉及 HTTP 的部分。`state` / `nonce` / `code_verifier` 落在 `AuthRequest`，浏览器只拿到它的 id（`oidc_tx` cookie）。
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(DataAccess) private readonly dataAccess: DataAccess,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(IdentitiesService) private readonly identities: IdentitiesService,
    @Inject(UserProfileCompleter) private readonly profiles: UserProfileCompleter,
  ) {}

  /**
   * 起一趟授权：落 `AuthRequest`，返回它的 id 和该把浏览器送去哪儿。提供方连不上（发现文档拉不到）返回 null。
   * 登录和关联走同一条路，区别只有 `linkUserId`：有值时回调走 {@link completeLink}，不建会话。
   */
  async begin(provider: LoginProvider, redirectTo: string, origin: string, linkUserId: string | null = null): Promise<{ txId: string; url: string } | null> {
    const state = randomToken()
    const nonce = randomToken()
    const codeVerifier = randomToken(64)

    const em = this.dataAccess.em()
    const request = em.create(AuthRequest, {
      state,
      nonce,
      codeVerifier,
      provider: provider.id,
      linkUserId,
      redirectTo,
      // 存下来：换 token 时的 redirect_uri 必须和这一步逐字符相同，回调时重算可能算出另一个值
      origin,
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_SECONDS * 1000),
    })
    await em.flush()

    try {
      const url = await provider.authorizationUrl({ state, nonce, codeVerifier, redirectUri: callbackUri(origin) })
      return { txId: request.id, url }
    } catch (err) {
      await this.dataAccess.em().nativeDelete(AuthRequest, { id: request.id })
      console.error(`[session] 构造 ${provider.id} 授权地址失败：${describeError(err)}`)
      return null
    }
  }

  /**
   * 一次性消费。「消费」以删除成功为准：两个回调同时拿着同一个 tx cookie 进来时，只有真删掉那一行的那个算数，
   * 另一个当作读不到（重放）。
   */
  async consume(txId: string | undefined): Promise<AuthRequest | null> {
    if (!txId) return null
    const found = await this.dataAccess.em().findOne(AuthRequest, txId)
    if (!found) return null
    const deleted = await this.dataAccess.em().nativeDelete(AuthRequest, { id: found.id })
    return deleted > 0 ? found : null
  }

  private exchange(provider: LoginProvider, request: AuthRequest, code: string) {
    return provider.exchange({
      code,
      codeVerifier: request.codeVerifier,
      nonce: request.nonce,
      redirectUri: callbackUri(request.origin),
    })
  }

  /** code 换身份、落用户、建会话，返回要写进 cookie 的 token。**只有全部成功才有会话** */
  async complete(
    provider: LoginProvider,
    request: AuthRequest,
    code: string,
    client: { userAgent: string | null; ip: string | null },
  ): Promise<string> {
    const { profile, tokens } = await this.exchange(provider, request, code)

    const em = () => this.dataAccess.em()
    const input = { provider: provider.id, profile, ownsRoles: provider.ownsRoles }
    // 同一个新用户的两个回调同时到：输的那个撞唯一约束，这时候对方已经落库，再走一遍就是「已绑过」那条分支
    const user = await resolveLoginIdentity(em, input).catch((err: unknown) => {
      if (err instanceof UniqueConstraintViolationException) return resolveLoginIdentity(em, input)
      throw err
    })
    // 建会话之前：拿到会话的进程（包括协同副本）读到的 User 都已经补过
    await this.profiles.complete(user)

    const token = await this.sessions.create({ userId: user.id, provider: provider.id, tokens, ...client })
    console.log(`[session] 登录成功（${provider.id}）：${user.username ?? user.email ?? user.subject}`)
    return token
  }

  /**
   * 关联的回调：code 换身份，预检，暂存等用户确认，返回绑不成的原因。**这里绝不写 `UserIdentity`，也不建会话**，token 用完就丢。
   * `userId` 是 `AuthRequest.linkUserId`，调用方已经核对过当前会话还是这个人。
   */
  async completeLink(provider: LoginProvider, request: AuthRequest, code: string, userId: string): Promise<LinkFailure | null> {
    const { profile } = await this.exchange(provider, request, code)
    const blocked = await this.identities.checkLink(userId, provider.id, profile.subject)
    if (blocked) return blocked
    await this.identities.stashPending(userId, provider.id, profile)
    console.log(`[session] 用户 ${userId} 待确认关联 ${provider.id}`)
    return null
  }
}
