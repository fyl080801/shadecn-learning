import 'reflect-metadata'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Injectable, Module } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '@learning/config'
import { WEB_PAGE_AUTH, type WebPageAuth } from '../src/index.js'
import { resolveWebOptions, type WebModuleOptions } from '../src/options.js'
import { isHtmlFilePath, safeRedirect } from '../src/page-gate.js'
import { createApp, type TestWebConfig } from './helpers.js'

// sid=ok 已登录；sid=boom 判断不了（模拟数据库故障）；其余未登录
@Injectable()
class FakeAuth implements WebPageAuth {
  isAuthenticated(request: { headers: Record<string, unknown> }) {
    if (request.headers.cookie === 'sid=boom') return Promise.reject(new Error('数据库连不上'))
    return Promise.resolve(request.headers.cookie === 'sid=ok')
  }
}

@Module({ providers: [{ provide: WEB_PAGE_AUTH, useClass: FakeAuth }], exports: [WEB_PAGE_AUTH] })
class FakeAuthModule {}

const auth = { loginPath: '/login', publicPaths: ['/favicon.ico', '/vite.svg'] }
const SECRET = 'PROTECTED-ENTRY-CONTENT'
const LOGIN = 'LOGIN-ENTRY-CONTENT'

/** fetch 会规整路径、丢掉 #，绕过用例要原样把路径发出去 */
function rawRequest(baseUrl: string, target: string, options: { method?: string; cookie?: string } = {}) {
  const { hostname, port } = new URL(baseUrl)
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: target, method: options.method ?? 'GET', headers: options.cookie ? { cookie: options.cookie } : {} },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const page = (content: string) =>
  `<!doctype html><html><head></head><body>${content}<script type="module" src="/main.ts"></script></body></html>`

