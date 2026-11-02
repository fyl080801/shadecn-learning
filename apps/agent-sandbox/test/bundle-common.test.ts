import { describe, expect, it } from 'vitest'
import { externalPackagesOf, packageName, resolveBuildId } from '../../../scripts/bundle-common.mjs'

describe('packageName', () => {
  it.each([
    ['yjs', 'yjs'],
    ['y-protocols/sync', 'y-protocols'],
    ['@earendil-works/pi-ai', '@earendil-works/pi-ai'],
    ['@earendil-works/pi-ai/providers/all', '@earendil-works/pi-ai'],
  ])('%s → %s', (specifier, name) => {
    expect(packageName(specifier)).toBe(name)
  })

  it.each(['node:path', './chunk.js', '../x.js'])('%s 不是第三方包', (specifier) => {
    expect(packageName(specifier)).toBeUndefined()
  })
})

describe('externalPackagesOf', () => {
  it('只收 external 的第三方包，子路径归到包名，去重后排序', () => {
    const entries = {
      'a.js': {
        imports: [
          { path: 'yjs', external: true },
          { path: '@scope/pkg/sub', external: true },
          { path: 'node:fs', external: true },
          { path: 'chunk.js' },
        ],
      },
      'b.js': { imports: [{ path: '@scope/pkg', external: true }] },
    }
    expect(externalPackagesOf(entries)).toEqual(['@scope/pkg', 'yjs'])
  })
})

describe('resolveBuildId', () => {
  it('AGENT_BUILD_ID 给了就原样用（去掉首尾空白）：pnpm build 靠它让服务端和沙箱拿到同一个', () => {
    expect(resolveBuildId({ AGENT_BUILD_ID: ' abc-123.x_y ' })).toBe('abc-123.x_y')
  })

  it('没给或为空 → 每次生成一个新的', () => {
    const generated = resolveBuildId({})
    expect(generated).toMatch(/^[a-z0-9]+-[0-9a-f]{6}$/)
    expect(resolveBuildId({ AGENT_BUILD_ID: '  ' })).not.toBe(generated)
  })

  it.each(['source', 'has space', 'x'.repeat(65), 'a/b'])('不合法的 AGENT_BUILD_ID（%s）→ 直接失败，不让软提示悄悄失效', (value) => {
    expect(() => resolveBuildId({ AGENT_BUILD_ID: value })).toThrow(/AGENT_BUILD_ID 不合法/)
  })
})
