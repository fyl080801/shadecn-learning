import { vi } from 'vitest'

/**
 * 一个假的 GitHub：token 端点 + `/user` + `/user/emails`，
 * 全部走 vi.stubGlobal('fetch') 拦截，测试里不会有任何真实网络请求。
 *
 * 和 `helpers/oidc.ts` 里那个假 Keycloak 是同一个路数，只是 GitHub 没有
 * discovery 和 JWKS 可打桩 —— 端点是写死的。
 */

export const GITHUB_CLIENT_ID = 'gh-client'
export const GITHUB_CLIENT_SECRET = 'gh-secret'
export const GITHUB_ISSUER = 'https://github.com'

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'
export const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

export interface GithubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

export function githubUser(overrides: Partial<GithubUser> = {}): GithubUser {
  return {
    id: 4242,
    login: 'octocat',
    name: 'Octo Cat',
    email: 'octo@example.com',
    avatar_url: 'https://avatars.test/octocat.png',
    ...overrides,
  }
}

interface StubbedResponse {
  status: number
  body: unknown
  /** 设了就让 fetch 直接抛，模拟连不上 / 超时 */
  throws?: unknown
}

export interface GithubStub {
  /** 按顺序记录所有出站请求 */
  calls: { url: string; body: string | null }[]
  token: StubbedResponse
  user: StubbedResponse
  emails: StubbedResponse
}

export function stubGithubFetch(): GithubStub {
  const stub: GithubStub = {
    calls: [],
    // GitHub 换 token 成功时也是 200 + JSON，失败同样是 200，区别只在 body
    token: { status: 200, body: { access_token: 'gh-token', token_type: 'bearer' } },
    user: { status: 200, body: githubUser() },
    // 只有 /user 没给邮箱时才会用到它，默认空着
    emails: { status: 200, body: [] },
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const body = init?.body
      stub.calls.push({
        url,
        body:
          typeof body === 'string'
            ? body
            : body instanceof URLSearchParams
              ? body.toString()
              : null,
      })

      const picked = url.startsWith(GITHUB_TOKEN_URL)
        ? stub.token
        : url.startsWith(GITHUB_EMAILS_URL)
          ? stub.emails
          : url.startsWith(GITHUB_USER_URL)
            ? stub.user
            : null

      if (!picked) throw new Error(`[test] 未打桩的出站请求：${url}`)
      if (picked.throws !== undefined) throw picked.throws

      return new Response(picked.body === null ? null : JSON.stringify(picked.body), {
        status: picked.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )

  return stub
}
