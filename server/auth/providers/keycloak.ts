import { keycloakEnabled } from '../../config.ts'
import {
  type TokenResponse,
  buildAuthorizationUrl,
  codeChallengeOf,
  exchangeCode,
  refreshTokens,
  rolesFromAccessToken,
  verifyIdToken,
} from '../oidc.ts'
import type { AuthProvider, ProviderTokens } from './types.ts'

/**
 * Keycloak 提供方 —— 只是把原来直接写在 `routes/auth.ts` 里的那几步
 * 包成统一形状，OIDC 的实现本体还在 `auth/oidc.ts`，一行没动。
 */

function tokensFrom(tokens: TokenResponse, sessionState: string | null): ProviderTokens {
  const now = Date.now()
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    expiresAt: new Date(now + (tokens.expires_in ?? 60) * 1000),
    refreshExpiresAt: tokens.refresh_expires_in
      ? new Date(now + tokens.refresh_expires_in * 1000)
      : null,
    sessionState,
  }
}

export const keycloakProvider: AuthProvider = {
  id: 'keycloak',
  label: 'Keycloak',
  buttonLabel: '使用 Keycloak 登录',
  enabled: keycloakEnabled,

  authorizationUrl: ({ state, nonce, codeVerifier }) =>
    buildAuthorizationUrl({ state, nonce, codeChallenge: codeChallengeOf(codeVerifier) }),

  async exchange({ code, codeVerifier, nonce }) {
    const tokens = await exchangeCode(code, codeVerifier)
    if (!tokens.id_token) {
      throw new Error('Keycloak 没返回 id_token，检查 client 的 scope 是否含 openid')
    }
    const claims = await verifyIdToken(tokens.id_token, nonce)

    return {
      profile: {
        subject: claims.sub,
        issuer: claims.iss,
        username: claims.preferred_username ?? null,
        email: claims.email ?? null,
        name: claims.name ?? claims.preferred_username ?? null,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
        roles: rolesFromAccessToken(tokens.access_token),
      },
      tokens: tokensFrom(tokens, claims.sid ?? tokens.session_state ?? null),
    }
  },

  async refresh(refreshToken) {
    const tokens = await refreshTokens(refreshToken)
    return {
      tokens: tokensFrom(tokens, tokens.session_state ?? null),
      // 角色可能在 Keycloak 侧被改过，刷新时一并同步
      roles: rolesFromAccessToken(tokens.access_token),
    }
  },
}
