import { keycloakEnabled } from '../settings.ts'
import { keycloakClient } from '../oidc.ts'
import type { AuthProvider } from './types.ts'

/**
 * Keycloak 提供方 —— 把 OIDC 客户端包成统一形状，协议实现在 `@shadecn/server-kit/oauth`。
 */
export const keycloakProvider: AuthProvider = {
  id: 'keycloak',
  label: 'Keycloak',
  buttonLabel: '使用 Keycloak 登录',
  get enabled() {
    return keycloakEnabled
  },
  authorizationUrl: keycloakClient.authorizationUrl,
  exchange: keycloakClient.exchange,
  refresh: keycloakClient.refresh,
}
