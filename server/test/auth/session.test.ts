import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSession,
  deleteSessionByToken,
  loadSession,
  sweepExpired,
  toSessionUser,
  upsertUser,
} from '../../auth/session.ts'
import type { User } from '../../generated/prisma/client.ts'
import { createUser, prisma, resetDb } from '../helpers/db.ts'
import {
  CLIENT_ID,
  ISSUER,
  accessTokenWith,
  idTokenClaims,
  stubOidcFetch,
  tokenResponse,
} from '../helpers/oidc.ts'

let stub: ReturnType<typeof stubOidcFetch>

beforeEach(async () => {
  await resetDb()
  stub = stubOidcFetch()
})

/** 只有 SESSION_TTL 是从 env 来的，测试环境固定 1 小时 */
const TTL_MS = 3600 * 1000

const fakeUser = (roles: string): User =>
  ({
    id: 'u1',
    issuer: ISSUER,
    subject: 's1',
    username: 'alice',
    email: 'alice@example.com',
    name: 'Alice',
    avatarUrl: null,
    roles,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  }) as User

describe('toSessionUser()', () => {
  it('把 roles 的 JSON 字符串还原成数组', () => {
    expect(toSessionUser(fakeUser('["admin","user"]')).roles).toEqual(['admin', 'user'])
  })

  it.each([
    ['不是合法 JSON', 'not json'],
    ['是对象不是数组', '{"a":1}'],
    ['是 null', 'null'],
    ['空字符串', ''],
  ])('roles %s → 退化成空数组，不炸', (_label, roles) => {
    expect(toSessionUser(fakeUser(roles)).roles).toEqual([])
  })

  it('数组里的非字符串项被过滤掉', () => {
    expect(toSessionUser(fakeUser('["admin",1,null,"user"]')).roles).toEqual(['admin', 'user'])
  })

  it('只暴露该给前端的字段，绝不带 token', async () => {
    const user = await createUser({ roles: ['admin'] })
    const dto = toSessionUser(user)

    expect(Object.keys(dto).sort()).toEqual(
      ['avatarUrl', 'email', 'id', 'name', 'roles', 'subject', 'username'].sort(),
    )
    expect(JSON.stringify(dto)).not.toContain('token')
  })
})

describe('upsertUser()', () => {
  it('第一次登录建档', async () => {
    const user = await upsertUser(idTokenClaims(), ['admin'])

    expect(user).toMatchObject({
      issuer: ISSUER,
      subject: 'user-1',
      username: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      roles: '["admin"]',
    })
    expect(user.lastLoginAt).toBeInstanceOf(Date)
  })

  it('(issuer, subject) 相同就是同一个人，只更新档案', async () => {
    const first = await upsertUser(idTokenClaims(), ['user'])
    const second = await upsertUser(
      idTokenClaims({ preferred_username: 'alice2', email: 'a2@example.com' }),
      ['admin'],
    )

    expect(second.id).toBe(first.id)
    expect(second.username).toBe('alice2')
    expect(second.roles).toBe('["admin"]')
    expect(await prisma.user.count()).toBe(1)
  })

  it('换了 realm（issuer 不同）就是另一个人', async () => {
    await upsertUser(idTokenClaims(), [])
    await upsertUser(idTokenClaims({ iss: 'https://kc.test/realms/other' }), [])

    expect(await prisma.user.count()).toBe(2)
  })

  it('没有 name 时退回 preferred_username', async () => {
    const user = await upsertUser(idTokenClaims({ name: undefined }), [])
    expect(user.name).toBe('alice')
  })

  it('picture 不是字符串就存 null', async () => {
    const user = await upsertUser(idTokenClaims({ picture: { url: 'x' } }), [])
    expect(user.avatarUrl).toBeNull()
  })

  it('picture 是字符串就存下来', async () => {
    const user = await upsertUser(idTokenClaims({ picture: 'https://cdn/a.png' }), [])
    expect(user.avatarUrl).toBe('https://cdn/a.png')
  })
})

