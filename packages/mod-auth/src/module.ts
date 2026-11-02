import crypto from 'node:crypto'
import { LOGIN_DONE_PATH, LOGIN_PATH } from '@shadecn/shared/auth'
import { displayNameOf } from '@shadecn/server-kit/identity'
import { defineModule } from '@shadecn/server-kit/kernel'
import { AUTH_SERVICE, type PlatformAuth } from '@shadecn/server-kit/platform'
import { AUTH_MODULE, authConfigSection } from './config.ts'
import { currentUserId } from './current-user.ts'
import { AuthRequest, PendingLink, Session, UserIdentity } from './entities.ts'
import { loginDoneRoutes, loginPageRoutes, pageGuard } from './guard.ts'
import { requireAuth, withSession } from './middleware.ts'
import { enabledProviders } from './providers/index.ts'
import { auth as authRoutes } from './routes/auth.ts'
import { avatars } from './routes/avatars.ts'
import { loadSession, sweepExpired } from './session.ts'
import { authConfig, authEnabled, configureAuthSettings } from './settings.ts'

/** 从一个 cookie 头里取某个 cookie */
function cookieValue(header: string | null | undefined, name: string) {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

const derived = new Map<string, string>()

/**
 * 平台的 `auth`（`@shadecn/server-kit/platform`）—— 底座管线的会话解析、登录闸门、页面守卫，和模块们的「这个请求是谁」都转到这里。
 */
const provider: PlatformAuth = {
  get enabled() {
    return authEnabled
  },
  userId: currentUserId,
  async identify(cookieHeader, options = {}) {
    if (!authEnabled) return null
    const session = await loadSession(cookieValue(cookieHeader, authConfig.cookieName), { refresh: options.refresh })
    if (!session) return null
    return { id: session.user.id, name: displayNameOf(session.user), avatarUrl: session.user.avatarUrl }
  },
  session: withSession,
  requireUser: requireAuth,
  pageGuard: pageGuard as PlatformAuth['pageGuard'],
  deriveSecret(purpose) {
    let value = derived.get(purpose)
    if (value === undefined) {
      // 域分隔：同一把 MODULES_AUTH_SESSION_SECRET 派生出另一把，会话 cookie 的 HMAC 和派生出的签名互不通用
      value = authConfig.secret
        ? crypto.createHmac('sha256', authConfig.secret).update(purpose).digest('hex')
        : crypto.randomBytes(32).toString('hex')
      derived.set(purpose, value)
    }
    return value
  },
}

/**
 * 登录模块（REQ-AUTH，docs/05、docs/28 §3.1）：登录流程（Keycloak OIDC / GitHub OAuth）、会话、身份绑定、默认头像、
 * 页面守卫和登录页的两条路由、没配登录时的本地开发用户。
 *
 * - **向平台提供 `auth`**（`provides: [AUTH_SERVICE]`）：底座管线的会话解析 / 登录闸门 / 页面守卫、各模块的 `ctx.platform.auth` 都转到这里；
 * - 随所有角色加载：协同握手要认人（`identify`），web 上的接口要知道是谁；登录接口和页面只归 web；
 * - 过期会话和没用掉的授权请求：web 角色上启动清一次，之后每小时清一次。
 *
 * `User` 表是平台的（`@shadecn/server-kit/identity`，所有模块的外键目标），这里是身份绑定、会话、授权请求、待确认关联四张。
 */
export default defineModule({
  name: AUTH_MODULE,
  roles: ['web', 'collab', 'agent'],
  provides: [AUTH_SERVICE],
  config: authConfigSection,
  entities: [UserIdentity, Session, PendingLink, AuthRequest],
  routes: [
    // 登录流程自己当然不能要求先登录
    { path: '/api/auth', role: 'web', access: 'public' },
    { path: '/api/avatars', role: 'web', access: 'user' },
    // 两个页面：access 只管 /api 的登录闸门，页面由 pageGuard 守（登录页匿名放行，终点站要登录）
    { path: LOGIN_PATH, role: 'web', access: 'public' },
    { path: LOGIN_DONE_PATH, role: 'web', access: 'public' },
  ],
  setup(ctx) {
    configureAuthSettings(ctx.config)
    ctx.provide(AUTH_SERVICE, provider)

    ctx.http.route('/api/auth', authRoutes)
    ctx.http.route('/api/avatars', avatars)
    ctx.http.route(LOGIN_PATH, loginPageRoutes)
    ctx.http.route(LOGIN_DONE_PATH, loginDoneRoutes)

    if (!ctx.roles.has('web')) return
    const providers = enabledProviders().map((item) => item.label)
    console.log(`[auth] 登录 ${authEnabled ? `${providers.join(' / ')}（${LOGIN_PATH}）` : '未启用'}`)

    const sweep = () => {
      void sweepExpired()
        .then(({ sessions, authRequests, pendingLinks }) => {
          if (sessions || authRequests || pendingLinks) {
            console.log(`[auth] 清理过期数据：会话 ${sessions} 条，授权请求 ${authRequests} 条，待确认关联 ${pendingLinks} 条`)
          }
        })
        .catch((err: unknown) => console.error('[auth] 清理过期数据失败', err))
    }
    sweep()
    const timer = setInterval(sweep, 60 * 60 * 1000)
    timer.unref()
    return {
      shutdown() {
        clearInterval(timer)
      },
    }
  },
})
