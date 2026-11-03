import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const appDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> }

function sources(dir: string) {
  return fs
    .readdirSync(path.join(appDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|mjs)$/.test(file) && file !== 'package.test.ts')
    .map((file) => ({ file, code: fs.readFileSync(path.join(appDir, dir, file), 'utf8') }))
}

describe('依赖边界', () => {
  it('不依赖、不 import @shadecn/*，也不用旧服务的打包脚本 scripts/bundle-common.mjs', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    for (const dir of ['scripts', 'test']) {
      for (const { file, code } of sources(dir)) {
        expect(code, file).not.toMatch(/(from|import\()\s*'@shadecn\//)
        expect(code, file).not.toMatch(/from\s*'[^']*bundle-common\.mjs'/)
      }
    }
  })

  it('运行时依赖不含 workspace 包：镜像里只装第三方包，workspace 包都内联进 bundle', () => {
    expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith('@learning/'))).toEqual([])
    expect(manifest.devDependencies['@learning/agent-core']).toBe('workspace:*')
    expect(manifest.devDependencies['@learning/contracts']).toBe('workspace:*')
  })
})
