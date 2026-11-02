import { createOidcClient } from '@shadecn/server-kit/oauth'
import { authConfig, postLogoutRedirectUri } from './settings.ts'

/**
 * Keycloak 的 OIDC 客户端。协议实现在 `@shadecn/server-kit/oauth`（不碰配置和全局状态，`@learning/session` 也用它），
 * 这里只接上本模块的配置。发现文档和 JWKS 的缓存跟着这个实例走，也就是跟着这个模块图走（测试换模块图就换一份）。
 */

export {
  OidcError,
  codeChallengeOf,
  decodeJwtPayload,
  randomToken,
  type AuthorizeParams,
  type Discovery,
  type IdTokenClaims,
  type OidcErrorInit,
  type TokenResponse,
} from '@shadecn/server-kit/oauth'

// 活绑定只在调用时读：模块加载时配置还没交进来
export const keycloakClient = createOidcClient(
  () => ({
    issuer: authConfig.issuer,
    clientId: authConfig.clientId,
    clientSecret: authConfig.clientSecret,
    scope: authConfig.scope,
  }),
  { label: 'Keycloak' },
)

export const {
  discover,
  buildAuthorizationUrl,
  exchangeCode,
  refreshTokens,
  revokeRefreshToken,
  verifyIdToken,
  rolesFromAccessToken,
} = keycloakClient

/** 不传 `postLogoutUri` 时回到本站的登录页 */
export function buildLogoutUrl(idToken?: string | null, postLogoutUri?: string) {
  return keycloakClient.buildLogoutUrl(idToken, postLogoutUri ?? postLogoutRedirectUri())
}
