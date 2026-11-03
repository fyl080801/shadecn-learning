import crypto from 'node:crypto'
import http from 'node:http'

/**
 * 只给测试和本地冒烟用（`@learning/session/testing`，这个包的入口不导出它）：一个真走 HTTP 的假身份提供方，加一个带 cookie 的假浏览器。
 * OIDC 那边的发现文档、PKCE、token、JWKS 都是真的，id_token 用本地生成的 RSA 密钥真实签名；同一个服务上还有一个假 GitHub。
 */

export interface FakeUser {
  sub: string
  preferred_username?: string
  email?: string
  name?: string
  picture?: string
}

export interface FakeGithubUser {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string | null
}

export type FakeTokenReply = { status: number; body: unknown } | 'drop'

export interface FakeIdp {
  /** OIDC 的 issuer，也是假服务的根地址 */
  issuer: string
  clientId: string
  /** 下一次授权发给谁 */
  user: FakeUser
  roles: { realm: string[]; client: string[] }
  /** access_token 的有效期（秒），refresh 也用它 */
  accessTokenTtl: number
  /** 改写 id_token 的 claims，造 nonce / aud 不对的情况 */
  mutateClaims: ((claims: Record<string, unknown>) => Record<string, unknown>) | null
  /** 用另一把钥匙签 id_token，造签名不对的情况 */
  signWithWrongKey: boolean
  /** 拦下 token 端点：造 500 / invalid_grant / 连接中断 */
  tokenOverride: ((params: URLSearchParams) => FakeTokenReply | null) | null
  /** token 端点先等这么久再答，造并发 */
  tokenDelayMs: number
  /** token 端点收到的每个请求 */
  tokenCalls: URLSearchParams[]
  /** 发出去过的全部 token（含 refresh、id_token）和 code，查响应和日志里有没有漏 */
  issued: string[]
  github: {
    user: FakeGithubUser
    emails: { email: string; primary: boolean; verified: boolean }[]
    /** 拦下 token 端点。GitHub 失败也回 200 */
    tokenOverride: FakeTokenReply | null
    tokenCalls: URLSearchParams[]
  }
  /** 把 github.com / api.github.com 转到这个假服务，其余非本机地址一律拒绝。装到全局 fetch 上，测试不碰外网 */
  fetch: typeof fetch
  /** 把 GitHub 授权地址换成假服务上的那个（假浏览器不会访问 github.com） */
  githubAuthorizeUrl(location: string): string
  stop(): Promise<void>
}

