import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiPath } from '../config.ts'

/**
 * config.ts 的值都是模块加载时从 process.env 算出来的常量，
 * 所以每个用例都要 resetModules + stubEnv 之后重新 import 一次。
 */
async function loadConfig() {
  vi.resetModules()
  return import('../config.ts')
}

const rootDir = path.resolve(import.meta.dirname, '..', '..')

describe('isApiPath()', () => {
  it.each([
    ['/api', true],
    ['/api/', true],
    ['/api/health', true],
    ['/api/auth/callback', true],
  ])('%s 归后端', (input, expected) => {
    expect(isApiPath(input)).toBe(expected)
  })

  it.each([['/'], ['/apixyz'], ['/login'], ['/ws/room'], ['']])('%s 归前端', (input) => {
    expect(isApiPath(input)).toBe(false)
  })
})

describe('数据库路径解析', () => {
  beforeEach(() => {
    // 测试环境默认给了 DATABASE_URL / DB_PROVIDER，这几个用例要从零开始算
    vi.stubEnv('DATABASE_URL', undefined)
    vi.stubEnv('DATA_DIR', undefined)
    vi.stubEnv('DB_PROVIDER', undefined)
  })

  it('默认落在 <仓库根>/data/app.db', async () => {
    const config = await loadConfig()
    expect(config.dataDir).toBe(path.join(rootDir, 'data'))
    expect(config.databaseUrl).toBe(`file:${path.join(rootDir, 'data', 'app.db')}`)
  })

  it('DATA_DIR 的相对路径按仓库根目录算，不看 cwd', async () => {
    vi.stubEnv('DATA_DIR', 'tmp/db')
    const config = await loadConfig()
    expect(config.databaseUrl).toBe(`file:${path.join(rootDir, 'tmp/db', 'app.db')}`)
  })

  it('DATA_DIR 是绝对路径就直接用', async () => {
    vi.stubEnv('DATA_DIR', '/var/lib/app')
    const config = await loadConfig()
    expect(config.dataDir).toBe('/var/lib/app')
    expect(config.databaseUrl).toBe('file:/var/lib/app/app.db')
  })

  it('DATABASE_URL 优先级高于 DATA_DIR，相对路径同样按仓库根解析', async () => {
    vi.stubEnv('DATA_DIR', 'ignored')
    vi.stubEnv('DATABASE_URL', 'file:./custom/x.db')
    const config = await loadConfig()
    expect(config.databaseUrl).toBe(`file:${path.join(rootDir, 'custom/x.db')}`)
  })

  it('非 file: 的 DATABASE_URL 原样透传', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/app')
    const config = await loadConfig()
    expect(config.databaseUrl).toBe('postgresql://localhost:5432/app')
  })
})

describe('数据库 provider 解析', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', undefined)
    vi.stubEnv('DATA_DIR', undefined)
    vi.stubEnv('DB_PROVIDER', undefined)
  })

  it('什么都不设 → sqlite', async () => {
    expect((await loadConfig()).dbProvider).toBe('sqlite')
  })

  it.each([
    ['postgresql://user:pw@localhost:5432/app', 'postgresql'],
    ['postgres://user:pw@localhost:5432/app', 'postgresql'],
    ['file:./data/app.db', 'sqlite'],
  ])('从 DATABASE_URL 的协议推断：%s → %s', async (url, expected) => {
    vi.stubEnv('DATABASE_URL', url)
    expect((await loadConfig()).dbProvider).toBe(expected)
  })

  it('显式的 DB_PROVIDER 说了算', async () => {
    vi.stubEnv('DB_PROVIDER', 'postgresql')
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/app')
    expect((await loadConfig()).dbProvider).toBe('postgresql')
  })

  it('DB_PROVIDER 和 DATABASE_URL 的协议对不上 → 直接抛错', async () => {
    vi.stubEnv('DB_PROVIDER', 'sqlite')
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/app')
    await expect(loadConfig()).rejects.toThrow(/不一致/)
  })

  it('DB_PROVIDER 是不认识的值 → 直接抛错', async () => {
    vi.stubEnv('DB_PROVIDER', 'mysql')
    await expect(loadConfig()).rejects.toThrow(/只能是/)
  })

  it('DB_PROVIDER=postgresql 却没给 DATABASE_URL → 直接抛错', async () => {
    vi.stubEnv('DB_PROVIDER', 'postgresql')
    await expect(loadConfig()).rejects.toThrow(/必须提供 DATABASE_URL/)
  })
})

