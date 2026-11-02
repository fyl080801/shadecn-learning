import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common'
import { LOGIN_OPTIONS, type ResolvedLoginOptions } from './auth-options.js'
import { AuthProviders } from './auth-providers.js'
import { describeError, loginFailureMessage } from './errors.js'
import { LOGIN_DONE_PATH, renderLoginDonePage } from './login-done-page.js'
import { AUTH_REQUEST_TTL_SECONDS, LoginService } from './login.service.js'
import { pickOrigin } from './oauth/index.js'
import { type ResolvedSessionOptions, SESSION_OPTIONS } from './options.js'
import { Public } from './public.decorator.js'
import { safeRedirect } from './redirect.js'
import { toSessionUser } from './session-token.js'
import { readCookie, type SessionRequest } from './session.guard.js'
import { SessionService } from './session.service.js'

interface HttpRequest extends SessionRequest {
  /** Fastify：直连时看连接本身，开了 trustProxy 才看 X-Forwarded-Proto。只用来给 Host 补 scheme，Secure 看白名单判定出的 origin */
  protocol?: string
}

interface HttpReply {
  header(name: string, value: string | string[]): this
  code(statusCode: number): this
  send(payload?: string): unknown
}

/** 授权过程中的临时 cookie：`AuthRequest` 的 id，只有 `/api/auth` 下用得到 */
const TX_COOKIE = 'oidc_tx'
const TX_COOKIE_PATH = '/api/auth'

/**
 * 登录窗口的落点。前端（`packages/shared/src/auth.ts`）让它落在 `LOGIN_DONE_PATH`，但那个路径不是后端路由：
 * dev 下 Vite 在路由匹配之前就答完了 `/api` 以外的所有请求，static 下它是受保护的 HTML 回退。
 * 所以在跳转时换成 `/api` 下的同一张页面，两种模式都走得到。
 */
const LOGIN_DONE_ROUTE = '/api/auth/login-done'
const afterLogin = (redirectTo: string) => (redirectTo === LOGIN_DONE_PATH ? LOGIN_DONE_ROUTE : redirectTo)

function headerValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
}

const queryValue = (value: unknown) => (typeof value === 'string' && value ? value : null)

