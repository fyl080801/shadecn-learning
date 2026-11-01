import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_ROLES, buildRouteTable } from '@shadecn/server-kit/kernel'
import { AUTH_SERVICE, type RuntimeInfo } from '@shadecn/server-kit/platform'
import { LOGIN_DONE_PATH, LOGIN_PATH } from '@shadecn/shared/auth'
import { authConfigSection } from '../src/config.ts'
import auth from '../src/module.ts'

const parse = (env: Record<string, string>, isDev: boolean) =>
  authConfigSection.parse((name) => env[name], { isDev } as RuntimeInfo)

const KEYCLOAK = { KEYCLOAK_ISSUER: 'https://kc.test/realms/demo/', KEYCLOAK_CLIENT_ID: 'c', SESSION_SECRET: 's' }

afterEach(() => vi.restoreAllMocks())

describe('登录模块的配置段', () => {
  it('Keycloak 配齐 = 启用；issuer 去掉尾斜杠；默认 scope / 会话时长', () => {
    const settings = parse(KEYCLOAK, false)
    expect(settings).toMatchObject({ enabled: true, keycloakEnabled: true, githubEnabled: false, ttl: 7 * 24 * 3600 })
    expect(settings.keycloak).toMatchObject({ issuer: 'https://kc.test/realms/demo', scope: 'openid profile email' })
  })

  it('GitHub 要 id 和 secret 都有才算启用（OAuth App 没 secret 换不了 token）', () => {
    expect(parse({ GITHUB_CLIENT_ID: 'g', GITHUB_CLIENT_SECRET: 'x', SESSION_SECRET: 's' }, false).githubEnabled).toBe(true)
    expect(() => parse({ GITHUB_CLIENT_ID: 'g', SESSION_SECRET: 's' }, false)).toThrow(/GITHUB_CLIENT_SECRET/)
  })

  it('生产：一个提供方都没有、或缺 SESSION_SECRET → 解析就抛（进程不监听端口）', () => {
    expect(() => parse({}, false)).toThrow(/KEYCLOAK_ISSUER \+ KEYCLOAK_CLIENT_ID/)
    expect(() => parse({ KEYCLOAK_ISSUER: 'https://kc.test', KEYCLOAK_CLIENT_ID: 'c' }, false)).toThrow(/SESSION_SECRET/)
  })

  it('开发环境：没配登录只警告，登录未启用', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parse({}, true).enabled).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})

describe('登录模块的声明', () => {
  it('向平台提供 auth；登录流程和两个页面不经 /api 的登录闸门，头像要登录；随所有角色加载', () => {
    expect(auth.provides).toEqual([AUTH_SERVICE])
    expect(auth.roles).toEqual([...ALL_ROLES])
    const table = buildRouteTable((auth.routes ?? []).map((route) => ({ ...route, owner: 'auth' })))
    expect(table.match('/api/auth/callback')?.access).toBe('public')
    expect(table.match('/api/avatars/x.svg')?.access).toBe('user')
    expect(table.match(LOGIN_PATH)?.role).toBe('web')
    expect(table.match(LOGIN_DONE_PATH)?.role).toBe('web')
  })
})
