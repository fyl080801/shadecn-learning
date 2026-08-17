import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { appOrigin, authConfig, authEnabled } from '../config.ts'
import { prisma } from '../db.ts'
import {
  type AuthVariables,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../auth/middleware.ts'
import {
  buildAuthorizationUrl,
  buildLogoutUrl,
  codeChallengeOf,
  exchangeCode,
  randomToken,
  revokeRefreshToken,
  rolesFromAccessToken,
  verifyIdToken,
} from '../auth/oidc.ts'
import {
  createSession,
  deleteSessionByToken,
  toSessionUser,
  upsertUser,
} from '../auth/session.ts'
import { safeRedirect } from '../auth/redirect.ts'

/** 授权请求的有效期：从点「登录」到 Keycloak 跳回来 */
const AUTH_REQUEST_TTL = 10 * 60 * 1000

function clientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? null
}

function loginPageWithError(message: string) {
  return `/login?error=${encodeURIComponent(message)}`
}

export const auth = new Hono<{ Variables: AuthVariables }>()

  /** 前端启动时问一下：要不要登录、登录入口在哪 */
  .get('/config', (c) =>
    c.json({
      enabled: authEnabled,
      provider: 'keycloak',
      issuer: authEnabled ? authConfig.issuer : null,
      clientId: authEnabled ? authConfig.clientId : null,
      loginUrl: '/api/auth/login',
      logoutUrl: '/api/auth/logout',
    }),
  )

  /** 当前登录态。永远 200，前端不用处理异常分支 */
  .get('/me', (c) => {
    const session = c.get('session')
    return c.json({
      enabled: authEnabled,
      authenticated: Boolean(session),
      user: session ? toSessionUser(session.user) : null,
      expiresAt: session?.expiresAt.toISOString() ?? null,
    })
  })

  /** 入口：生成 state/nonce/PKCE，落库，然后把浏览器丢给 Keycloak */
  .get('/login', async (c) => {
    if (!authEnabled) return c.json({ error: '未配置 Keycloak' }, 503)

    const redirectTo = safeRedirect(c.req.query('redirect'))

    // 已经登录就别再走一遍
    if (c.get('user')) return c.redirect(redirectTo)

    const state = randomToken()
    const nonce = randomToken()
    const codeVerifier = randomToken(64)

    const request = await prisma.authRequest.create({
      data: {
        state,
        nonce,
        codeVerifier,
        redirectTo,
        expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL),
      },
    })

    setCookie(c, authConfig.txCookieName, request.id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: authConfig.secureCookie,
      path: '/api/auth',
      maxAge: AUTH_REQUEST_TTL / 1000,
    })

    try {
      return c.redirect(
        await buildAuthorizationUrl({ state, nonce, codeChallenge: codeChallengeOf(codeVerifier) }),
      )
    } catch (err) {
      await prisma.authRequest.delete({ where: { id: request.id } }).catch(() => undefined)
      console.error('[auth] 构造授权地址失败', err)
      return c.redirect(loginPageWithError('连不上 Keycloak，检查 KEYCLOAK_ISSUER'))
    }
  })

  /** Keycloak 回调：校验 state → 换 token → 验 id_token → 建会话 */
  .get('/callback', async (c) => {
    if (!authEnabled) return c.redirect(loginPageWithError('未配置 Keycloak'))

    const txId = getCookie(c, authConfig.txCookieName)
    deleteCookie(c, authConfig.txCookieName, { path: '/api/auth', secure: authConfig.secureCookie })

    const error = c.req.query('error')
    if (error) {
      const detail = c.req.query('error_description') ?? error
      return c.redirect(loginPageWithError(detail))
    }

    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state || !txId) return c.redirect(loginPageWithError('授权信息不完整'))

    // 一次性消费：拿到就删，重放同一个 code 不会再有 AuthRequest
    const request = await prisma.authRequest.findUnique({ where: { id: txId } })
    if (request) await prisma.authRequest.delete({ where: { id: txId } }).catch(() => undefined)

    if (!request || request.state !== state) return c.redirect(loginPageWithError('state 校验失败'))
    if (request.expiresAt.getTime() < Date.now()) {
      return c.redirect(loginPageWithError('登录超时，请重试'))
    }

    try {
      const tokens = await exchangeCode(code, request.codeVerifier)
      if (!tokens.id_token) throw new Error('Keycloak 没返回 id_token，检查 client 的 scope 是否含 openid')

      const claims = await verifyIdToken(tokens.id_token, request.nonce)
      const user = await upsertUser(claims, rolesFromAccessToken(tokens.access_token))

      const token = await createSession({
        user,
        tokens,
        claims,
        userAgent: c.req.header('user-agent') ?? null,
        ip: clientIp(c.req.raw.headers),
      })
      setSessionCookie(c, token)

      console.log(`[auth] 登录成功：${user.username ?? user.email ?? user.subject}`)
      return c.redirect(safeRedirect(request.redirectTo))
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败'
      console.error('[auth] 回调处理失败', err)
      return c.redirect(loginPageWithError(message))
    }
  })

  /**
   * 登出：先清本地会话，再跳 Keycloak 的 end_session 把 SSO cookie 也清掉。
   * 用 GET 是因为这是一次浏览器整页跳转。
   *
   * `?redirect=` 是「退出时人在哪」：最终落在登录页上，作为它的 ?redirect=
   * 带着走，重新登录完人就回到原来那一页，而不是首页。
   */
  .get('/logout', async (c) => {
    const returnTo = c.req.query('redirect')
    const loginPath = returnTo
      ? `/login?redirect=${encodeURIComponent(safeRedirect(returnTo))}`
      : '/login'

    const session = await deleteSessionByToken(readSessionCookie(c))
    clearSessionCookie(c)

    if (!authEnabled) return c.redirect(loginPath)

    if (session?.refreshToken) await revokeRefreshToken(session.refreshToken)

    try {
      return c.redirect(await buildLogoutUrl(session?.idToken, `${appOrigin}${loginPath}`))
    } catch {
      // Keycloak 连不上也不该卡住登出，本地会话已经清了
      return c.redirect(loginPath)
    }
  })
