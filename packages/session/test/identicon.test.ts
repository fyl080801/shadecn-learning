import { describe, expect, it, vi } from 'vitest'
import { identiconSeed, identiconUrl, isIdenticonSeed, renderIdenticon } from '../src/identicon.js'
import type { DataAccess } from '@learning/data-access'
import { UserProfileCompleter } from '../src/user-profile.js'

/** 从 `apps/server/test/routes/avatars.test.ts`、`apps/server/test/auth/profile.test.ts` 移植 */
const ISSUER = 'https://keycloak.test/realms/test'

describe('identicon 的种子与地址', () => {
  it('算法钉死：sha256(issuer + 换行 + subject) 取前 16 位。改了之后新补的头像和库里已有的对不上', () => {
    expect(identiconSeed('https://issuer.test', 'alice')).toBe('0f4c717d8a4e2a3e')
    expect(identiconUrl('https://issuer.test', 'alice')).toBe('/api/avatars/0f4c717d8a4e2a3e.svg')
  })

  it('同一个身份永远是同一个种子；换了人或换了 realm 就是另一张图', () => {
    const mine = identiconSeed(ISSUER, 'user-1')
    expect(identiconSeed(ISSUER, 'user-1')).toBe(mine)
    expect(identiconSeed(ISSUER, 'user-2')).not.toBe(mine)
    expect(identiconSeed('https://keycloak.test/realms/other', 'user-1')).not.toBe(mine)
  })

  it('种子不含 subject 明文', () => {
    expect(identiconSeed(ISSUER, 'alice@example.com')).not.toContain('alice')
  })

  it('种子只认这一个形状', () => {
    expect(isIdenticonSeed(identiconSeed(ISSUER, 'user-1'))).toBe(true)
    for (const seed of ['abc', 'ZZZZZZZZZZZZZZZZ', '../../etc/passwd', `${identiconSeed(ISSUER, 'user-1')}0`, '']) {
      expect(isIdenticonSeed(seed), seed).toBe(false)
    }
  })

  it('画出来是一段确定的 SVG，方块边缘不抗锯齿', () => {
    const seed = identiconSeed(ISSUER, 'user-1')
    const svg = renderIdenticon(seed)
    expect(svg).toContain('<svg shape-rendering="crispEdges" ')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('<rect')
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(renderIdenticon(seed)).toBe(svg)
  })
})

describe('登录后的档案补齐', () => {
  const user = { id: 'u1', issuer: ISSUER, subject: 'user-1', avatarUrl: null }

  function completerWith(nativeUpdate: (...args: unknown[]) => Promise<number>) {
    return new UserProfileCompleter({ em: () => ({ nativeUpdate }) } as unknown as DataAccess)
  }

  it('已经有头像：一条写都不发', async () => {
    const nativeUpdate = vi.fn(() => Promise.resolve(1))
    await completerWith(nativeUpdate).complete({ ...user, avatarUrl: 'https://cdn.test/me.png' })
    expect(nativeUpdate).not.toHaveBeenCalled()
  })

  it('写库失败不挡登录，错误里的 SQL 不进日志', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(completerWith(() => Promise.reject(new Error('update "user" set leaked-value'))).complete(user)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('写入默认头像失败'))
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('leaked-value'))
    error.mockRestore()
  })
})
