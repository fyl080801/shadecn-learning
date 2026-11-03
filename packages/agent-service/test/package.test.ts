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

describe('包的依赖边界（docs/31 §4.1）', () => {
  it('package.json 不声明 @shadecn/*；注入 token、实体基类、yjs 所在的包都是 peerDependency，进程里只有应用装的那一份', () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    expect(declared.filter((name) => name.startsWith('@shadecn/'))).toEqual([])
    for (const name of ['@learning/canvas', '@learning/cluster', '@learning/collab', '@learning/config', '@learning/contracts', '@learning/data-access', '@learning/foundation', '@learning/session', '@learning/storage', '@mikro-orm/core', '@nestjs/common', '@nestjs/core', 'yjs']) {
      expect(manifest.peerDependencies[name], name).toBeDefined()
      expect(manifest.dependencies?.[name], name).toBeUndefined()
    }
    expect(manifest.peerDependencies['@mikro-orm/core']).toBe('7.2.5')
  })

  it('agent-core 和 llm 是自己的依赖：都没有注入 token，也没有要和别的包共用一份的实体类', () => {
    expect(manifest.dependencies).toEqual({ '@learning/agent-core': 'workspace:*', '@learning/llm': 'workspace:*' })
    for (const dir of ['../agent-core/src', '../llm/src']) {
      for (const file of fs.readdirSync(path.resolve(packageDir, dir), { recursive: true, encoding: 'utf8' })) {
        if (!file.endsWith('.ts')) continue
        expect(fs.readFileSync(path.resolve(packageDir, dir, file), 'utf8'), file).not.toMatch(/from '@(nestjs|mikro-orm)\//)
      }
    }
  })

  it('源码和测试都不 import @shadecn/*，@mikro-orm/ 下只用 core；源码不直接 import Hocuspocus（经 CollabServer 拿）', () => {
    for (const dir of ['src', 'test']) {
      for (const { file, code } of sources(dir)) {
        expect(code, file).not.toMatch(/(from|import\()\s*'@shadecn\//)
        expect(code, file).not.toMatch(/(from|import\()\s*'@mikro-orm\/(?!core')/)
      }
    }
    for (const { file, code } of sources('src')) expect(code, file).not.toMatch(/from '@hocuspocus\//)
  })

  it('不仿造 server-kit 的内核：没有 kernel、ports、defineModule、lazySingleton，模块级可变状态放 provider', () => {
    for (const { file, code } of sources('src')) {
      expect(code, file).not.toMatch(/defineModule|ctx\.service|defineModuleConfig|lazySingleton/)
      expect(code, file).not.toMatch(/^(export )?(let|var) /m)
      expect(code, file).not.toMatch(/^(export )?const \w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m)
    }
  })

  it('配置类的环境变量经 ConfigService.env；process.env 只在 sandbox.ts：沙箱子进程的 PATH 和找引擎 socket 是本进程的运行环境', () => {
    for (const { file, code } of sources('src')) {
      if (file === 'sandbox.ts') continue
      expect(code, file).not.toMatch(/[^`]process\.env/)
    }
  })

  it('没有 k8s 驱动的代码（docs/31 §3.2）：只有写了 k8s 时的那句原因', () => {
    for (const { file, code } of sources('src')) {
      expect(code, file).not.toMatch(/createK8sDriver|createKubeClient|K8S_LABELS|sandbox\/drivers\/k8s/)
    }
  })

  it('src 里 import 的每个包都声明了：tsc 不查这个，缺了到产物运行时才炸', () => {
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
    const imported = new Set<string>()
    for (const { code } of sources('src')) {
      for (const [, specifier] of code.matchAll(/(?:from|import\()\s*'([^'.][^']*)'/g)) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        const parts = specifier.split('/')
        imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!)
      }
    }
    expect([...imported].filter((name) => !declared.has(name))).toEqual([])
  })

  it('test 里 import 的每个包都声明了（vitest 是仓库级工具，在根上）', () => {
    const declared = new Set([...Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }), 'vitest'])
    const imported = new Set<string>()
    for (const { code } of sources('test')) {
      for (const [, specifier] of code.matchAll(/(?:from|import\()\s*'([^'.][^']*)'/g)) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        const parts = specifier.split('/')
        imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!)
      }
    }
    expect([...imported].filter((name) => !declared.has(name))).toEqual([])
  })

  it('和 data-access、collab、agent-core 用的是同一份 @mikro-orm/core、yjs：两份的话 instanceof 全错，画布静默变空', () => {
    const real = (from: string, name: string) => fs.realpathSync(path.join(from, 'node_modules', name))
    expect(real(packageDir, '@mikro-orm/core')).toBe(real(path.resolve(packageDir, '../data-access'), '@mikro-orm/core'))
    expect(real(packageDir, 'yjs')).toBe(real(path.resolve(packageDir, '../collab'), 'yjs'))
    expect(real(packageDir, 'yjs')).toBe(real(path.resolve(packageDir, '../agent-core'), 'yjs'))
    expect(real(packageDir, '@hocuspocus/server')).toBe(real(path.resolve(packageDir, '../collab'), '@hocuspocus/server'))
  })

  it('用途串固定，且不可能是一个会话 token（43 位 base64url）：派生和会话 id 是同一个 HMAC', () => {
    const options = fs.readFileSync(path.join(packageDir, 'src/options.ts'), 'utf8')
    const purpose = /AGENT_TOKEN_SECRET_PURPOSE = '([^']+)'/.exec(options)?.[1]
    expect(purpose).toBe('agent:run-token')
    expect(purpose).not.toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
