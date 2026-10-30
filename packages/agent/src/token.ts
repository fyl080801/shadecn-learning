import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  RUN_TOKEN_AUDIENCE,
  RUN_TOKEN_ISSUER,
  type RunTokenClaims,
} from './protocol.ts'

/**
 * STS 的两种凭证（docs/22 §3、§4.1）：
 *
 * - **bootstrap token**：驱动起沙箱时注入的一次性随机串（32 字节）。服务端**只存它的 SHA-256**，
 *   绑定 runId、有效期很短、兑换一次即废 —— 拖走内存快照也拿不出原文。
 * - **run 短令牌**：JWT 形状的 HS256 签名令牌（`header.claims.signature`，base64url），密钥只在服务端。
 *   声明见 {@link RunTokenClaims}。它只回答「这是哪一轮、代表谁」，**不是授权依据**：
 *   网关每次调用照样按这一轮的 Grant 实时判权（`authorize`），令牌里的 `scope` 一个字都不读。
 *
 * 校验用 `timingSafeEqual` 比签名；header 只认 `{"alg":"HS256"}`（不接受 `none`、不接受别的算法）。
 * 本包不读 `process.env`：密钥由宿主传进来（apps/server 的 `AGENT_TOKEN_SECRET`，没配时由 `SESSION_SECRET` 派生）。
 */

/** run 短令牌的默认有效期（docs/22 §3：10 分钟），Grant 有效时可续期 */
export const RUN_TOKEN_TTL_MS = 10 * 60_000
/** bootstrap token 的有效期：沙箱起来之后马上就兑换，给足进程启动的时间即可 */
export const BOOTSTRAP_TOKEN_TTL_MS = 60_000

const HEADER = { alg: 'HS256', typ: 'JWT' } as const
const HEADER_PART = base64url(Buffer.from(JSON.stringify(HEADER)))

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function sign(input: string, secret: string | Uint8Array): Buffer {
  return createHmac('sha256', secret).update(input).digest()
}

export function signRunToken(claims: RunTokenClaims, secret: string | Uint8Array): string {
  const body = `${HEADER_PART}.${base64url(Buffer.from(JSON.stringify(claims)))}`
  return `${body}.${base64url(sign(body, secret))}`
}

export type RunTokenVerdict =
  | { ok: true; claims: RunTokenClaims; runId: string; userId: string }
  | { ok: false; reason: string }

/** 验签 + 验声明（iss / aud / exp / act）。`now` 是 UTC epoch 毫秒 */
export function verifyRunToken(token: string, secret: string | Uint8Array, now: number): RunTokenVerdict {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: '令牌格式不对' }
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string]
  let header: unknown
  let claims: Partial<RunTokenClaims>
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')) as Partial<RunTokenClaims>
  } catch {
    return { ok: false, reason: '令牌不是合法的 JSON' }
  }
  if ((header as { alg?: unknown } | null)?.alg !== HEADER.alg) return { ok: false, reason: '令牌算法不对' }
  const expected = sign(`${headerPart}.${claimsPart}`, secret)
  const actual = Buffer.from(signaturePart, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: '签名不对' }

  if (claims.iss !== RUN_TOKEN_ISSUER || claims.aud !== RUN_TOKEN_AUDIENCE) return { ok: false, reason: '签发方 / 受众不对' }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { ok: false, reason: '令牌已过期' }
  const actor = claims.act?.sub
  const subject = claims.sub
  if (typeof actor !== 'string' || !actor.startsWith('agent-run:') || typeof subject !== 'string' || !subject.startsWith('user:')) {
    return { ok: false, reason: '令牌主体不对' }
  }
  if (typeof claims.grant_id !== 'string' || !claims.grant_id) return { ok: false, reason: '令牌没有 grant_id' }
  return {
    ok: true,
    claims: claims as RunTokenClaims,
    runId: actor.slice('agent-run:'.length),
    userId: subject.slice('user:'.length),
  }
}

export interface IssueClaimsInput {
  runId: string
  userId: string
  grantId: string
  /** 已渲染好的 scope 串（只给人看） */
  scope: string
  /** UTC epoch 毫秒 */
  now: number
  ttlMs: number
}

export function runTokenClaims(input: IssueClaimsInput): RunTokenClaims {
  const iat = Math.floor(input.now / 1000)
  return {
    iss: RUN_TOKEN_ISSUER,
    sub: `user:${input.userId}`,
    act: { sub: `agent-run:${input.runId}` },
    grant_id: input.grantId,
    aud: RUN_TOKEN_AUDIENCE,
    scope: input.scope,
    iat,
    exp: Math.floor((input.now + input.ttlMs) / 1000),
    jti: base64url(randomBytes(12)),
  }
}

/** 一次性 bootstrap token：原文交给驱动注入沙箱，服务端只留 `hash` */
export function createBootstrapToken(): { token: string; hash: string } {
  const token = base64url(randomBytes(32))
  return { token, hash: hashBootstrapToken(token) }
}

export function hashBootstrapToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 从 `Authorization: Bearer <token>` 里取令牌（网关只认这一处；`x-api-key` 之类一概不认） */
export function bearerOf(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (auth) {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim())
    return match ? match[1]! : null
  }
  return null
}
