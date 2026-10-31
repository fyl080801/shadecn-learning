import { describe, expect, it } from 'vitest'
import { defineModule, type ServerModule } from '../../src/kernel/module.ts'
import { resolveModules } from '../../src/kernel/resolve.ts'
import { ALL_ROLES, type ServerRole } from '../../src/kernel/roles.ts'

const mod = (name: string, extra: Partial<ServerModule> = {}): ServerModule =>
  defineModule({ name, roles: [...ALL_ROLES], setup() {}, ...extra })

const all = new Set<ServerRole>(ALL_ROLES)
const names = (modules: readonly ServerModule[]) => modules.map((m) => m.name)

describe('resolveModules：选模块、排依赖', () => {
  it('没有依赖时按声明顺序装配', () => {
    const { ordered, skipped } = resolveModules([mod('a'), mod('b'), mod('c')], { roles: all })
    expect(names(ordered)).toEqual(['a', 'b', 'c'])
    expect(skipped).toEqual([])
  })

  it('硬依赖排在前面，同层仍按声明顺序', () => {
    const { ordered } = resolveModules(
      [mod('agent', { dependsOn: ['collab'] }), mod('frontend'), mod('collab')],
      { roles: all },
    )
    expect(names(ordered)).toEqual(['frontend', 'collab', 'agent'])
  })

  it('软依赖加载了就排在前面，没加载当没有', () => {
    const withStorage = resolveModules([mod('agent', { optional: ['storage'] }), mod('storage')], { roles: all })
    expect(names(withStorage.ordered)).toEqual(['storage', 'agent'])

    const without = resolveModules(
      [mod('agent', { optional: ['storage'] }), mod('storage', { enabled: () => '没配 S3' })],
      { roles: all },
    )
    expect(names(without.ordered)).toEqual(['agent'])
    expect(without.skipped).toMatchObject([{ module: { name: 'storage' }, reason: 'disabled', detail: '没配 S3' }])
  })

  it('enabled() 给 false 也算关掉，原因为空', () => {
    const { skipped } = resolveModules([mod('x', { enabled: () => false })], { roles: all })
    expect(skipped).toMatchObject([{ reason: 'disabled', detail: '' }])
  })

  it('角色集和模块的 roles 没交集 → 不加载', () => {
    const { ordered, skipped } = resolveModules(
      [mod('collab', { roles: ['collab', 'agent'] }), mod('frontend', { roles: ['web'] })],
      { roles: new Set<ServerRole>(['web']) },
    )
    expect(names(ordered)).toEqual(['frontend'])
    expect(skipped).toMatchObject([{ module: { name: 'collab' }, reason: 'role' }])
  })

  it('硬依赖被关掉 → 启动失败，错误里说明缺谁、为什么', () => {
    expect(() =>
      resolveModules(
        [mod('agent', { dependsOn: ['collab'] }), mod('collab', { enabled: () => '手动关的' })],
        { roles: all },
      ),
    ).toThrow(/agent 依赖 collab.*手动关的/)
  })

  it('硬依赖不随当前角色启动 → 启动失败，错误里列出它的角色', () => {
    expect(() =>
      resolveModules(
        [mod('agent', { roles: ['agent'], dependsOn: ['collab'] }), mod('collab', { roles: ['collab'] })],
        { roles: new Set<ServerRole>(['agent']) },
      ),
    ).toThrow(/agent 依赖 collab.*不随当前角色启动.*collab/)
  })

  it('硬依赖根本不存在 → 启动失败', () => {
    expect(() => resolveModules([mod('agent', { dependsOn: ['nope' as string] })], { roles: all })).toThrow(
      /agent 依赖 nope.*没有这个模块/,
    )
  })

  it('依赖成环 → 启动失败', () => {
    expect(() =>
      resolveModules([mod('a', { dependsOn: ['b'] }), mod('b', { optional: ['a'] })], { roles: all }),
    ).toThrow(/成环/)
  })

  it('模块名重复 → 启动失败', () => {
    expect(() => resolveModules([mod('a'), mod('a')], { roles: all })).toThrow(/重复/)
  })
})