/**
 * 前端依赖的登录端点，形状以 `apps/web/src/lib/auth.ts` 和 `LoginPage.vue` 读取的为准。账号关联（link、identities）不在这里。
 * 路径固定：前端写死了 `/api/auth/*`。全部匿名可达。
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SESSION_OPTIONS) private readonly options: ResolvedSessionOptions,
    @Inject(LOGIN_OPTIONS) private readonly loginOptions: ResolvedLoginOptions,
    @Inject(AuthProviders) private readonly providers: AuthProviders,
    @Inject(LoginService) private readonly login: LoginService,
  ) {}

  /** 这次请求认哪个对外地址：只在白名单内跟着请求走，绝不盲信 Host */
  private originOf(request: HttpRequest): string {
    const { headers } = request
    const { origins } = this.loginOptions
    return pickOrigin(
      {
        origin: headerValue(headers.origin),
        forwardedProto: headerValue(headers['x-forwarded-proto']),
        forwardedHost: headerValue(headers['x-forwarded-host']),
        host: headerValue(headers.host),
        protocol: request.protocol,
      },
      origins,
      origins[0],
    )
  }

  /**
   * Secure 按这次的 origin 算（`.claude/rules/auth.md`）：http 下带 Secure 的 Set-Cookie 会被浏览器丢弃，
   * https 下漏了是白丢一层保护。不看 `request.protocol`：没开 trustProxy 时它看不到反代前面的 https。
   */
  private cookie(name: string, value: string, options: { path: string; maxAge: number; origin: string }): string {
    const secure = options.origin.startsWith('https://') ? '; Secure' : ''
    return `${name}=${value}; Path=${options.path}; HttpOnly; SameSite=Lax; Max-Age=${options.maxAge}${secure}`
  }

  private clearSessionCookie(request: HttpRequest): string {
    return this.cookie(this.options.cookieName, '', { path: '/', maxAge: 0, origin: this.originOf(request) })
  }

  private redirect(reply: HttpReply, location: string, cookies: string[] = []) {
    if (cookies.length > 0) reply.header('set-cookie', cookies)
    return reply.code(302).header('location', location).header('cache-control', 'no-store').send()
  }

  /** 失败回登录页显示原因。带上 `redirect`：在那里重试之后还能回到原处（登录窗口里也还是落到 login-done） */
  private loginPageWithError(message: string, redirectTo = '/') {
    const redirect = redirectTo === '/' ? '' : `&redirect=${encodeURIComponent(redirectTo)}`
    return `${this.loginOptions.loginPath}?error=${encodeURIComponent(message)}${redirect}`
  }

  /** 当前登录态，始终 200。`enabled: true` 表示闸门开着：前端靠它决定 401 时弹重新登录、首屏未登录时去登录页 */
  @Public()
  @Get('me')
  async me(@Req() request: HttpRequest, @Res({ passthrough: true }) reply: HttpReply) {
    const token = readCookie(request.headers.cookie, this.options.cookieName)
    const session = await this.sessions.load(token)
    reply.header('cache-control', 'no-store')
    // cookie 还在但会话已经没了（过期 / 被登出）
    if (token && !session) reply.header('set-cookie', this.clearSessionCookie(request))
    return { enabled: true, authenticated: Boolean(session), user: session ? toSessionUser(session.user) : null }
  }

  /** 登录页要的。`enabled: false`：现在没有任何登录方式，页面如实显示「登录不可用」，而不是一个没有按钮的登录框 */
  @Public()
  @Get('config')
  config() {
    return {
      enabled: this.providers.list.length > 0,
      providers: this.providers.list.map(({ id, label, buttonLabel }) => ({ id, label, buttonLabel })),
    }
  }

  /** 入口：生成 state / nonce / PKCE，落库，把浏览器丢给提供方。不带 `?provider=` 用第一个（弹窗重新登录就不带） */
  @Public()
  @Get('login')
  async startLogin(
    @Req() request: HttpRequest,
    @Query('provider') providerId: unknown,
    @Query('redirect') redirect: unknown,
    @Res() reply: HttpReply,
  ) {
    const redirectTo = safeRedirect(redirect)
    // 已经登录就别再走一遍
    if (await this.sessions.load(readCookie(request.headers.cookie, this.options.cookieName))) {
      return this.redirect(reply, afterLogin(redirectTo))
    }

    if (this.providers.list.length === 0) {
      return this.redirect(reply, this.loginPageWithError('没有配置任何登录方式', redirectTo))
    }
    const provider = providerId === undefined ? this.providers.list[0] : this.providers.get(providerId)
    if (!provider) return this.redirect(reply, this.loginPageWithError('这个登录方式没有启用', redirectTo))

    // 从哪个域名进来的就回到哪个域名（白名单之外回落默认），否则会话 cookie 种到另一个域名上
    const origin = this.originOf(request)
    const started = await this.login.begin(provider, redirectTo, origin)
    if (!started) {
      return this.redirect(reply, this.loginPageWithError(`连不上 ${provider.label}，检查服务端配置`, redirectTo))
    }
    return this.redirect(reply, started.url, [
      this.cookie(TX_COOKIE, started.txId, { path: TX_COOKIE_PATH, maxAge: AUTH_REQUEST_TTL_SECONDS, origin }),
    ])
  }

  /** 回调：只有这一个地址，靠 `AuthRequest.provider` 分发到具体提供方 */
  @Public()
  @Get('callback')
  async callback(
    @Req() request: HttpRequest,
    @Query() query: Record<string, unknown>,
    @Res() reply: HttpReply,
  ) {
    const clearTx = this.cookie(TX_COOKIE, '', { path: TX_COOKIE_PATH, maxAge: 0, origin: this.originOf(request) })
    const txId = readCookie(request.headers.cookie, TX_COOKIE)
    // 先消费再看别的：不管这一趟成不成，这个授权请求都不能再用第二次
    const authRequest = await this.login.consume(txId)
    const failed = (message: string) =>
      this.redirect(reply, this.loginPageWithError(message, authRequest ? safeRedirect(authRequest.redirectTo) : '/'), [clearTx])

    // 用户在提供方那边点了取消之类。原因来自 URL，只显示（登录页转义），不进日志
    const error = queryValue(query.error)
    if (error) return failed((queryValue(query.error_description) ?? error).slice(0, 300))

    const code = queryValue(query.code)
    const state = queryValue(query.state)
    if (!code || !state || !txId) return failed('授权信息不完整')
    // 读不到 AuthRequest = 已经被消费过了（重放），和 state 对不上是同一类问题
    if (!authRequest || authRequest.state !== state) return failed('state 校验失败')
    if (authRequest.expiresAt.getTime() < Date.now()) return failed('登录超时，请重试')

    const provider = this.providers.get(authRequest.provider)
    if (!provider) return failed('这个登录方式没有启用')

    try {
      const token = await this.login.complete(provider, authRequest, code, {
        userAgent: headerValue(request.headers['user-agent']),
        ip: headerValue(request.headers['x-forwarded-for'])?.split(',')[0]?.trim() ?? null,
      })
      return this.redirect(reply, afterLogin(safeRedirect(authRequest.redirectTo)), [
        clearTx,
        // 用存下来的 origin：浏览器此刻就在授权时的那个域名上
        this.cookie(this.options.cookieName, token, {
          path: '/',
          maxAge: Math.floor(this.options.ttlSeconds),
          origin: authRequest.origin,
        }),
      ])
    } catch (err) {
      console.error(`[session] 登录回调失败（${provider.id}）：${describeError(err)}`)
      return failed(loginFailureMessage(err))
    }
  }

  /** 登录窗口的终点站，见 {@link LOGIN_DONE_ROUTE}。自包含的 HTML：通知开它的那一页，然后关掉自己 */
  @Public()
  @Get('login-done')
  loginDone(@Res() reply: HttpReply) {
    return reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(renderLoginDonePage())
  }

  /** 前端是整页跳转。`redirect` 是「退出时人在哪」，接到登录页的 `?redirect=` 上，重新登录后回到原处 */
  @Public()
  @Get('logout')
  async logout(@Req() request: HttpRequest, @Query('redirect') redirect: unknown, @Res() reply: HttpReply) {
    await this.sessions.deleteByToken(readCookie(request.headers.cookie, this.options.cookieName))
    const location = redirect
      ? `${this.loginOptions.loginPath}?redirect=${encodeURIComponent(safeRedirect(redirect))}`
      : this.loginOptions.loginPath
    return this.redirect(reply, location, [this.clearSessionCookie(request)])
  }
}