/** 两种模式、两种入口名：写死 index.html 的实现在改名后会漏 */
describe.each([
  ['static', 'index.html'],
  ['static', 'app.htm'],
  ['dev', 'index.html'],
  ['dev', 'app.htm'],
] as const)('页面闸门：%s 模式，fallbackEntry = %s', (mode, entry) => {
  let root: string
  let app: NestFastifyApplication
  let baseUrl: string
  const get = (target: string, cookie?: string) => rawRequest(baseUrl, target, { cookie })

  beforeAll(async () => {
    // macOS 的 /var 是软链：root 不是真实路径时 Vite 加载失败
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `learning-web-gate-${mode}-`)))
    fs.mkdirSync(path.join(root, 'assets'))
    fs.writeFileSync(path.join(root, entry), page(SECRET))
    fs.writeFileSync(path.join(root, 'login.html'), page(LOGIN))
    fs.writeFileSync(path.join(root, 'assets/a.js'), 'console.log(1)')
    fs.writeFileSync(path.join(root, 'main.ts'), 'console.log(1)\n')
    const options: TestWebConfig = {
      mode,
      root,
      fallbackEntry: entry,
      htmlEntries: { '/login': 'login.html' },
      auth,
    }
    ;({ app, baseUrl } = await createApp(options, [FakeAuthModule]))
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['/', '/login?redirect=%2F'],
    ['/projects', '/login?redirect=%2Fprojects'],
    ['/flows/abc?x=1&y=%E4%B8%AD', `/login?redirect=${encodeURIComponent('/flows/abc?x=1&y=%E4%B8%AD')}`],
  ])('未登录 GET %s → 302，redirect 编码且保留 query，不缓存', async (target, location) => {
    const res = await get(target)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(location)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).not.toContain(SECRET)
  })

  it('未登录 HEAD / → 302', async () => {
    const res = await rawRequest(baseUrl, '/', { method: 'HEAD' })
    expect(res.status).toBe(302)
  })

  it('已登录 GET / → 200 受保护的 HTML', async () => {
    const res = await get('/', 'sid=ok')
    expect(res.status).toBe(200)
    expect(res.body).toContain(SECRET)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('未登录可以打开登录页', async () => {
    const res = await get('/login?redirect=/x')
    expect(res.status).toBe(200)
    expect(res.body).toContain(LOGIN)
    expect(res.body).not.toContain(SECRET)
  })

  it.each([
    ['/login', '/'],
    ['/login?redirect=/x%3Fa%3D1', '/x?a=1'],
    ['/login?redirect=//evil.com', '/'],
    ['/login?redirect=/%5Cevil.com', '/'],
    ['/login?redirect=https://evil.com', '/'],
    ['/login?redirect=/%09/evil.com', '/'],
    ['/login?redirect=/%E9%A1%B9%E7%9B%AE', '/%E9%A1%B9%E7%9B%AE'],
  ])('已登录 GET %s → 302 到 %s（站内校验）', async (target, location) => {
    const res = await get(target, 'sid=ok')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(location)
  })

  it('js 资源匿名可取，不校验登录态', async () => {
    const res = await get(mode === 'static' ? '/assets/a.js' : '/main.ts')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('javascript')
  })

  it('公开路径的文件不存在：404，不回落到受保护的 HTML', async () => {
    const res = await get('/favicon.ico')
    expect(res.status).toBe(404)
    expect(res.body).not.toContain(SECRET)
  })

  it('闸门抛错 → 500，不放行，不说成未登录，也不把错误信息和 HTML 发出去', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const target of ['/', '/login', `/${entry}`]) {
      const res = await get(target, 'sid=boom')
      expect(res.status, target).toBe(500)
      expect(res.body, target).not.toContain(SECRET)
      expect(res.body, target).not.toContain(LOGIN)
      expect(res.body, target).not.toContain('数据库连不上')
      expect(res.headers.location, target).toBeUndefined()
    }
    consoleError.mockRestore()
  })

  const common = [
    `/${entry}`,
    `/${entry}?x=1`,
    `/${entry.toUpperCase()}`,
    `/%61${entry.slice(1)}`,
    `/${entry.slice(0, -1)}%${entry.charCodeAt(entry.length - 1).toString(16)}`,
    `/./${entry}`,
    `//${entry}`,
    `/assets/../${entry}`,
    `/${entry}/`,
    `/${entry}/.`,
    '/login.html',
  ]
  const devOnly = () => [
    `/${entry}?import`,
    `/${entry}?raw`,
    `/${entry}?url`,
    `/${entry}?import&raw`,
    `/${entry}?raw&import`,
    `/${entry}?html-proxy&index=0.js`,
    `/${entry}#?raw&import`,
    `/${entry}%3Fraw%26import`,
    `/${entry}%253Fraw%2526import`,
    `/${entry}/.?raw&import`,
    `/@fs${root}/${entry}`,
    `/@fs${root}/${entry}?import&raw`,
    `/@fs${root}/${entry}/.`,
    `/@fs${root}/%61${entry.slice(1)}`,
    `/@fs${root}/%2561${entry.slice(1)}`,
    `/@id/${root}/${entry}?import&raw`,
  ]

  it('未登录走不通任何绕过路径（GET / HEAD 都拿不到受保护 HTML）', async () => {
    for (const target of mode === 'dev' ? [...common, ...devOnly()] : common) {
      const res = await get(target)
      expect(res.body, target).not.toContain(SECRET)
      // 登录页的内容也算：/login.html 不该绕过「已登录要跳走」，但匿名拿到它没有危害，这里只钉受保护的那份
      const head = await rawRequest(baseUrl, target, { method: 'HEAD' })
      expect(head.status === 200 && String(head.headers['content-type']).includes('html'), `HEAD ${target}`).toBe(false)
    }
  })

  it('已登录访问入口文件路径：拿到受保护的 HTML', async () => {
    const res = await get(`/${entry}`, 'sid=ok')
    expect(res.status).toBe(200)
    expect(res.body).toContain(SECRET)
  })
})

