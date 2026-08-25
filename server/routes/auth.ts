import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { authConfig, authEnabled, keycloakEnabled } from '../config.ts'
import { prisma } from '../db.ts'
import {
  type AuthVariables,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../auth/middleware.ts'
import { randomToken } from '../auth/oidc.ts'
import {
  type AuthProvider,
  defaultProviderId,
  getProvider,
  providerViews,
} from '../auth/providers/index.ts'
import { completeUserProfile } from '../auth/profile.ts'
import { createSession, deleteSessionByToken, toSessionUser } from '../auth/session.ts'
import { safeRedirect } from '../auth/redirect.ts'
import { type LinkFailure, identities } from '../store/identities.ts'

/** 授权请求的有效期：从点「登录」到提供方跳回来 */
const AUTH_REQUEST_TTL = 10 * 60 * 1000

/** 关联流程唯一的落点：确认框只长在设置页上 */
const LINK_RETURN_PATH = '/settings'

function clientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? null
}

function loginPageWithError(message: string) {
  return `/login?error=${encodeURIComponent(message)}`
}

/** 关联失败时给用户的话。三种理由要分开说，因为该做的事完全不同 */
function linkFailureMessage(reason: LinkFailure, label: string) {
  return {
    'already-linked': `这个 ${label} 账号已经关联过了`,
    'provider-occupied': `你已经关联了另一个 ${label} 账号，请先解绑它`,
    taken: `这个 ${label} 账号已经关联到另一个用户，请先用它登录并解绑`,
  }[reason]
}

