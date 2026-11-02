import { Inject, Injectable } from '@nestjs/common'
import { OIDC_OPTIONS, type OidcProviderOptions } from './auth-options.js'
import { createOidcClient, type OidcClient, type ProviderTokens } from './oauth/index.js'

export type RefreshTokens = (refreshToken: string) => Promise<{ tokens: ProviderTokens; roles: string[] }>

/**
 * 续期要用的那部分提供方能力。放在身份模块而不是登录模块：`SessionService` 的 load 要续期，只引入身份模块的进程没有登录流程，也得能换 token。
 * 登录模块的 `AuthProviders` 复用这里的 OIDC client。
 *
 * 只有 OIDC 能续：GitHub 的 OAuth App token 不过期也没有 refresh_token，会话靠 session TTL 收口，所以 github 的密钥和配置这里都不读。
 */
@Injectable()
export class TokenRefresher {
  readonly oidc: OidcClient | null

  constructor(@Inject(OIDC_OPTIONS) options: OidcProviderOptions | null) {
    this.oidc = options ? createOidcClient(() => options) : null
  }

  /** 这个提供方的会话能不能续、怎么续。`null`：续不了（GitHub，或者这个提供方已经不配了），会话到 `expiresAt` 就结束 */
  refreshOf(provider: string): RefreshTokens | null {
    return provider === 'oidc' ? (this.oidc?.refresh ?? null) : null
  }
}
