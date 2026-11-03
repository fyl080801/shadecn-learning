import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

function sources(dir: string) {
  return fs
    .readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|mjs)$/.test(file) && file !== 'package.test.ts')
    .map((file) => ({ file, code: fs.readFileSync(path.join(packageDir, dir, file), 'utf8') }))
}

describe('包的依赖边界', () => {
  it('package.json 不声明 @shadecn/*；注入 token 和 yjs 所在的包都是 peerDependency，进程里只有应用装的那一份', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    for (const name of ['@learning/canvas', '@learning/cluster', '@learning/session', '@learning/contracts', '@nestjs/common', '@nestjs/core', 'yjs']) {
      expect(manifest.peerDependencies[name], name).toBeDefined()
      expect(manifest.dependencies?.[name], name).toBeUndefined()
    }
  })

  it('Hocuspocus 和 crossws 的版本线和 mod-collab 一致', () => {
    const reference = JSON.parse(fs.readFileSync(path.resolve(packageDir, '../mod-collab/package.json'), 'utf8')).peerDependencies
    expect(manifest.dependencies['@hocuspocus/server']).toBe(reference['@hocuspocus/server'])
    expect(manifest.dependencies.crossws).toBe(reference.crossws)
    expect(manifest.peerDependencies.yjs).toBe(reference.yjs)
  })

  it('源码和测试都不 import @shadecn/*，@mikro-orm/ 下只用 core，src 不碰 ORM', () => {
    for (const dir of ['src', 'test']) {
      for (const { file, code } of sources(dir)) {
        expect(code, file).not.toMatch(/(from|import\()\s*'@shadecn\//)
        expect(code, file).not.toMatch(/(from|import\()\s*'@mikro-orm\/(?!core')/)
      }
    }
    for (const { file, code } of sources('src')) expect(code, file).not.toMatch(/'@mikro-orm\//)
  })

  it('不仿造 server-kit 的内核：没有 kernel、ports、defineModule，模块级可变状态放 provider', () => {
    for (const { file, code } of sources('src')) {
      expect(code, file).not.toMatch(/defineModule|configureCollab|ctx\.service/)
      // 顶层 let 和顶层可变容器都是模块级状态。常量表和工厂不算
      expect(code, file).not.toMatch(/^let /m)
      expect(code, file).not.toMatch(/^(export )?const \w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m)
    }
  })

  it('src 里 import 的每个包都声明了：tsc 不查这个，缺了到产物运行时才炸', () => {
    const declared = new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])
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

  it('apps/platform 自己声明 yjs：peer 要应用来装，少了它产物里解析不到', () => {
    const platform = JSON.parse(fs.readFileSync(path.resolve(packageDir, '../../apps/platform/package.json'), 'utf8'))
    expect(platform.dependencies.yjs).toBe(manifest.peerDependencies.yjs)
  })

  it('一份 yjs：本包、Hocuspocus、contracts 解析到同一个文件', () => {
    const yjsFrom = (from: string) => fs.realpathSync(createRequire(path.join(from, 'package.json')).resolve('yjs'))
    const server = fs.realpathSync(path.join(packageDir, 'node_modules/@hocuspocus/server'))
    expect(yjsFrom(server)).toBe(yjsFrom(packageDir))
    expect(yjsFrom(path.resolve(packageDir, '../contracts'))).toBe(yjsFrom(packageDir))
  })
})