describe('createSession() / loadSession()', () => {
  it('cookie 里的 token 不等于库里的主键（库被拖走也伪造不出 cookie）', async () => {
    const user = await createUser()
    const token = await createSession({ user, tokens: tokenResponse(), claims: idTokenClaims() })

    const row = await prisma.session.findFirstOrThrow()
    expect(row.id).not.toBe(token)
    expect(row.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('用 token 能取回会话和用户', async () => {
    const user = await createUser({ roles: ['admin'] })
    const token = await createSession({
      user,
      tokens: tokenResponse(),
      claims: idTokenClaims(),
      userAgent: 'vitest',
      ip: '10.0.0.1',
    })

    const session = await loadSession(token)
    expect(session?.user.id).toBe(user.id)
    expect(session?.userAgent).toBe('vitest')
    expect(session?.ip).toBe('10.0.0.1')
    expect(session?.sessionState).toBe('kc-session-1')
  })

  it('expires_in / refresh_expires_in 换算成过期时刻', async () => {
    const user = await createUser()
    const before = Date.now()
    await createSession({
      user,
      tokens: tokenResponse({ expiresIn: 300, refreshExpiresIn: 1800 }),
      claims: idTokenClaims(),
    })

    const row = await prisma.session.findFirstOrThrow()
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000)
    expect(row.refreshExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + 1_800_000)
  })

  it('没给 refresh_expires_in 时 refreshExpiresAt 为 null', async () => {
    const user = await createUser()
    const tokens = { ...tokenResponse(), refresh_expires_in: undefined }
    await createSession({ user, tokens, claims: idTokenClaims() })

    expect((await prisma.session.findFirstOrThrow()).refreshExpiresAt).toBeNull()
  })

  it.each([
    ['没有 token', undefined],
    ['token 是瞎编的', 'made-up-token'],
  ])('%s → null', async (_label, token) => {
    await expect(loadSession(token)).resolves.toBeNull()
  })

  it('会话活得超过 SESSION_TTL 就作废并删掉（不能无限续）', async () => {
    const user = await createUser()
    const token = await createSession({ user, tokens: tokenResponse(), claims: idTokenClaims() })
    await prisma.session.updateMany({ data: { createdAt: new Date(Date.now() - TTL_MS - 1000) } })

    await expect(loadSession(token)).resolves.toBeNull()
    expect(await prisma.session.count()).toBe(0)
  })

  it('access_token 还有 30 秒以上就不去打扰 Keycloak', async () => {
    const user = await createUser()
    const token = await createSession({
      user,
      tokens: tokenResponse({ expiresIn: 300 }),
      claims: idTokenClaims(),
    })

    await loadSession(token)
    expect(stub.tokenCalls()).toBe(0)
  })
})

describe('loadSession() 自动续期', () => {
  async function sessionAboutToExpire(roles: string[] = ['user']) {
    const user = await createUser({ roles })
    const token = await createSession({
      user,
      // 只剩 10 秒 → 低于 30 秒阈值，取会话时应该顺手续一次
      tokens: tokenResponse({ expiresIn: 10 }),
      claims: idTokenClaims(),
    })
    return { user, token }
  }

  it('快过期时自动刷新，并写回新的 token 和过期时间', async () => {
    const { token } = await sessionAboutToExpire()
    stub.token = { status: 200, body: tokenResponse({ expiresIn: 600, refreshToken: 'refresh-2' }) }

    const session = await loadSession(token)

    expect(stub.tokenCalls()).toBe(1)
    expect(session?.refreshToken).toBe('refresh-2')
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 500_000)
  })

  it('刷新时顺便同步 Keycloak 侧改过的角色', async () => {
    const { user, token } = await sessionAboutToExpire(['user'])
    stub.token = {
      status: 200,
      body: tokenResponse({ expiresIn: 600, roles: { realm: ['admin'], client: ['ops'] } }),
    }

    const session = await loadSession(token)

    expect(toSessionUser(session!.user).roles).toEqual(['admin', `${CLIENT_ID}:ops`])
    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(persisted.roles).toBe(JSON.stringify(['admin', `${CLIENT_ID}:ops`]))
  })

  it('并发取同一个会话只刷新一次（refresh token 轮换不会互相踩）', async () => {
    const { token } = await sessionAboutToExpire()
    stub.token = { status: 200, body: tokenResponse({ expiresIn: 600 }) }

    const results = await Promise.all([loadSession(token), loadSession(token), loadSession(token)])

    expect(stub.tokenCalls()).toBe(1)
    expect(results.every((r) => r !== null)).toBe(true)
  })

  it('Keycloak 侧会话没了（刷新失败）→ 本地会话也删掉', async () => {
    const { token } = await sessionAboutToExpire()
    stub.token = { status: 400, body: { error: 'invalid_grant' } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(loadSession(token)).resolves.toBeNull()
    expect(await prisma.session.count()).toBe(0)
  })

  it('压根没有 refresh_token → 直接作废，不去打 token 端点', async () => {
    const user = await createUser()
    const token = await createSession({
      user,
      tokens: tokenResponse({ expiresIn: 10, refreshToken: null }),
      claims: idTokenClaims(),
    })

    await expect(loadSession(token)).resolves.toBeNull()
    expect(stub.tokenCalls()).toBe(0)
    expect(await prisma.session.count()).toBe(0)
  })

  it('refresh_token 自己也过期了 → 直接作废', async () => {
    const user = await createUser()
    const token = await createSession({
      user,
      tokens: tokenResponse({ expiresIn: 10 }),
      claims: idTokenClaims(),
    })
    await prisma.session.updateMany({ data: { refreshExpiresAt: new Date(Date.now() - 1000) } })

    await expect(loadSession(token)).resolves.toBeNull()
    expect(stub.tokenCalls()).toBe(0)
  })

  it('刷新响应里没带新的 refresh_token 就沿用旧的', async () => {
    const { token } = await sessionAboutToExpire()
    stub.token = {
      status: 200,
      body: { ...tokenResponse({ expiresIn: 600 }), refresh_token: undefined },
    }

    const session = await loadSession(token)
    expect(session?.refreshToken).toBe('refresh-1')
  })
})

describe('deleteSessionByToken()', () => {
  it('删掉并返回被删的那条', async () => {
    const user = await createUser()
    const token = await createSession({ user, tokens: tokenResponse(), claims: idTokenClaims() })

    const deleted = await deleteSessionByToken(token)

    expect(deleted?.idToken).toBeTruthy()
    expect(await prisma.session.count()).toBe(0)
  })

  it.each([
    ['没有 token', undefined],
    ['token 不存在', 'nope'],
  ])('%s → null，也不会误删别人的会话', async (_label, token) => {
    const user = await createUser()
    await createSession({ user, tokens: tokenResponse(), claims: idTokenClaims() })

    await expect(deleteSessionByToken(token)).resolves.toBeNull()
    expect(await prisma.session.count()).toBe(1)
  })
})

describe('sweepExpired()', () => {
  it('清掉超时的会话和没用掉的授权请求，返回条数', async () => {
    const user = await createUser()
    const liveToken = await createSession({
      user,
      tokens: tokenResponse(),
      claims: idTokenClaims(),
    })
    // 再造一条「很久以前建的」会话
    const staleToken = await createSession({
      user,
      tokens: tokenResponse(),
      claims: idTokenClaims(),
    })
    const staleId = (await prisma.session.findMany()).map((s) => s.id).filter((id) => id)[1]
    await prisma.session.update({
      where: { id: staleId },
      data: { createdAt: new Date(Date.now() - TTL_MS - 1000) },
    })

    await prisma.authRequest.create({
      data: {
        state: 'expired',
        nonce: 'n',
        codeVerifier: 'v',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    await prisma.authRequest.create({
      data: {
        state: 'fresh',
        nonce: 'n',
        codeVerifier: 'v',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const result = await sweepExpired()

    expect(result).toEqual({ sessions: 1, authRequests: 1 })
    await expect(loadSession(liveToken)).resolves.not.toBeNull()
    await expect(loadSession(staleToken)).resolves.toBeNull()
    expect(await prisma.authRequest.count()).toBe(1)
  })

  it('没东西可清时返回 0', async () => {
    await expect(sweepExpired()).resolves.toEqual({ sessions: 0, authRequests: 0 })
  })
})

describe('access_token 的角色解析（与会话联动）', () => {
  it('登录时把 realm/client 角色一起落到 User.roles', async () => {
    const claims = idTokenClaims()
    const { rolesFromAccessToken } = await import('../../auth/oidc.ts')
    const roles = rolesFromAccessToken(accessTokenWith({ realm: ['user'], client: ['editor'] }))

    const user = await upsertUser(claims, roles)
    expect(toSessionUser(user).roles).toEqual(['user', `${CLIENT_ID}:editor`])
  })
})