/** 往一个**站内路径**上补 query（关联的结果要带回设置页） */
function withQuery(path: string, params: Record<string, string>) {
  const url = new URL(path, 'http://internal')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * 起一趟授权：落 `AuthRequest`、把它的 id 写进临时 cookie、返回该跳去哪儿。
 *
 * 登录和「关联账号」走的是**同一条路**，区别只有 `linkUserId` 有没有值 ——
 * 回调那边据此决定是建会话还是绑一条身份。
 */
async function startAuthorization(
  c: Context,
  input: { provider: AuthProvider; redirectTo: string; linkUserId?: string },
) {
  const state = randomToken()
  const nonce = randomToken()
  const codeVerifier = randomToken(64)

  const request = await prisma.authRequest.create({
    data: {
      state,
      nonce,
      codeVerifier,
      provider: input.provider.id,
      linkUserId: input.linkUserId ?? null,
      redirectTo: input.redirectTo,
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
    return await input.provider.authorizationUrl({ state, nonce, codeVerifier })
  } catch (err) {
    await prisma.authRequest.delete({ where: { id: request.id } }).catch(() => undefined)
    console.error(`[auth] 构造 ${input.provider.id} 授权地址失败`, err)
    return null
  }
}

export const auth = new Hono<{ Variables: AuthVariables }>()

  /** 前端启动时问一下：要不要登录、有哪些登录方式 */
  .get('/config', (c) =>
    c.json({
      enabled: authEnabled,
      /** 不带 `?provider=` 时会用哪个 */
      provider: defaultProviderId(),
      /** 登录页 / 设置页要列的那些 */
      providers: providerViews(),
      issuer: keycloakEnabled ? authConfig.issuer : null,
      clientId: keycloakEnabled ? authConfig.clientId : null,
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

  /** 入口：生成 state/nonce/PKCE，落库，然后把浏览器丢给提供方 */
  .get('/login', async (c) => {
    if (!authEnabled) return c.json({ error: '没有配置任何登录方式' }, 503)

    const redirectTo = safeRedirect(c.req.query('redirect'))

    // 已经登录就别再走一遍
    if (c.get('user')) return c.redirect(redirectTo)

    // 不带 ?provider= 就是第一个配齐的（有 Keycloak 时行为和以前完全一样）
    const provider = getProvider(c.req.query('provider') ?? defaultProviderId())
    if (!provider?.enabled) return c.redirect(loginPageWithError('这个登录方式没有启用'))

    const url = await startAuthorization(c, { provider, redirectTo })
    if (!url) return c.redirect(loginPageWithError(`连不上 ${provider.label}，检查服务端配置`))
    return c.redirect(url)
  })

  /**
   * 关联一条新的登录方式。走的是和登录同一套授权流程，
   * 只是 `AuthRequest` 上多带一个 `linkUserId` —— 回调不建会话，改成落一条待确认。
   *
   * **落点写死 `/settings`，不接受 `?redirect=`。** 关联不是登录，没有「你本来想去哪」
   * 这回事；更要紧的是确认框只长在设置页上（`LinkedAccounts.vue`），送去别处就会
   * 留下一条用户看不见、也就没法确认的待关联。少一个参数，少一个陷阱。
   */
  .get('/link/:provider', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const provider = getProvider(c.req.param('provider'))
    if (!provider?.enabled) return c.json({ error: 'Not Found', message: '没有这个登录方式' }, 404)

    const url = await startAuthorization(c, {
      provider,
      redirectTo: LINK_RETURN_PATH,
      linkUserId: user.id,
    })
    if (!url) {
      return c.redirect(withQuery(LINK_RETURN_PATH, { link_error: `连不上 ${provider.label}` }))
    }
    return c.redirect(url)
  })

  /** 回调：只有这一个地址，靠 `AuthRequest.provider` 分发到具体提供方 */
  .get('/callback', async (c) => {
    if (!authEnabled) return c.redirect(loginPageWithError('没有配置任何登录方式'))

    const txId = getCookie(c, authConfig.txCookieName)
    deleteCookie(c, authConfig.txCookieName, { path: '/api/auth', secure: authConfig.secureCookie })

    // 一次性消费：拿到就删，重放同一个 code 不会再有 AuthRequest。
    // **先读它再看 ?error=** —— 用户在提供方那边点了「取消」时，得知道该把人送回
    // 登录页还是设置页，而那个答案只有 AuthRequest 知道
    const request = txId ? await prisma.authRequest.findUnique({ where: { id: txId } }) : null
    if (request) {
      await prisma.authRequest.delete({ where: { id: request.id } }).catch(() => undefined)
    }

    const linking = request?.linkUserId ?? null
    const failed = (message: string) =>
      linking
        ? c.redirect(withQuery(safeRedirect(request?.redirectTo), { link_error: message }))
        : c.redirect(loginPageWithError(message))

    const error = c.req.query('error')
    if (error) return failed(c.req.query('error_description') ?? error)

    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state || !txId) return failed('授权信息不完整')
    // 读不到 AuthRequest = 已经被消费过了（重放），和 state 对不上是同一类问题
    if (!request || request.state !== state) return failed('state 校验失败')
    if (request.expiresAt.getTime() < Date.now()) return failed('登录超时，请重试')

    const provider = getProvider(request.provider)
    if (!provider?.enabled) return failed('这个登录方式没有启用')

    try {
      const { profile, tokens } = await provider.exchange({
        code,
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
      })

      // ---- 关联：**先不写**，暂存起来等用户确认（§3.9.2）
      if (linking) {
        // 中途换了人（另一个标签页登出又登进别的账号）就不能绑了
        if (c.get('user')?.id !== linking) return failed('登录状态已变化，请重新操作')

        // 预检：绑不成的情况别先让用户看一个注定失败的确认框。
        // 真正的判定在确认那一步，这里只是省一次白跑
        const blocked = await identities.checkLink(linking, provider.id, profile.subject)
        if (blocked) return failed(linkFailureMessage(blocked, provider.label))

        await identities.stashPending(linking, provider.id, profile)
        console.log(`[auth] ${linking} 待确认关联 ${provider.id}:${profile.subject}`)
        return c.redirect(safeRedirect(request.redirectTo))
      }

      // ---- 登录
      const account = await identities.resolveLogin(provider.id, profile)
      // 落库之后补一遍缺的档案字段（默认头像之类）。补什么由钩子决定，登录流程不认识它们
      const user = await completeUserProfile(account)

      const token = await createSession({
        user,
        provider: provider.id,
        tokens,
        userAgent: c.req.header('user-agent') ?? null,
        ip: clientIp(c.req.raw.headers),
      })
      setSessionCookie(c, token)

      console.log(`[auth] 登录成功（${provider.id}）：${user.username ?? user.email ?? user.subject}`)
      return c.redirect(safeRedirect(request.redirectTo))
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败'
      console.error('[auth] 回调处理失败', err)
      return failed(message)
    }
  })

  /**
   * 当前用户绑了哪些登录方式，外加**有没有一条在等确认**。
   *
   * 两件事一次拿回来：设置页打开时本来就要问列表，待确认的那条挂在同一个响应上
   * 就不用多一个往返；而且它挂在响应里而不是 URL 上，意味着用户中途关了标签页
   * 再回来，确认框照样会出现。
   */
  .get('/identities', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)
    const [items, pending] = await Promise.all([
      identities.listFor(user.id),
      identities.pendingFor(user.id),
    ])
    return c.json({ items, pending })
  })

  /**
   * 确认关联 —— 到这一步才真的写库。
   *
   * 用 POST 而不是 GET：这是状态变更，而且必须**不能**由一条链接触发。
   */
  .post('/link/confirm', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const result = await identities.confirmPending(user.id)
    if (result.ok) {
      console.log(`[auth] ${user.id} 确认关联 ${result.identity.provider}`)
      return c.json({ identity: result.identity })
    }

    if (result.reason === 'none') {
      return c.json({ error: 'Not Found', message: '没有待确认的关联' }, 404)
    }
    if (result.reason === 'expired') {
      return c.json({ error: 'Gone', message: '确认超时了，请重新发起关联' }, 410)
    }
    // 预检到确认之间局面变了（那条身份被别人绑走之类）
    const message = linkFailureMessage(result.reason, result.label ?? '第三方')
    return c.json({ error: 'Conflict', message }, 409)
  })

  /** 放弃这条待确认的关联 */
  .delete('/link/pending', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)
    await identities.discardPending(user.id)
    return c.body(null, 204)
  })

  /**
   * 解绑。**最后一条不许解**（409）—— 解掉了这个人就再也登不进来，
   * 而这里没有「用邮箱找回」这种兜底。
   */
  .delete('/identities/:id', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized', message: '需要登录' }, 401)

    const result = await identities.unlink(user.id, c.req.param('id'))
    if (result === 'not-found') {
      return c.json({ error: 'Not Found', message: '没有这条登录方式' }, 404)
    }
    if (result === 'last') {
      return c.json({ error: 'Conflict', message: '至少要保留一种登录方式' }, 409)
    }
    return c.body(null, 204)
  })

  /**
   * 登出：**只退本站**。
   *
   * 清掉本地会话就结束 —— 既不撤销 refresh token，也不跳 Keycloak 的
   * RP-initiated logout。理由是这套系统只是 Keycloak 上的一个应用：
   * 从这里退出不该顺手把用户在同一个 SSO 下别的应用也踢下线。
   * 代价是明确的：Keycloak 的 SSO cookie 还在，紧接着再点「使用 Keycloak 登录」
   * 会被静默送回同一个账号，看起来像没退出去。
   *
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

    await deleteSessionByToken(readSessionCookie(c))
    clearSessionCookie(c)

    return c.redirect(loginPath)
  })
