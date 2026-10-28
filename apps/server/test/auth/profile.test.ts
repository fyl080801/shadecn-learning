import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeUserProfile, registerProfileHook } from '../../auth/profile.ts'
// 引入即挂上 identicon 那条补齐规则
import '../../avatar/index.ts'
import { identiconUrl } from '../../avatar/identicon.ts'
import { createUser, prisma, resetDb } from '../helpers/db.ts'

beforeEach(async () => {
  await resetDb()
})

describe('登录后的档案补齐', () => {
  it('没有头像的存量用户，登录时补一张 identicon 并落库', async () => {
    const user = await createUser()
    expect(user.avatarUrl).toBeNull()

    const filled = await completeUserProfile(user)

    expect(filled.avatarUrl).toBe(identiconUrl(user.issuer, user.subject))
    const stored = await prisma.user.findUnique({ where: { id: user.id } })
    expect(stored?.avatarUrl).toBe(filled.avatarUrl)
  })

  it('Keycloak 给了头像就不动它', async () => {
    const user = await createUser()
    await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: 'https://cdn.test/me.png' },
    })
    const withPicture = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    const filled = await completeUserProfile(withPicture)

    expect(filled.avatarUrl).toBe('https://cdn.test/me.png')
  })

  it('补过之后再登录不会改成别的图', async () => {
    const user = await createUser()

    const once = await completeUserProfile(user)
    const twice = await completeUserProfile(once)

    expect(twice.avatarUrl).toBe(once.avatarUrl)
  })

  it('钩子抛异常不影响登录，其余钩子照常生效', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const remove = registerProfileHook({
      name: 'test-boom',
      fill: () => {
        throw new Error('炸了')
      },
    })

    try {
      const user = await createUser()
      const filled = await completeUserProfile(user)

      expect(filled.avatarUrl).toBe(identiconUrl(user.issuer, user.subject))
    } finally {
      remove()
    }
  })

  it('钩子写的字段会合并成一次更新', async () => {
    const remove = registerProfileHook({
      name: 'test-default-name',
      fill: (u) => (u.name ? null : { name: '无名氏' }),
    })

    try {
      const created = await createUser()
      // createUser 的默认值会把 null 兜成 Alice，这里直接把名字清掉
      const user = await prisma.user.update({ where: { id: created.id }, data: { name: null } })
      const filled = await completeUserProfile(user)

      expect(filled.name).toBe('无名氏')
      expect(filled.avatarUrl).toBe(identiconUrl(user.issuer, user.subject))
    } finally {
      remove()
    }
  })
})
