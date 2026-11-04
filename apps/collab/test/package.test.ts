import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const appDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))

function sources(dir: string) {
  return fs
    .readdirSync(path.join(appDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|mjs)$/.test(file) && file !== 'package.test.ts')
    .map((file) => ({ file, code: fs.readFileSync(path.join(appDir, dir, file), 'utf8') }))
}

describe('依赖边界', () => {
  it('不依赖、不 import @shadecn/*', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    for (const dir of ['src', 'scripts', 'test']) {
      for (const { file, code } of sources(dir)) expect(code, file).not.toMatch(/(from|import\()\s*'@shadecn\//)
    }
  })

  it('自己声明 yjs：@learning/collab 的 peer 要应用来装', () => {
    expect(manifest.dependencies.yjs).toBeDefined()
  })

  it('src 只有 main.ts 和 AppModule，import 的每个包都是运行时依赖', () => {
    expect(fs.readdirSync(path.join(appDir, 'src')).sort()).toEqual(['app.module.ts', 'main.ts'])
    for (const { file, code } of sources('src')) {
      for (const [, specifier] of code.matchAll(/(?:from|import\()\s*'([^'.][^']*)'/g)) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        const parts = specifier.split('/')
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        expect(manifest.dependencies[name], `${file} → ${name}`).toBeDefined()
      }
    }
  })

  it('agent 不进这个进程：依赖闭包里没有 @learning/agent、agent-core、llm、apps、storage，也没有 pi', () => {
    const packagesDir = path.resolve(appDir, '../../packages')
    const manifests = new Map(
      fs
        .readdirSync(packagesDir)
        .map((dir) => path.join(packagesDir, dir, 'package.json'))
        .filter((file) => fs.existsSync(file))
        .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> })
        .map((item) => [item.name, item] as const),
    )
    const closure = new Set<string>()
    const walk = (names: string[]) => {
      for (const name of names) {
        if (closure.has(name)) continue
        closure.add(name)
        const item = manifests.get(name)
        if (item) walk(Object.keys({ ...item.dependencies, ...item.peerDependencies }))
      }
    }
    walk(Object.keys(manifest.dependencies))
    expect(closure).toContain('@learning/collab')
    expect([...closure].filter((name) => /^@learning\/(agent|agent-core|llm|apps|storage)$/.test(name) || name.startsWith('@earendil-works/'))).toEqual([])
  })

  it('新包登记过 .dockerignore 的 dist 和 test', () => {
    const root = path.resolve(appDir, '../..')
    const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n')
    expect(ignore).toEqual(expect.arrayContaining(['apps/collab/dist', 'apps/collab/test']))
  })
})
