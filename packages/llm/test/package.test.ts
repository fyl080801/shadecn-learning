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
  it('package.json 不声明 @shadecn/*，也不依赖别的 @learning/* 包：这条通路谁都能直接依赖', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/') || name.startsWith('@learning/'))).toEqual([])
  })

  it('源码和测试都不 import @shadecn/*、@learning/*、@nestjs/*：没有 DI token，不认识宿主', () => {
    for (const dir of ['src', 'test']) {
      for (const { file, code } of sources(dir)) {
        expect(code, file).not.toMatch(/(from|import\()\s*'@(shadecn|learning|nestjs)\//)
      }
    }
  })

  it('pi-ai 是自己的依赖（不是 peer），版本和 @shadecn/mod-apps 一致', () => {
    const reference = JSON.parse(fs.readFileSync(path.resolve(packageDir, '../mod-apps/package.json'), 'utf8')).peerDependencies
    expect(manifest.dependencies['@earendil-works/pi-ai']).toBe(reference['@earendil-works/pi-ai'])
    expect(manifest.peerDependencies?.['@earendil-works/pi-ai']).toBeUndefined()
  })

  it('不读 process.env：key 经宿主给的 envVar 读', () => {
    for (const { file, code } of sources('src')) expect(code, file).not.toMatch(/[^`]process\.env/)
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

  it('exports 的每个子路径都有对应源文件，src 里的每个文件都导出了', () => {
    const exported = Object.keys(manifest.exports).map((key) => key.slice(2))
    const files = fs.readdirSync(path.join(packageDir, 'src')).map((file) => file.replace(/\.ts$/, ''))
    expect(exported.sort()).toEqual(files.sort())
  })

  it('apps 依赖它是普通依赖（它没有 DI token），且 apps 不再留着 src/llm/', () => {
    const apps = JSON.parse(fs.readFileSync(path.resolve(packageDir, '../apps/package.json'), 'utf8'))
    expect(apps.dependencies['@learning/llm']).toBe('workspace:*')
    expect(apps.peerDependencies?.['@learning/llm']).toBeUndefined()
    expect(fs.existsSync(path.resolve(packageDir, '../apps/src/llm'))).toBe(false)
  })
})
