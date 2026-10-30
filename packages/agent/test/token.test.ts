import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  bearerOf,
  createBootstrapToken,
  hashBootstrapToken,
  runTokenClaims,
  signRunToken,
  verifyRunToken,
} from '../src/token.ts'

/**
 * STS 的两种凭证（docs/22 §3、§4.1）：run 短令牌是 HS256 签名的 JWT 形状，声明按 RFC 8693（sub = 发起人、act.sub = 这一轮）；
 * 验签只认 HS256、签名逐字节比；bootstrap token 是 32 字节随机串，服务端只留 SHA-256。
 */

const SECRET = 'secret-a'
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)

function claims(overrides: Partial<Parameters<typeof runTokenClaims>[0]> = {}) {
  return runTokenClaims({ runId: 'run_1', userId: 'u1', grantId: 'g1', scope: 'flow:f1:read llm:invoke', now: NOW, ttlMs: 10 * 60_000, ...overrides })
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('run 短令牌', () => {
  it('声明：iss / sub=user / act.sub=agent-run / grant_id / aud / scope / 10 分钟的 exp（秒）', () => {
    const token = signRunToken(claims(), SECRET)
    const [header, body] = token.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toMatchObject({
      iss: 'shadecn-agent-sts',
      sub: 'user:u1',
      act: { sub: 'agent-run:run_1' },
      grant_id: 'g1',
      aud: 'agent-gateway',
      scope: 'flow:f1:read llm:invoke',
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
    })
    const verdict = verifyRunToken(token, SECRET, NOW + 1000)
    expect(verdict).toMatchObject({ ok: true, runId: 'run_1', userId: 'u1' })
  })

  it('每张令牌的 jti 不同（续期换的是新的一张）', () => {
    expect(claims().jti).not.toBe(claims().jti)
  })

  it('伪造签名 / 别的密钥 / 篡改声明 / alg=none / 过期 / 受众不对 → 拒', () => {
    const token = signRunToken(claims(), SECRET)
    const [header, body, signature] = token.split('.') as [string, string, string]
    expect(verifyRunToken(signRunToken(claims(), 'other-secret'), SECRET, NOW)).toMatchObject({ ok: false, reason: '签名不对' })
    // 把 act.sub 换成别的 run，签名不变
    const tampered = encode({ ...claims(), act: { sub: 'agent-run:run_2' } })
    expect(verifyRunToken(`${header}.${tampered}.${signature}`, SECRET, NOW)).toMatchObject({ ok: false })
    expect(verifyRunToken(`${encode({ alg: 'none' })}.${body}.`, SECRET, NOW)).toMatchObject({ ok: false, reason: '令牌算法不对' })
    expect(verifyRunToken(token, SECRET, NOW + 10 * 60_000)).toMatchObject({ ok: false, reason: '令牌已过期' })
    expect(verifyRunToken('a.b', SECRET, NOW)).toMatchObject({ ok: false })
    // 签名对、但受众不是网关的（别处签出来的同密钥令牌）
    const foreign = `${header}.${encode({ ...claims(), aud: 'elsewhere' })}`
    const foreignSig = createHmac('sha256', SECRET).update(foreign).digest('base64url')
    expect(verifyRunToken(`${foreign}.${foreignSig}`, SECRET, NOW)).toMatchObject({ ok: false, reason: '签发方 / 受众不对' })
  })

  it('Authorization 头只认 Bearer', () => {
    expect(bearerOf(new Headers({ authorization: 'Bearer abc' }))).toBe('abc')
    expect(bearerOf(new Headers({ authorization: 'Basic abc' }))).toBeNull()
    expect(bearerOf(new Headers({ cookie: 'sid=abc' }))).toBeNull()
  })
})

describe('bootstrap token', () => {
  it('32 字节随机串；服务端只留它的 SHA-256', () => {
    const one = createBootstrapToken()
    const two = createBootstrapToken()
    expect(Buffer.from(one.token, 'base64url')).toHaveLength(32)
    expect(one.token).not.toBe(two.token)
    expect(one.hash).toBe(hashBootstrapToken(one.token))
    expect(one.hash).not.toContain(one.token)
  })
})
