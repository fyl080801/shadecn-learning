import { createGithubClient } from '@shadecn/server-kit/oauth'
import { authConfig, githubConfig, githubEnabled } from '../settings.ts'
import type { AuthProvider, ProviderTokens } from './types.ts'

/**
 * GitHub OAuth App 提供方。请求逻辑（以及它和 OIDC 的四个差别）在 `@shadecn/server-kit/oauth`，这里接上本模块的配置。
 */

// 活绑定只在调用时读：模块加载时配置还没交进来
const client = createGithubClient(() => ({
  clientId: githubConfig.clientId,
  clientSecret: githubConfig.clientSecret,
  scope: githubConfig.scope,
}))

function tokensOf(accessToken: string): ProviderTokens {
  return {
    accessToken,
    refreshToken: null,
    idToken: null,
    // OAuth App 的 token 不会过期。给会话自己的 TTL，`loadSession` 就永远不会
    // 走到续期分支去（那条路是 Keycloak 专属的），会话到期由 MODULES_AUTH_SESSION_TTL 收口
    expiresAt: new Date(Date.now() + authConfig.ttl * 1000),
    refreshExpiresAt: null,
    sessionState: null,
  }
}

export const githubProvider: AuthProvider = {
  id: 'github',
  label: 'GitHub',
  buttonLabel: '使用 GitHub 登录',
  get enabled() {
    return githubEnabled
  },

  authorizationUrl: (input) => Promise.resolve(client.authorizationUrl(input)),

  async exchange(input) {
    const { profile, accessToken } = await client.exchange(input)
    return { profile, tokens: tokensOf(accessToken) }
  },

  // token 不过期也换不了新的：没有续期这回事
  refresh: null,
}
