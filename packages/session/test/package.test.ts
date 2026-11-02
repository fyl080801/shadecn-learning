import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = path.resolve(import.meta.dirname, '..')

describe('包的依赖边界（实体单例不变式）', () => {
  it('package.json 不声明 @shadecn/*，data-access 和 config 是 peerDependency', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    expect(manifest.peerDependencies['@learning/data-access']).toBeDefined()
    expect(manifest.dependencies?.['@learning/data-access']).toBeUndefined()
    expect(manifest.peerDependencies['@learning/config']).toBeDefined()
    expect(manifest.dependencies?.['@learning/config']).toBeUndefined()
  })

  it('源码和测试都不 import @shadecn/* 或 @mikro-orm/*：实体、纯函数、异常类都从 data-access 拿', () => {
    for (const dir of ['src', 'test']) {
      for (const file of fs.readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })) {
        if (!file.endsWith('.ts') || file === 'package.test.ts') continue
        const code = fs.readFileSync(path.join(packageDir, dir, file), 'utf8')
        expect(code, file).not.toMatch(/from '(@shadecn|@mikro-orm)\//)
      }
    }
  })
})
