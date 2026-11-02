import { HTTP_TIMEOUT, OidcError, type ProviderProfile } from './types.js'

/**
 * GitHub OAuth App 的请求逻辑。
 *
 * 和 OIDC 那条路的四个真实差别，代码里每一处都由它们决定：
 *
 * 1. **没有 discovery**，端点写死在下面（GitHub 不提供 well-known 文档）；
 * 2. **没有 id_token**，所以「这个人是谁」要拿 access_token 再调一次 `/user`，
 *    没有签名可验 —— 但 token 是我们自己从 TLS 通道换回来的，验签本来也只是防配置串台；
 * 3. **换 token 失败也返回 HTTP 200**，错误在 body 里（`{error, error_description}`），
 *    只看状态码会把「code 已经用过了」当成功；
 * 4. **OAuth App 的 token 不会过期，也没有 refresh_token** —— 所以这里没有 refresh，
 *    到期时间由调用方按自己的会话时长给，会话由本地 TTL 收口而不是由对方收口。
 *
 * PKCE：GitHub 的 OAuth App 不支持，传了 code_challenge 也只会被忽略，
 * 这里就不传了 —— 防重放靠 state 一次性消费（`AuthRequest` 拿到就删）。
 *
 * **不碰配置、实体和全局状态**：配置由调用方的 getter 给。测试换全局 fetch，这些地址不需要别的注入点。
 */

/** 落进 User.issuer / UserIdentity.issuer 的固定值 */
export const GITHUB_ISSUER = 'https://github.com'
/** 只要读身份：read:user 拿档案，user:email 拿主邮箱（GitHub 可能把邮箱设为私密） */
export const GITHUB_DEFAULT_SCOPE = 'read:user user:email'

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const EMAILS_URL = 'https://api.github.com/user/emails'

/** GitHub 的 API 要求必须带 User-Agent，不带直接 403 */
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'shadcn-learning',
} as const

interface GithubTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

interface GithubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

interface GithubEmail {
  email: string
  primary: boolean
  verified: boolean
}

async function callApi<T>(url: string, accessToken: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { ...API_HEADERS, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    })
  } catch (err) {
    throw new OidcError(`连不上 GitHub API（${url}）`, { retryable: true, cause: err })
  }
  if (!res.ok) {
    throw new OidcError(`GitHub API 返回 ${res.status}（${url}）`, { retryable: res.status >= 500 })
  }
  return (await res.json()) as T
}

/**
 * 主邮箱。GitHub 用户可以把邮箱设为私密，那时 `/user` 里的 `email` 是 null，
 * 得靠 `user:email` scope 再要一次 —— 拿不到就算了，邮箱不是必填项。
 *
 * 只在缺邮箱时才多打这一次：邮箱在这里**只是档案字段**，不参与身份判断，
 * 没必要为它每次登录都多一个往返。
 */
async function primaryEmail(user: GithubUser, accessToken: string): Promise<string | null> {
  if (user.email) return user.email
  try {
    const emails = await callApi<GithubEmail[]>(EMAILS_URL, accessToken)
    // 主邮箱只是排序偏好，没有「主要且已验证」的那条时任何一条已验证的都行
    return (
      emails.find((row) => row.primary && row.verified)?.email ??
      emails.find((row) => row.verified)?.email ??
      null
    )
  } catch (err) {
    console.warn('[auth] 读取 GitHub 邮箱失败，本次登录不带邮箱', err)
    return null
  }
}

export interface GithubClientConfig {
  clientId: string
  clientSecret: string
  scope: string
}

export type GithubClient = ReturnType<typeof createGithubClient>

/** `getConfig` 每次用到时才调：调用方的配置可能晚于这个实例建好 */
export function createGithubClient(getConfig: () => GithubClientConfig) {
  async function exchangeToken(code: string, redirectUri: string): Promise<string> {
    const { clientId, clientSecret } = getConfig()
    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          // GitHub 也要求和授权那一步一致
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      })
    } catch (err) {
      throw new OidcError('连不上 GitHub 的 token 端点', { retryable: true, cause: err })
    }

    const payload = (await res.json().catch(() => null)) as GithubTokenResponse | null

    // GitHub 回绝时状态码仍然是 200，错误在 body 里 —— 必须先看 error 字段
    if (payload?.error) {
      throw new OidcError(`GitHub 拒绝了这次授权：${payload.error_description ?? payload.error}`, {
        code: payload.error,
        retryable: false,
      })
    }
    if (!res.ok || !payload?.access_token) {
      throw new OidcError(`GitHub token 端点返回异常（HTTP ${res.status}）`, {
        retryable: res.status >= 500,
      })
    }
    return payload.access_token
  }

  return {
    authorizationUrl(input: { state: string; redirectUri: string }) {
      const { clientId, scope } = getConfig()
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('scope', scope)
      url.searchParams.set('state', input.state)
      // 这是个内部系统，别在授权页上引导人去注册 GitHub
      url.searchParams.set('allow_signup', 'false')
      return url.toString()
    },

    /** code 换 token + 读身份。token 不过期也换不了新的，所以这里只给 access_token，到期时间归调用方 */
    async exchange(input: {
      code: string
      redirectUri: string
    }): Promise<{ profile: ProviderProfile; accessToken: string }> {
      const accessToken = await exchangeToken(input.code, input.redirectUri)
      const user = await callApi<GithubUser>(USER_URL, accessToken)
      if (typeof user.id !== 'number') throw new OidcError('GitHub 返回的用户信息里没有 id')

      return {
        profile: {
          subject: String(user.id),
          issuer: GITHUB_ISSUER,
          username: user.login,
          email: await primaryEmail(user, accessToken),
          name: user.name ?? user.login,
          avatarUrl: user.avatar_url,
          // GitHub 上没有本应用的角色概念
          roles: [],
        },
        accessToken,
      }
    },
  }
}
