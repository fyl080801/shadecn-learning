import crypto from 'node:crypto'
import { numberCodec, sharedLock, sharedMap } from '../cluster/index.ts'
import { prisma } from '../db.ts'
import { authConfig, isDev } from '../config.ts'
import type { Session, User } from '../generated/prisma/client.ts'
import {
  type IdTokenClaims,
  type TokenResponse,
  OidcError,
  refreshTokens,
  rolesFromAccessToken,
} from './oidc.ts'

/** 没配 SESSION_SECRET 时 dev 下临时生成一个：重启即所有人掉线 */
const secret =
  authConfig.secret ||
  (() => {
    if (!isDev) throw new Error('[auth] 生产环境必须设置 SESSION_SECRET')
    console.warn('[auth] 未设置 SESSION_SECRET，本次运行用临时密钥（重启后会话全部失效）')
    return crypto.randomBytes(32).toString('hex')
  })()

/**
 * cookie 里是 32 字节随机 token，库里存的是它的 HMAC。
 * 拖库的人拿不到 token 本身，也就伪造不出 cookie。
 */
function tokenId(token: string) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex')
}

/** 返回给前端的用户信息 —— access_token 一类的东西一律不出服务端 */
export interface SessionUser {
  id: string
  subject: string
  username: string | null
  email: string | null
  name: string | null
  avatarUrl: string | null
  roles: string[]
}

export function toSessionUser(user: User): SessionUser {
  let roles: string[] = []
  try {
    const parsed: unknown = JSON.parse(user.roles)
    if (Array.isArray(parsed)) roles = parsed.filter((r): r is string => typeof r === 'string')
  } catch {
    roles = []
  }
  return {
    id: user.id,
    subject: user.subject,
    username: user.username,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    roles,
  }
}

/** 把 id_token 的 claims 落成本地 User（同一个 (issuer, subject) 就是同一个人） */
export async function upsertUser(claims: IdTokenClaims, roles: string[]): Promise<User> {
  const profile = {
    username: claims.preferred_username ?? null,
    email: claims.email ?? null,
    name: claims.name ?? claims.preferred_username ?? null,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
    roles: JSON.stringify(roles),
    lastLoginAt: new Date(),
  }

  return prisma.user.upsert({
    where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } },
    create: { issuer: claims.iss, subject: claims.sub, ...profile },
    update: profile,
  })
}

function expiryFrom(tokens: TokenResponse) {
  const now = Date.now()
  return {
    expiresAt: new Date(now + (tokens.expires_in ?? 60) * 1000),
    refreshExpiresAt: tokens.refresh_expires_in
      ? new Date(now + tokens.refresh_expires_in * 1000)
      : null,
  }
}

export interface CreateSessionInput {
  user: User
  tokens: TokenResponse
  claims: IdTokenClaims
  userAgent?: string | null
  ip?: string | null
}

/** 建会话，返回要写进 cookie 的原始 token */
export async function createSession(input: CreateSessionInput): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url')
  const { expiresAt, refreshExpiresAt } = expiryFrom(input.tokens)

  await prisma.session.create({
    data: {
      id: tokenId(token),
      userId: input.user.id,
      accessToken: input.tokens.access_token,
      refreshToken: input.tokens.refresh_token ?? null,
      idToken: input.tokens.id_token ?? null,
      expiresAt,
      refreshExpiresAt,
      sessionState: input.claims.sid ?? input.tokens.session_state ?? null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    },
  })

  return token
}

export type LoadedSession = Session & { user: User }

/**
 * 同一个会话的并发刷新合并成一次，避免 refresh token 轮换后互相踩。
 *
 * 多副本下这件事更要紧：Keycloak 开了轮换的话，第二个实例拿同一个 refresh token
 * 去换会被判 `invalid_grant`，把一个好端端的会话直接注销掉。所以这里是共享锁，
 * 而不是进程内的 promise 表 —— 抢不到锁的一方等赢家换完，然后重新读一遍库
 * （新 token 那时已经落库了），见 `SharedLock.run` 的 `fallback`。
 */
const refreshLock = sharedLock('session-refresh')

/**
 * 连不上 Keycloak 导致刷新失败后的冷却时刻（会话 id → 可以再试的时间）。
 * 它挂了的时候，别让每个请求都去撞一次超时 —— 多副本下更别让每个**实例**各撞一轮。
 */
const refreshCooldown = sharedMap<number>('session-refresh-cooldown', numberCodec)
const REFRESH_COOLDOWN_MS = 15_000

/** 还有没有可用的 refresh token —— 这一条本地就能判，不用问 Keycloak */
function canRefresh(session: Session) {
  if (!session.refreshToken) return false
  return !session.refreshExpiresAt || session.refreshExpiresAt.getTime() > Date.now()
}

