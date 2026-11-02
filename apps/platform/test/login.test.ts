import 'reflect-metadata'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeBrowser, followAuthorize, startFakeIdp, type FakeIdp } from '@learning/session/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { NestFactory } from '@nestjs/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module.js'

const SECRET_PAGE = 'PROTECTED-INDEX'
const LOGIN_PAGE = 'LOGIN-ENTRY'
const ORIGIN = 'http://app.test'

function staticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-login-'))
  fs.writeFileSync(path.join(dir, 'index.html'), SECRET_PAGE)
  fs.writeFileSync(path.join(dir, 'login.html'), LOGIN_PAGE)
  return dir
}

/** 走真实的配置路径：`$DATA_DIR/config.yaml` + 环境变量，生产模式的完整 AppModule（静态托管、页面闸门、全局守卫） */
function writeConfig(dir: string, values: Record<string, unknown>, env: Record<string, string> = {}) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATA_DIR', dir)
  vi.stubEnv('PLATFORM_SESSION_SECRET', 'test-secret')
  vi.stubEnv('PLATFORM_DATABASE_URL', '')
  vi.stubEnv('PLATFORM_OIDC_CLIENT_SECRET', '')
  vi.stubEnv('PLATFORM_GITHUB_CLIENT_SECRET', '')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    JSON.stringify({ database: { url: `file:${path.join(dir, 'test.db')}` }, web: { root: dir }, ...values }),
  )
}

async function listen() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  })
  await app.listen(0, '127.0.0.1')
  return { app, baseUrl: await app.getUrl() }
}

describe('登录（完整 AppModule，生产模式）', () => {
  let dir: string
  let idp: FakeIdp
  let app: NestFastifyApplication
  let baseUrl: string
  let browser: FakeBrowser

  const login = async (provider: 'oidc' | 'github', redirect = '/') => {
    const start = await browser.get(`/api/auth/login?provider=${provider}&redirect=${encodeURIComponent(redirect)}`)
    const location = start.headers.location as string
    return browser.get(await followAuthorize(provider === 'github' ? idp.githubAuthorizeUrl(location) : location))
  }

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dir = staticDir()
    idp = await startFakeIdp({ clientSecret: 'oidc-secret-value' })
    vi.stubGlobal('fetch', idp.fetch)
    writeConfig(
      dir,
      {
        server: { origins: [ORIGIN] },
        auth: { oidc: { issuer: idp.issuer, clientId: idp.clientId }, github: { clientId: 'gh-client' } },
      },
      { PLATFORM_OIDC_CLIENT_SECRET: 'oidc-secret-value', PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-value' },
    )
    ;({ app, baseUrl } = await listen())
  })

  afterAll(async () => {
    await app.close()
    await idp.stop()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    browser = new FakeBrowser(baseUrl, ORIGIN)
  })

  it.each(['oidc', 'github'] as const)('%s：匿名被挡 → 登录 → 页面不再 302，/login 跳走，登出后又被挡', async (provider) => {
    const anonymous = await browser.get('/projects')
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.location).toBe(`/login?redirect=${encodeURIComponent('/projects')}`)
    expect((await browser.get('/api/anything')).status).toBe(401)

    const done = await login(provider, '/projects')
    expect(done.headers.location).toBe('/projects')

    const page = await browser.get('/projects')
    expect(page.status).toBe(200)
    expect(page.body).toBe(SECRET_PAGE)
    expect((await browser.get('/login?redirect=/x')).headers.location).toBe('/x')
    expect(JSON.parse((await browser.get('/api/auth/me')).body).authenticated).toBe(true)
    // 还没有的接口是 404，不再是 401
    expect((await browser.get('/api/anything')).status).toBe(404)

    expect((await browser.get('/api/auth/logout')).headers.location).toBe('/login')
    expect((await browser.get('/projects')).status).toBe(302)
  })

  it('登录窗口：redirect=/auth/login-done 经 /api 落到通知页，页面闸门和静态回退都不插手', async () => {
    const done = await login('oidc', '/auth/login-done')
    expect(done.headers.location).toBe('/api/auth/login-done')
    const page = await browser.get('/api/auth/login-done')
    expect(page.status).toBe(200)
    expect(page.body).toContain('app-auth:login-done')
    expect(page.body).not.toContain(SECRET_PAGE)
  })

  it('匿名可以打开登录页，登录错误经 ?error= 回到它', async () => {
    const res = await browser.get('/api/auth/callback?code=x&state=y')
    expect(res.headers.location).toMatch(/^\/login\?error=/)
    const login = await browser.get(res.headers.location as string)
    expect(login.status).toBe(200)
    expect(login.body).toBe(LOGIN_PAGE)
  })

  it('还没有账号关联：/api/auth/identities 是 404，不是假数据', async () => {
    expect((await browser.get('/api/auth/identities')).status).toBe(401)
    await login('oidc')
    const res = await browser.get('/api/auth/identities')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ statusCode: 404 })
  })
})

describe('登录配置（走真实的 config.yaml）', () => {
  let dir: string

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dir = staticDir()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('生产配了 provider 却没有 origins → 启动失败', async () => {
    writeConfig(dir, { auth: { oidc: { issuer: 'https://idp.test', clientId: 'c' } } })
    await expect(listen()).rejects.toThrow('server.origins')
  })

  it('yaml 里写了 clientSecret → 启动失败，不带值', async () => {
    writeConfig(dir, { auth: { github: { clientId: 'g', clientSecret: 'hunter2' } } })
    const failure = listen()
    await expect(failure).rejects.toThrow('密钥不能写在 config.yaml')
    await expect(failure).rejects.not.toThrow('hunter2')
  })

  it('半套配置 → 启动失败，报缺什么', async () => {
    writeConfig(dir, { auth: { github: { clientId: 'g' } }, server: { origins: [ORIGIN] } })
    await expect(listen()).rejects.toThrow('PLATFORM_GITHUB_CLIENT_SECRET')
  })

  it('两个都没配：能起，打一条 warn，config 说 enabled:false，页面和 /api 全部拦住', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeConfig(dir, {})
    const { app, baseUrl } = await listen()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没有配置登录方式'))
    const browser = new FakeBrowser(baseUrl, ORIGIN)
    expect(JSON.parse((await browser.get('/api/auth/config')).body)).toEqual({ enabled: false, providers: [] })
    expect((await browser.get('/api/none')).status).toBe(401)
    expect((await browser.get('/')).status).toBe(302)
    await app.close()
  })
})
