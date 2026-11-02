import { describe, expect, it } from 'vitest'
import { newSessionToken, sessionTokenId, toSessionUser } from '../src/session-token.js'

describe('sessionTokenId', () => {
  it('HMAC-SHA256 的十六进制摘要：结果写死（openssl dgst -sha256 -hmac 算的，不是被测代码算的）', () => {
    expect(sessionTokenId('test-session-secret', 'fixed-session-token')).toBe(
      '09ca8a4e7a5093eaa027fbd042d5bfe3e31b70d0e949f546c2ad1603d153b517',
    )
    expect(sessionTokenId('another-secret', 'fixed-session-token')).toBe(
      'c901fe368a27c662c8707df968b283de9f55176b923ba86096ba327de878d134',
    )
  })
})

describe('newSessionToken', () => {
  it('32 字节 base64url，每次不同', () => {
    expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSessionToken()).not.toBe(newSessionToken())
  })
})

describe('toSessionUser', () => {
  const user = { id: 'u', subject: 's', username: null, email: null, name: null, avatarUrl: null }

  it('roles 还原成数组，非字符串元素丢弃；坏 JSON / 非数组 → 空数组', () => {
    expect(toSessionUser({ ...user, roles: '["a",1,"b"]' }).roles).toEqual(['a', 'b'])
    expect(toSessionUser({ ...user, roles: 'not json' }).roles).toEqual([])
    expect(toSessionUser({ ...user, roles: '{"a":1}' }).roles).toEqual([])
  })

  it('只挑白名单字段：入参多带的 token 不会漏出去', () => {
    const withTokens = { ...user, roles: '[]', accessToken: 'secret', refreshToken: 'secret' }
    expect(Object.keys(toSessionUser(withTokens)).sort()).toEqual(
      ['avatarUrl', 'email', 'id', 'name', 'roles', 'subject', 'username'],
    )
  })
})