export interface LoadSessionOptions {
  /**
   * access_token 快过期时要不要顺手续一次。默认 true。
   *
   * 传 `false` 的只有一种调用方：**背后没有真实用户动作**的定期复验
   * （协同长连接的成员资格复查，见 `collab/hocuspocus.ts`）。
   * 会话的空闲超时实际掌握在 Keycloak 的 refresh token 手里，而每续一次
   * 就等于把它往后推一次 —— 复验每分钟跑一趟的话，开着标签页不动的人
   * 也永远不会空闲超时，"长连接自己给自己续命"。
   *
   * 只读复验只回答「此刻还有效吗」，续期交给真实的 HTTP 请求 ——
   * 编辑触发的那次视图状态 PATCH 就是干这个的（`src/stores/flow` 的 `noteLocalEdit`）。
   */
  refresh?: boolean
}

/** 按 cookie 里的 token 取会话；access_token 快过期就顺手续一次 */
export async function loadSession(
  token: string | undefined,
  options: LoadSessionOptions = {},
): Promise<LoadedSession | null> {
  if (!token) return null

  const id = tokenId(token)
  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } })
  if (!session) return null

  // 会话本身活得太久也要作废，防止一直续下去
  if (Date.now() - session.createdAt.getTime() > authConfig.ttl * 1000) {
    await deleteSessionById(id)
    return null
  }

  // access_token 还有 30 秒以上就直接用
  if (session.expiresAt.getTime() - Date.now() > 30_000) return session

  // 只读复验：不续期，也就没法靠它把会话续下去。
  // refresh token 还在 = 现在仍然有效（下一次真实请求会去续），没了才是真过期。
  // 这里不删会话：判过期是只读的事，清理留给下一次真实请求的 renew 和 sweepExpired
  if (options.refresh === false) return canRefresh(session) ? session : null

  // 上一次是「连不上 Keycloak」失败的：冷却期内先用着旧会话。
  // refresh token 还在有效期内，等对面缓过来再续就是了
  const retryAt = await refreshCooldown.get(id).catch(() => undefined)
  if (retryAt !== undefined && Date.now() < retryAt && canRefresh(session)) return session

  return refreshLock.run(id, () => renew(session), {
    // 抢不到锁 = 别人正在换。等它换完，重新读一遍库拿新 token；
    // 会话在这期间被判失效（换的时候被 Keycloak 回绝）就会读不到，那也是对的
    fallback: () =>
      prisma.session.findUnique({ where: { id }, include: { user: true } }).catch(() => session),
    ttlMs: 15_000,
  })
}

async function renew(session: LoadedSession): Promise<LoadedSession | null> {
  // refresh token 自己都过期了 —— 这才是「长时间没人操作」的真正超时
  if (!canRefresh(session)) {
    await deleteSessionById(session.id)
    return null
  }

  try {
    const tokens = await refreshTokens(session.refreshToken as string)
    const { expiresAt, refreshExpiresAt } = expiryFrom(tokens)
    const roles = rolesFromAccessToken(tokens.access_token)

    const [updated] = await prisma.$transaction([
      prisma.session.update({
        where: { id: session.id },
        data: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? session.refreshToken,
          idToken: tokens.id_token ?? session.idToken,
          expiresAt,
          refreshExpiresAt,
        },
        include: { user: true },
      }),
      // 角色可能在 Keycloak 侧被改过，刷新时一并同步
      prisma.user.update({ where: { id: session.userId }, data: { roles: JSON.stringify(roles) } }),
    ])

    await refreshCooldown.delete(session.id).catch(() => undefined)
    return { ...updated, user: { ...updated.user, roles: JSON.stringify(roles) } }
  } catch (err) {
    // Keycloak 明确回绝（用户登出 / SSO 会话超时 / 被踢）——本地也清掉
    if (err instanceof OidcError && !err.retryable) {
      console.warn(`[auth] 刷新会话被拒绝（${err.code ?? err.message}），已注销`)
      await deleteSessionById(session.id)
      return null
    }
    // 连不上、超时、对方 5xx、甚至本地写库失败：都没证明凭证失效。
    // 这时候注销，一次网络抖动就能把人踢回登录页 —— 保留会话，等下次请求再续
    console.warn('[auth] 刷新会话暂时失败，保留会话稍后再试', err)
    await refreshCooldown
      .set(session.id, Date.now() + REFRESH_COOLDOWN_MS, REFRESH_COOLDOWN_MS)
      .catch(() => undefined)
    return session
  }
}

export async function deleteSessionById(id: string) {
  await refreshCooldown.delete(id).catch(() => undefined)
  await prisma.session.delete({ where: { id } }).catch(() => undefined)
}

export async function deleteSessionByToken(token: string | undefined) {
  if (!token) return null
  const id = tokenId(token)
  const session = await prisma.session.findUnique({ where: { id } })
  if (session) await deleteSessionById(id)
  return session
}

/** 清掉过期会话和没用掉的授权请求；启动时跑一次，之后定时跑 */
export async function sweepExpired() {
  const now = new Date()
  const [sessions, requests] = await Promise.all([
    prisma.session.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - authConfig.ttl * 1000) } },
    }),
    prisma.authRequest.deleteMany({ where: { expiresAt: { lt: now } } }),
  ])
  return { sessions: sessions.count, authRequests: requests.count }
}
