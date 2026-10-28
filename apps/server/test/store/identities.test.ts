import { beforeEach, describe, expect, it } from 'vitest'
import { identities } from '../../store/identities.ts'
import type { ProviderProfile } from '../../auth/providers/index.ts'
import { createUser, prisma, resetDb } from '../helpers/db.ts'
import { ISSUER } from '../helpers/oidc.ts'

/**
 * 「一个人多条登录方式」的数据规则。
 *
 * 路由层的用例在 routes/auth-github.test.ts；这里只钉三条容易在改动中被抹掉的：
 * 档案只跟主身份走、角色只由 Keycloak 写、最后一条不许解绑。
 */

beforeEach(resetDb)

const GITHUB_ISSUER = 'https://github.com'

function keycloakProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    subject: 'user-1',
    issuer: ISSUER,
    username: 'alice',
    email: 'alice@example.com',
    name: 'Alice',
    avatarUrl: null,
    roles: ['admin'],
    ...overrides,
  }
}

function githubProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    subject: '4242',
    issuer: GITHUB_ISSUER,
    username: 'octocat',
    email: 'octo@example.com',
    name: 'Octo Cat',
    avatarUrl: 'https://avatars.test/octocat.png',
    roles: [],
    ...overrides,
  }
}

/** 建一个 Keycloak 主身份 + 一条已关联的 GitHub */
async function userWithBoth() {
  const user = await identities.resolveLogin('keycloak', keycloakProfile())
  const linked = await identities.link(user.id, 'github', githubProfile())
  if (!linked.ok) throw new Error(`[test] 关联失败：${linked.reason}`)
  return user
}

describe('resolveLogin()', () => {
  it('第一次登录建档，Keycloak 的角色一起落下来', async () => {
    const user = await identities.resolveLogin('keycloak', keycloakProfile())

    expect(user).toMatchObject({ issuer: ISSUER, subject: 'user-1', roles: '["admin"]' })
    expect(user.lastLoginAt).toBeInstanceOf(Date)
  })

  it('同一条身份再登只更新档案，不建第二个号', async () => {
    const first = await identities.resolveLogin('keycloak', keycloakProfile())
    const second = await identities.resolveLogin(
      'keycloak',
      keycloakProfile({ username: 'alice2', roles: ['user'] }),
    )

    expect(second.id).toBe(first.id)
    expect(second.username).toBe('alice2')
    expect(second.roles).toBe('["user"]')
    expect(await prisma.user.count()).toBe(1)
  })

  it('换了 realm（issuer 不同）就是另一个人', async () => {
    await identities.resolveLogin('keycloak', keycloakProfile())
    await identities.resolveLogin(
      'keycloak',
      keycloakProfile({ subject: 'user-2', issuer: 'https://kc.test/realms/other' }),
    )

    expect(await prisma.user.count()).toBe(2)
  })

  it('存量用户（只有 User 行、没有 identity 行）被领养，不会被当成新人再建一个号', async () => {
    const legacy = await createUser({ subject: 'user-1', issuer: ISSUER })

    const user = await identities.resolveLogin('keycloak', keycloakProfile())

    expect(user.id).toBe(legacy.id)
    expect(await prisma.user.count()).toBe(1)
    expect(await prisma.userIdentity.count({ where: { userId: legacy.id } })).toBe(1)
  })

  it('用副身份（GitHub）登录不改显示名 —— 档案只跟主身份走', async () => {
    const user = await userWithBoth()

    await identities.resolveLogin('github', githubProfile())

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.name).toBe('Alice')
    expect(after.username).toBe('alice')
  })

  it('用 GitHub 登录不会把 Keycloak 给的角色清空', async () => {
    const user = await userWithBoth()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roles).toBe(
      '["admin"]',
    )

    // GitHub 那边的 roles 永远是空数组，照写就等于每次登录都把人降级
    await identities.resolveLogin('github', githubProfile())

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).roles).toBe(
      '["admin"]',
    )
  })
})

/**
 * **身份只认 `(provider, subject)`，永远不认邮箱。**
 *
 * 这一组是防回归用的：默认立场是「不同的人」，合并只发生在有人拿目标账号自己的
 * 凭据证明过自己时（也就是设置页的手动关联）。哪天有人想加一条「邮箱一样就合」
 * 的捷径，这几条会先红。
 */
