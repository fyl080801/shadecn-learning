import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

function sources(dir: string) {
  return fs
    .readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== 'package.test.ts')
    .map((file) => ({ file, code: fs.readFileSync(path.join(packageDir, dir, file), 'utf8') }))
}

describe('包的依赖边界', () => {
  it('package.json 不声明 @shadecn/*；data-access、config、cluster、@mikro-orm/core 是 peerDependency，进程里只有应用装的那一份', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    for (const name of ['@learning/data-access', '@learning/config', '@learning/cluster', '@learning/contracts', '@mikro-orm/core']) {
      expect(manifest.peerDependencies[name], name).toBeDefined()
      expect(manifest.dependencies?.[name], name).toBeUndefined()
    }
    expect(manifest.peerDependencies['@mikro-orm/core']).toBe('7.2.5')
  })

  it('源码和测试都不 import @shadecn/*，@mikro-orm/ 下只用 core（驱动的选择归 data-access）', () => {
    for (const dir of ['src', 'test']) {
      for (const { file, code } of sources(dir)) {
        expect(code, file).not.toMatch(/(from|import\()\s*'@shadecn\//)
        expect(code, file).not.toMatch(/(from|import\()\s*'@mikro-orm\/(?!core')/)
      }
    }
  })

  it('src 里 import 的每个包都声明了：tsc 不查这个，缺了到产物运行时才炸', () => {
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
    const imported = new Set<string>()
    for (const { code } of sources('src')) {
      for (const [, specifier] of code.matchAll(/(?:from|import\()\s*'([^'.][^']*)'/g)) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        const parts = specifier.split('/')
        imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
      }
    }
    expect([...imported].filter((name) => !declared.has(name))).toEqual([])
  })

  it('和 data-access 用的是同一份 @mikro-orm/core：两份的话实体基类和异常类的 instanceof 全错', () => {
    const real = (from: string) => fs.realpathSync(path.join(from, 'node_modules/@mikro-orm/core'))
    expect(real(packageDir)).toBe(real(path.resolve(packageDir, '../data-access')))
  })
})
