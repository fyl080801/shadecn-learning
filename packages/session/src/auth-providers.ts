import { Inject, Injectable } from '@nestjs/common'
import { LOGIN_OPTIONS, type ResolvedLoginOptions } from './auth-options.js'
import { createGithubClient, type ProviderProfile, type ProviderTokens } from './oauth/index.js'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'
import { TokenRefresher } from './token-refresher.js'

/** 登录方式的统一形状：路由按它办事，不认识具体是哪家。协议实现在 `oauth/`，这里只接上配置 */
export interface LoginProvider {
  /** `AuthRequest.provider`、`Session.provider`、`UserIdentity.provider` 和 `?provider=` 的取值 */
  id: 'oidc' | 'github'
  label: string
  buttonLabel: string
  /** 这个提供方的角色才写进 `User.roles`（GitHub 没有本应用的角色，照写就清空了） */
  ownsRoles: boolean
  authorizationUrl(input: { state: string; nonce: string; codeVerifier: string; redirectUri: string }): Promise<string>
  exchange(input: {
    code: string
    codeVerifier: string
    nonce: string
    redirectUri: string
  }): Promise<{ profile: ProviderProfile; tokens: ProviderTokens }>
}

/** 配齐了的登录方式。数组顺序就是登录页按钮顺序，第一个是不带 `?provider=` 时的默认 */
@Injectable()
export class AuthProviders {
  readonly list: readonly LoginProvider[]

  constructor(
    @Inject(SESSION_OPTIONS) options: ResolvedSessionOptions,
    @Inject(LOGIN_OPTIONS) { oidc, github }: ResolvedLoginOptions,
    @Inject(TokenRefresher) refresher: TokenRefresher,
  ) {
    const list: LoginProvider[] = []
    // 和续期共用一个 client：发现文档和 JWKS 的缓存跟着实例走。两边读的是同一份 OIDC_OPTIONS，oidc 有值时 client 一定有
    const client = refresher.oidc
    if (oidc && client) {
      list.push({
        id: 'oidc',
        label: 'OIDC',
        buttonLabel: oidc.buttonLabel,
        ownsRoles: true,
        authorizationUrl: client.authorizationUrl,
        exchange: client.exchange,
      })
    }
    if (github) {
      const client = createGithubClient(() => github)
      list.push({
        id: 'github',
        label: 'GitHub',
        buttonLabel: '使用 GitHub 登录',
        ownsRoles: false,
        authorizationUrl: (input) => Promise.resolve(client.authorizationUrl(input)),
        async exchange(input) {
          const { profile, accessToken } = await client.exchange(input)
          return {
            profile,
            tokens: {
              accessToken,
              refreshToken: null,
              idToken: null,
              // OAuth App 的 token 不会过期：到期时间就是会话自己的上限，走不到续期分支
              expiresAt: new Date(Date.now() + options.ttlSeconds * 1000),
              refreshExpiresAt: null,
              sessionState: null,
            },
          }
        },
      })
    }
    this.list = list
  }

  /** 没配（或不是字符串，`?provider=a&provider=b` 会是数组）→ null */
  get(id: unknown): LoginProvider | null {
    return this.list.find((provider) => provider.id === id) ?? null
  }
}