export function startFakeIdp(options: { clientId?: string; clientSecret?: string; port?: number } = {}): Promise<FakeIdp> {
  const clientId = options.clientId ?? 'platform-client'
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrongKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const kid = 'fake-kid'
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: FakeUser }>()
  const githubCodes = new Set<string>()
  let refreshSerial = 0

  const issue = (value: string) => {
    idp.issued.push(value)
    return value
  }
  const sign = (payload: Record<string, unknown>, key: crypto.KeyObject = privateKey) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const signed = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(payload)}`
    return `${signed}.${crypto.sign('sha256', Buffer.from(signed), key).toString('base64url')}`
  }

  function tokenBody(user: FakeUser, nonce: string | null) {
    const now = Math.floor(Date.now() / 1000)
    refreshSerial += 1
    const accessToken = sign({
      serial: refreshSerial,
      realm_access: { roles: idp.roles.realm },
      resource_access: { [clientId]: { roles: idp.roles.client } },
    })
    let claims: Record<string, unknown> = {
      iss: idp.issuer,
      aud: clientId,
      exp: now + 300,
      iat: now,
      sid: 'fake-sso-session',
      ...user,
      ...(nonce === null ? {} : { nonce }),
    }
    if (idp.mutateClaims) claims = idp.mutateClaims(claims)
    return {
      access_token: issue(accessToken),
      token_type: 'Bearer',
      expires_in: idp.accessTokenTtl,
      refresh_token: issue(`fake-refresh-${refreshSerial}-${crypto.randomBytes(8).toString('hex')}`),
      refresh_expires_in: 3600,
      id_token: issue(sign(claims, idp.signWithWrongKey ? wrongKey : privateKey)),
      session_state: 'fake-sso-session',
    }
  }

  function oidcToken(params: URLSearchParams): FakeTokenReply {
    if (params.get('client_id') !== clientId || (options.clientSecret && params.get('client_secret') !== options.clientSecret)) {
      return { status: 401, body: { error: 'invalid_client' } }
    }
    if (params.get('grant_type') === 'refresh_token') {
      return { status: 200, body: tokenBody(idp.user, null) }
    }
    const code = params.get('code') ?? ''
    const grant = codes.get(code)
    codes.delete(code)
    const verifier = crypto.createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
    if (!grant || grant.redirectUri !== params.get('redirect_uri') || grant.challenge !== verifier) {
      return { status: 400, body: { error: 'invalid_grant', error_description: '授权码无效' } }
    }
    return { status: 200, body: tokenBody(grant.user, grant.nonce) }
  }

  function githubToken(params: URLSearchParams): FakeTokenReply {
    const code = params.get('code') ?? ''
    if (!githubCodes.delete(code)) {
      return { status: 200, body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } }
    }
    return { status: 200, body: { access_token: issue(`fake-github-${crypto.randomBytes(8).toString('hex')}`), token_type: 'bearer' } }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const reply = (result: FakeTokenReply) => {
      if (result === 'drop') {
        req.socket.destroy()
        return
      }
      json(result.status, result.body)
    }
    const backToApp = (redirectUri: string, code: string, state: string) => {
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      res.writeHead(302, { location: target.toString() })
      res.end()
    }

    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const params = new URLSearchParams(raw)
      switch (url.pathname) {
        case '/.well-known/openid-configuration':
          return json(200, {
            issuer: idp.issuer,
            authorization_endpoint: `${idp.issuer}/authorize`,
            token_endpoint: `${idp.issuer}/token`,
            jwks_uri: `${idp.issuer}/jwks`,
            code_challenge_methods_supported: ['S256'],
          })
        case '/jwks':
          return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
        case '/authorize': {
          const code = issue(`fake-code-${crypto.randomBytes(8).toString('hex')}`)
          const redirectUri = url.searchParams.get('redirect_uri') ?? ''
          codes.set(code, {
            nonce: url.searchParams.get('nonce') ?? '',
            challenge: url.searchParams.get('code_challenge') ?? '',
            redirectUri,
            user: idp.user,
          })
          return backToApp(redirectUri, code, url.searchParams.get('state') ?? '')
        }
        case '/token':
          idp.tokenCalls.push(params)
          setTimeout(() => reply(idp.tokenOverride?.(params) ?? oidcToken(params)), idp.tokenDelayMs)
          return
        case '/github/login/oauth/authorize': {
          const code = issue(`fake-github-code-${crypto.randomBytes(8).toString('hex')}`)
          githubCodes.add(code)
          return backToApp(url.searchParams.get('redirect_uri') ?? '', code, url.searchParams.get('state') ?? '')
        }
        case '/github/login/oauth/access_token':
          idp.github.tokenCalls.push(params)
          return reply(idp.github.tokenOverride ?? githubToken(params))
        case '/github-api/user':
          return json(200, idp.github.user)
        case '/github-api/user/emails':
          return json(200, idp.github.emails)
        default:
          return json(404, { error: 'not_found' })
      }
    })
  })

  const idp: FakeIdp = {
    issuer: '',
    clientId,
    user: { sub: 'alice-sub', preferred_username: 'alice', email: 'alice@example.test', name: 'Alice' },
    roles: { realm: [], client: [] },
    accessTokenTtl: 300,
    mutateClaims: null,
    signWithWrongKey: false,
    tokenOverride: null,
    tokenDelayMs: 0,
    tokenCalls: [],
    issued: [],
    github: {
      user: { id: 4242, login: 'octocat', name: 'Octo Cat', email: 'octo@example.test', avatar_url: 'https://avatars.test/octocat.png' },
      emails: [],
      tokenOverride: null,
      tokenCalls: [],
    },
    fetch: (input, init) => {
      const target = String(input instanceof Request ? input.url : input)
        .replace('https://github.com/', `${idp.issuer}/github/`)
        .replace('https://api.github.com/', `${idp.issuer}/github-api/`)
      if (!target.startsWith('http://127.0.0.1')) throw new Error(`[测试] 不该访问外网：${target}`)
      return nativeFetch(target, init)
    },
    githubAuthorizeUrl: (location) => location.replace('https://github.com/', `${idp.issuer}/github/`),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
  // 假 fetch 装到全局之后还要能发真请求
  const nativeFetch = globalThis.fetch

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      idp.issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve(idp)
    })
  })
}

export interface BrowserResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/**
 * 带 cookie 的假浏览器：用 node:http 发请求，fetch 不让改 Host。
 * 按 Secure、Max-Age、Path 处理 cookie，和真浏览器一样：http 下不存带 Secure 的，`Path=/api/auth` 的不发给别的路径。
 */
export class FakeBrowser {
  readonly cookies = new Map<string, { value: string; path: string; secure: boolean }>()

  /** `baseUrl` 是真实连接的地址；`origin` 是浏览器以为自己在的地方，决定 Host 头和 Secure */
  constructor(
    private readonly baseUrl: string,
    private readonly origin: string,
  ) {}

  private cookieHeader(path: string): string | undefined {
    const pairs = [...this.cookies]
      .filter(([, cookie]) => path === cookie.path || path.startsWith(cookie.path === '/' ? '/' : `${cookie.path}/`))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
    return pairs.length > 0 ? pairs.join('; ') : undefined
  }

  private store(lines: string[] | undefined) {
    for (const line of lines ?? []) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      const secure = attributes.includes('Secure')
      if (secure && !this.origin.startsWith('https://')) continue
      if (attributes.includes('Max-Age=0')) {
        this.cookies.delete(name)
        continue
      }
      const path = attributes.find((attribute) => attribute.startsWith('Path='))?.slice(5) ?? '/'
      this.cookies.set(name, { value: pair.slice(separator + 1), path, secure })
    }
  }

  get(target: string, headers: Record<string, string> = {}): Promise<BrowserResponse> {
    return this.request('GET', target, headers)
  }

  /** 不带请求体。关联的确认和解绑是 POST / DELETE，和前端一样不发 body */
  request(method: string, target: string, headers: Record<string, string> = {}): Promise<BrowserResponse> {
    const { hostname, port } = new URL(this.baseUrl)
    const cookie = this.cookieHeader(target.split('?')[0])
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname, port, method, path: target, headers: { host: new URL(this.origin).host, ...(cookie ? { cookie } : {}), ...headers } },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            this.store(res.headers['set-cookie'])
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  }
}

/** 假身份提供方的授权地址：GET 一次，它带着 code 和 state 跳回来，返回跳回来的地址（站内路径 + query） */
export async function followAuthorize(location: string): Promise<string> {
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    http.get(location, resolve).on('error', reject)
  })
  res.resume()
  const back = new URL(res.headers.location ?? '')
  return `${back.pathname}${back.search}`
}
