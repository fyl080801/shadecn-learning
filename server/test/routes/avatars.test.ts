import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app.ts'
import { identiconSeed, identiconUrl, isIdenticonUrl, renderIdenticon } from '../../avatar/index.ts'
import { resetDb } from '../helpers/db.ts'
import { stubOidcFetch } from '../helpers/oidc.ts'
import { signIn } from '../helpers/session.ts'

beforeEach(async () => {
  await resetDb()
  stubOidcFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const ISSUER = 'https://keycloak.test/realms/test'

describe('identicon 的种子与地址', () => {
  it('同一个身份永远是同一个种子', () => {
    expect(identiconSeed(ISSUER, 'user-1')).toBe(identiconSeed(ISSUER, 'user-1'))
  })

  it('换了人或换了 realm 就是另一张图', () => {
    const mine = identiconSeed(ISSUER, 'user-1')

    expect(identiconSeed(ISSUER, 'user-2')).not.toBe(mine)
    expect(identiconSeed('https://keycloak.test/realms/other', 'user-1')).not.toBe(mine)
  })

  it('种子不含 subject 明文', () => {
    expect(identiconSeed(ISSUER, 'alice@example.com')).not.toContain('alice')
  })

  it('地址认得出是不是我们发的', () => {
    expect(isIdenticonUrl(identiconUrl(ISSUER, 'user-1'))).toBe(true)
    expect(isIdenticonUrl('https://cdn.test/me.png')).toBe(false)
    expect(isIdenticonUrl(null)).toBe(false)
  })

  it('画出来是一段确定的 SVG', () => {
    const seed = identiconSeed(ISSUER, 'user-1')
    const svg = renderIdenticon(seed)

    expect(svg).toContain('<svg')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('<rect')
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(renderIdenticon(seed)).toBe(svg)
  })
})

describe('GET /api/avatars/:seed', () => {
  it('登录后返回 SVG，并按不可变资源缓存', async () => {
    const { cookie } = await signIn()

    const res = await app.request(identiconUrl(ISSUER, 'user-1'), { headers: { cookie } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
    expect(res.headers.get('cache-control')).toContain('immutable')
    await expect(res.text()).resolves.toContain('<svg')
  })

  it('不带 .svg 后缀也能取', async () => {
    const { cookie } = await signIn()

    const res = await app.request(`/api/avatars/${identiconSeed(ISSUER, 'user-1')}`, {
      headers: { cookie },
    })

    expect(res.status).toBe(200)
  })

  it('种子形状不对 → 404', async () => {
    const { cookie } = await signIn()

    for (const seed of ['abc', 'ZZZZZZZZZZZZZZZZ', '../../etc/passwd']) {
      const res = await app.request(`/api/avatars/${encodeURIComponent(seed)}`, {
        headers: { cookie },
      })
      expect(res.status).toBe(404)
    }
  })

  it('匿名访问 → 401', async () => {
    expect((await app.request(identiconUrl(ISSUER, 'user-1'))).status).toBe(401)
  })
})