describe('配置错误在启动时暴露，不会变成不校验', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'learning-web-gate-config-')))
    fs.writeFileSync(path.join(dir, 'index.html'), SECRET)
    fs.writeFileSync(path.join(dir, 'login.html'), LOGIN)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 不写 auth 才是生产配置的样子；helper 为了别的用例默认关，这里明确传 undefined 把它盖掉
  it.each(['static', 'dev'] as const)('%s：闸门默认开启，没写 web.auth 又没人提供 WEB_PAGE_AUTH → 启动失败', async (mode) => {
    await expect(createApp({ mode, root: dir, auth: undefined })).rejects.toThrow(/没有模块提供 WEB_PAGE_AUTH/)
  })

  it.each([true, {}])('web.auth 写成 %j 也算开启：没人提供 → 启动失败', async (value) => {
    await expect(createApp({ mode: 'static', root: dir, auth: value })).rejects.toThrow(/没有模块提供 WEB_PAGE_AUTH/)
  })

  it('闸门默认开启：只给 root、有人提供 token → 匿名被挡，默认的 /login 能打开，默认的公开路径是 404', async () => {
    const { app, baseUrl } = await createApp({ mode: 'static', root: dir, auth: undefined }, [FakeAuthModule])
    const home = await rawRequest(baseUrl, '/')
    expect(home.status).toBe(302)
    expect(home.headers.location).toBe('/login?redirect=%2F')
    expect((await rawRequest(baseUrl, '/login')).body).toBe(LOGIN)
    expect((await rawRequest(baseUrl, '/vite.svg')).status).toBe(404)
    await app.close()
  })

  it('web.auth: false 才关：不要求有人提供 token，匿名能拿到页面', async () => {
    const { app, baseUrl } = await createApp({ mode: 'static', root: dir, auth: false })
    const home = await rawRequest(baseUrl, '/')
    expect(home.status).toBe(200)
    expect(home.body).toBe(SECRET)
    await app.close()
  })

  it.each([
    ['字符串 "false"', 'false'],
    ['数字 0', 0],
    ['列表', []],
  ])('web.auth 写成%s → 启动失败，不猜', async (_name, value) => {
    await expect(createApp({ mode: 'static', root: dir, auth: value as never }, [FakeAuthModule])).rejects.toThrow(
      'web.auth 只能是 false 或映射',
    )
  })

  it('loginPath 没有自己的入口 → 启动失败：否则匿名在登录页拿到 SPA', async () => {
    await expect(
      createApp({ mode: 'static', root: dir, htmlEntries: {}, auth: { loginPath: '/login' } }, [FakeAuthModule]),
    ).rejects.toThrow('没有入口')
    await expect(
      createApp({ mode: 'static', root: dir, auth: { loginPath: '/signin' } }, [FakeAuthModule]),
    ).rejects.toThrow('/signin')
  })

  it('闸门关着时 htmlEntries 可以没有登录页', async () => {
    const { app, baseUrl } = await createApp({ mode: 'static', root: dir, htmlEntries: {}, auth: false })
    expect((await rawRequest(baseUrl, '/login')).body).toBe(SECRET)
    await app.close()
  })
})

describe('web 配置段的默认值', () => {
  const resolve = (values: Record<string, unknown>, isProduction: boolean) =>
    resolveWebOptions(new ConfigService({ rootDir: '/repo', dataDir: '/repo/data', isProduction, values }))

  it('生产：static，root 是 <rootDir>/output/public', () => {
    expect(resolve({}, true)).toEqual({
      mode: 'static',
      root: '/repo/output/public',
      apiPrefix: '/api',
      fallbackEntry: 'index.html',
      htmlEntries: { '/login': 'login.html' },
      auth: { loginPath: '/login', publicPaths: ['/favicon.ico', '/vite.svg'] },
    })
  })

  it('开发：dev，root 是 <rootDir>/apps/web；闸门同样开着', () => {
    const options = resolve({}, false)
    expect(options.mode).toBe('dev')
    expect(options.root).toBe('/repo/apps/web')
    expect(options.auth).toBeDefined()
  })

  it('root 的相对路径按 rootDir，绝对路径不变', () => {
    expect(resolve({ web: { root: 'dist/web' } }, true).root).toBe('/repo/dist/web')
    expect(resolve({ web: { root: '/abs/web' } }, true).root).toBe('/abs/web')
  })

  it.each([
    ['root 不是字符串', { root: 1 }, 'root 必须是字符串'],
    ['htmlEntries 不是映射', { htmlEntries: ['login.html'] }, 'web.htmlEntries'],
    ['htmlEntries 的值不是字符串', { htmlEntries: { '/login': 1 } }, 'web.htmlEntries'],
    ['publicPaths 不是列表', { auth: { publicPaths: '/a' } }, 'publicPaths'],
  ])('%s → 抛错', (_name, web, message) => {
    expect(() => resolve({ web }, true)).toThrow(message)
  })
})

describe('safeRedirect', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['x', '/'],
    ['https://evil.com', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['/\n/evil.com', '/'],
    ['/x?a=1', '/x?a=1'],
    ['/x?a=%20', '/x?a=%20'],
    ['/项目', '/%E9%A1%B9%E7%9B%AE'],
    ['/a b', '/a%20b'],
  ])('%j → %j', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected)
  })
})

describe('isHtmlFilePath', () => {
  const options: WebModuleOptions = { mode: 'dev', root: '/', fallbackEntry: 'app.htm', htmlEntries: { '/login': 'login.html' } }

  it.each(['/x.html', '/X.HTML', '/app.htm', '/%61pp.htm', '/x.html?a', '/x.html#a', '/x.html%3Fa', '/x.html%253Fa', '/x.html/', '/x.html/.', '/@fs/a/x.html', '/a\\x.html'])(
    '%s → 是',
    (url) => {
      expect(isHtmlFilePath(options, url)).toBe(true)
    },
  )

  it.each(['/', '/login', '/src/main.ts', '/@fs/a/b.ts', '/a.js?x.html', '/x.htm', '/x.html%'])('%s → 否', (url) => {
    expect(isHtmlFilePath(options, url)).toBe(false)
  })
})