describe('resolveLogin() 不按邮箱认定身份', () => {
  const SAME = 'same@example.com'

  it('邮箱相同也是两个独立账号', async () => {
    const first = await identities.resolveLogin('keycloak', keycloakProfile({ email: SAME }))
    const second = await identities.resolveLogin('github', githubProfile({ email: SAME }))

    expect(second.id).not.toBe(first.id)
    expect(await prisma.user.count()).toBe(2)
    // 各自只有自己那一条身份，谁也没被绑到对方名下
    expect(await identities.listFor(first.id)).toHaveLength(1)
    expect(await identities.listFor(second.id)).toHaveLength(1)
  })

  it('存量用户的邮箱撞上新登录的也不会被认成同一个人', async () => {
    const legacy = await createUser({ subject: 'legacy', issuer: ISSUER, email: SAME })
    await identities.listFor(legacy.id)

    const fresh = await identities.resolveLogin('github', githubProfile({ email: SAME }))

    expect(fresh.id).not.toBe(legacy.id)
    expect(await prisma.user.count()).toBe(2)
  })

  it('两条身份都没有邮箱时同样各建各的', async () => {
    await identities.resolveLogin('keycloak', keycloakProfile({ email: null }))
    await identities.resolveLogin('github', githubProfile({ email: null }))

    expect(await prisma.user.count()).toBe(2)
  })
})

describe('link()', () => {
  it('同一个第三方账号重复关联到自己 → already-linked', async () => {
    const user = await userWithBoth()
    const again = await identities.link(user.id, 'github', githubProfile())

    expect(again).toEqual({ ok: false, reason: 'already-linked' })
  })

  it('已经绑了这个提供方的另一个账号 → provider-occupied', async () => {
    const user = await userWithBoth()
    const other = await identities.link(user.id, 'github', githubProfile({ subject: '9999' }))

    expect(other).toEqual({ ok: false, reason: 'provider-occupied' })
  })

  it('这个第三方账号绑在别人身上 → taken', async () => {
    await userWithBoth()
    const someoneElse = await identities.resolveLogin(
      'keycloak',
      keycloakProfile({ subject: 'user-2' }),
    )

    const result = await identities.link(someoneElse.id, 'github', githubProfile())
    expect(result).toEqual({ ok: false, reason: 'taken' })
  })

  it('存量用户关联第二条时先把主身份补出来，两条都在账上', async () => {
    const legacy = await createUser({ subject: 'user-1', issuer: ISSUER })

    const result = await identities.link(legacy.id, 'github', githubProfile())

    expect(result.ok).toBe(true)
    const rows = await identities.listFor(legacy.id)
    expect(rows.map((row) => row.provider).sort()).toEqual(['github', 'keycloak'])
    expect(rows.find((row) => row.primary)?.provider).toBe('keycloak')
  })
})

describe('listFor()', () => {
  it('存量用户在读列表时被回填出主身份（不需要迁移脚本）', async () => {
    const legacy = await createUser({ subject: 'user-1', issuer: ISSUER })
    expect(await prisma.userIdentity.count()).toBe(0)

    const rows = await identities.listFor(legacy.id)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'keycloak', label: 'Keycloak', primary: true })
    expect(await prisma.userIdentity.count()).toBe(1)
  })

  it('GitHub 建的号回填出来的是 github，不是默认的 keycloak', async () => {
    const user = await createUser({ subject: '4242', issuer: GITHUB_ISSUER })
    const rows = await identities.listFor(user.id)

    expect(rows[0]).toMatchObject({ provider: 'github', label: 'GitHub' })
  })
})

describe('unlink()', () => {
  it('只剩一条时拒绝 —— 解掉就再也登不进来了', async () => {
    const user = await identities.resolveLogin('keycloak', keycloakProfile())
    const [only] = await identities.listFor(user.id)

    await expect(identities.unlink(user.id, only?.id ?? '')).resolves.toBe('last')
    expect(await prisma.userIdentity.count()).toBe(1)
  })

  it('不是自己的那条 → not-found（不泄露别人有什么）', async () => {
    const mine = await identities.resolveLogin('keycloak', keycloakProfile())
    const theirs = await identities.resolveLogin(
      'keycloak',
      keycloakProfile({ subject: 'user-2' }),
    )
    const [victim] = await identities.listFor(theirs.id)

    await expect(identities.unlink(mine.id, victim?.id ?? '')).resolves.toBe('not-found')
    expect(await prisma.userIdentity.count()).toBe(2)
  })

  it('解绑主身份 → 剩下的那条被提升，User 的 (issuer, subject) 跟着改写', async () => {
    const user = await userWithBoth()
    const primary = (await identities.listFor(user.id)).find((row) => row.primary)

    await expect(identities.unlink(user.id, primary?.id ?? '')).resolves.toBe('ok')

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.issuer).toBe(GITHUB_ISSUER)
    expect(after.subject).toBe('4242')
    // 显示名不跟着变：换一种登录方式不该让别人看到的你变个样
    expect(after.name).toBe('Alice')
    expect((await identities.listFor(user.id))[0]).toMatchObject({
      provider: 'github',
      primary: true,
    })
  })

  it('解绑副身份 → 主身份原样不动', async () => {
    const user = await userWithBoth()
    const secondary = (await identities.listFor(user.id)).find((row) => !row.primary)

    await expect(identities.unlink(user.id, secondary?.id ?? '')).resolves.toBe('ok')

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.issuer).toBe(ISSUER)
    expect(after.subject).toBe('user-1')
  })
})
