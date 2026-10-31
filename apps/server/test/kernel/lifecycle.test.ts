import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerType } from '@hono/node-server'
import type { ServerApp } from '../../app.ts'
import { startModules, withDeadline } from '../../kernel/lifecycle.ts'
import { defineModule, type ModuleContext, type ServerModule } from '../../kernel/module.ts'
import { ALL_ROLES, type ServerRole } from '../../kernel/roles.ts'

const context = {
  roles: new Set<ServerRole>(ALL_ROLES),
  app: {} as ServerApp,
  server: {} as ServerType,
  isDev: true,
}

const mod = (name: string, extra: Partial<ServerModule> = {}): ServerModule =>
  defineModule({ name, roles: [...ALL_ROLES], setup() {}, ...extra })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startModules：装配与收尾', () => {
  it('setup 按顺序串行，ready 按顺序，shutdown 逆序', async () => {
    const log: string[] = []
    const make = (name: string) =>
      mod(name, {
        async setup() {
          log.push(`setup ${name}`)
          return {
            ready: () => void log.push(`ready ${name}`),
            shutdown: async () => void log.push(`shutdown ${name}`),
          }
        },
      })

    const loaded = await startModules([make('a'), make('b'), make('c')], context)
    await loaded.ready()
    await loaded.shutdown()

    expect(log).toEqual([
      'setup a', 'setup b', 'setup c',
      'ready a', 'ready b', 'ready c',
      'shutdown c', 'shutdown b', 'shutdown a',
    ])
  })

  it('后面的模块能拿到前面注册的服务；软依赖没加载时拿到 undefined', async () => {
    let seen: unknown
    let missing: unknown
    await startModules(
      [
        mod('collab', { provides: ['canvasHost'], setup: (ctx) => ctx.provide('canvasHost', { ok: true }) }),
        mod('agent', {
          setup(ctx) {
            seen = ctx.service('canvasHost')
            missing = ctx.service('storage')
          },
        }),
      ],
      context,
    )
    expect(seen).toEqual({ ok: true })
    expect(missing).toBeUndefined()
  })

  it('注册没在 provides 里声明的服务 → 失败', async () => {
    await expect(
      startModules([mod('x', { setup: (ctx: ModuleContext) => ctx.provide('svc', 1) })], context),
    ).rejects.toThrow(/没在 provides 里声明/)
  })

  it('声明了 provides 却没注册 → 失败', async () => {
    await expect(startModules([mod('x', { provides: ['svc'] })], context)).rejects.toThrow(/声明了 provides svc 却没有注册/)
  })

  it('同一个服务注册两次 → 失败', async () => {
    await expect(
      startModules(
        [
          mod('a', { provides: ['svc'], setup: (ctx) => ctx.provide('svc', 1) }),
          mod('b', { provides: ['svc'], setup: (ctx) => ctx.provide('svc', 2) }),
        ],
        context,
      ),
    ).rejects.toThrow(/已经被注册过/)
  })

  it('某个模块 setup 抛错 → 整体失败，后面的不装配', async () => {
    const later = vi.fn()
    await expect(
      startModules(
        [
          mod('a', {
            setup() {
              throw new Error('配错了')
            },
          }),
          mod('b', { setup: later }),
        ],
        context,
      ),
    ).rejects.toThrow('配错了')
    expect(later).not.toHaveBeenCalled()
  })

  it('一个模块收尾卡死 → 到上限后继续收后面的，整体不会挂住', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log: string[] = []
    const loaded = await startModules(
      [
        mod('a', { setup: () => ({ shutdown: () => void log.push('a') }) }),
        mod('stuck', {
          setup: () => ({
            shutdownTimeoutMs: 1_000,
            shutdown: () => new Promise<void>(() => {}),
          }),
        }),
      ],
      context,
    )

    const closing = loaded.shutdown()
    await vi.advanceTimersByTimeAsync(1_000)
    await closing

    expect(log).toEqual(['a'])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('模块 stuck 收尾超过 1000ms'))
  })

  it('一个模块收尾抛错 → 记一笔，后面的照收', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log: string[] = []
    const loaded = await startModules(
      [
        mod('a', { setup: () => ({ shutdown: () => void log.push('a') }) }),
        mod('bad', {
          setup: () => ({
            shutdown: () => {
              throw new Error('写库失败')
            },
          }),
        }),
      ],
      context,
    )
    await loaded.shutdown()
    expect(log).toEqual(['a'])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('模块 bad 收尾失败'), expect.any(Error))
  })

  it('shutdown 可重入：第二次调用拿到同一个 Promise，收尾只跑一次', async () => {
    const shutdown = vi.fn()
    const loaded = await startModules([mod('a', { setup: () => ({ shutdown }) })], context)
    const first = loaded.shutdown()
    const second = loaded.shutdown()
    expect(second).toBe(first)
    await first
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})

describe('withDeadline', () => {
  it('按时完成就不记任何东西', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await withDeadline(Promise.resolve(), 1_000, '落库')
    expect(error).not.toHaveBeenCalled()
  })
})