describe('静态资源目录', () => {
  it('默认是 <应用根>/output/public（`vite build` 的产物）', async () => {
    vi.stubEnv('STATIC_DIR', undefined)
    const config = await loadConfig()
    expect(config.staticDir).toBe(path.join(rootDir, 'output', 'public'))
  })

  it('STATIC_DIR 的相对路径按应用根目录算', async () => {
    vi.stubEnv('STATIC_DIR', 'public-dist')
    const config = await loadConfig()
    expect(config.staticDir).toBe(path.join(rootDir, 'public-dist'))
  })

  it('STATIC_DIR 是绝对路径就直接用', async () => {
    vi.stubEnv('STATIC_DIR', '/srv/www')
    const config = await loadConfig()
    expect(config.staticDir).toBe('/srv/www')
  })
})

describe('appOrigin / cookie', () => {
  it('去掉结尾的斜杠，redirect_uri 才不会出现双斜杠', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://app.example.com///')
    const config = await loadConfig()
    expect(config.appOrigin).toBe('https://app.example.com')
    expect(config.authConfig.redirectUri).toBe('https://app.example.com/api/auth/callback')
    expect(config.authConfig.postLogoutRedirectUri).toBe('https://app.example.com/login')
  })

  it('https 部署时 cookie 带 Secure', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://app.example.com')
    const config = await loadConfig()
    expect(config.authConfig.secureCookie).toBe(true)
  })

  it('http 部署时不带 Secure（本地 http 也能登录）', async () => {
    vi.stubEnv('APP_ORIGIN', 'http://127.0.0.1:3000')
    const config = await loadConfig()
    expect(config.authConfig.secureCookie).toBe(false)
  })

  it('没设 APP_ORIGIN 就用 http://host:port 兜底', async () => {
    vi.stubEnv('APP_ORIGIN', undefined)
    vi.stubEnv('HOST', '0.0.0.0')
    vi.stubEnv('PORT', '8080')
    const config = await loadConfig()
    expect(config.appOrigin).toBe('http://0.0.0.0:8080')
  })
})

describe('authEnabled / assertAuthConfig()', () => {
  it('issuer + clientId 都有才算开启登录', async () => {
    const config = await loadConfig()
    expect(config.authEnabled).toBe(true)
    expect(config.authConfig.issuer).toBe('https://keycloak.test/realms/test')
  })

  it('issuer 结尾的斜杠会被去掉（discovery 地址不能是双斜杠）', async () => {
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://kc.test/realms/demo/')
    const config = await loadConfig()
    expect(config.authConfig.issuer).toBe('https://kc.test/realms/demo')
  })

  it.each([
    ['只缺 issuer', '', 'test-client'],
    ['只缺 clientId', 'https://kc.test/realms/demo', ''],
    ['两个都缺', '', ''],
  ])('%s 就退化成不鉴权', async (_label, issuer, clientId) => {
    vi.stubEnv('KEYCLOAK_ISSUER', issuer)
    vi.stubEnv('KEYCLOAK_CLIENT_ID', clientId)
    const config = await loadConfig()
    expect(config.authEnabled).toBe(false)
  })

  it('开发环境配置不全只警告，不阻止启动', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('KEYCLOAK_ISSUER', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const config = await loadConfig()
    expect(() => config.assertAuthConfig()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('KEYCLOAK_ISSUER')
  })

  it('生产环境配置不全直接拒绝启动', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('KEYCLOAK_ISSUER', '')
    const config = await loadConfig()
    expect(config.isDev).toBe(false)
    expect(() => config.assertAuthConfig()).toThrowError(/KEYCLOAK_ISSUER/)
  })

  it('生产环境缺 SESSION_SECRET 也拒绝启动', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SESSION_SECRET', '')
    const config = await loadConfig()
    expect(() => config.assertAuthConfig()).toThrowError(/SESSION_SECRET/)
  })

  it('配齐了就安静通过', async () => {
    const config = await loadConfig()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => config.assertAuthConfig()).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })
})
