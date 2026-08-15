import crypto from 'node:crypto'
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

/** 同一个会话的并发刷新合并成一次，避免 refresh token 轮换后互相踩 */
const refreshing = new Map<string, Promise<LoadedSession | null>>()

/** 按 cookie 里的 token 取会话；access_token 快过期就顺手续一次 */
export async function loadSession(token: string | undefined): Promise<LoadedSession | null> {
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

  const inflight = refreshing.get(id)
  if (inflight) return inflight

  const task = renew(session).finally(() => refreshing.delete(id))
  refreshing.set(id, task)
  return task
}

async function renew(session: LoadedSession): Promise<LoadedSession | null> {
  const canRefresh =
    session.refreshToken &&
    (!session.refreshExpiresAt || session.refreshExpiresAt.getTime() > Date.now())

  if (!canRefresh) {
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

    return { ...updated, user: { ...updated.user, roles: JSON.stringify(roles) } }
  } catch (err) {
    // Keycloak 那边会话已经没了（用户登出/超时/被踢），本地也清掉
    if (err instanceof OidcError) console.warn(`[auth] 刷新会话失败，已注销：${err.message}`)
    else console.error('[auth] 刷新会话异常', err)
    await deleteSessionById(session.id)
    return null
  }
}

export async function deleteSessionById(id: string) {
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
