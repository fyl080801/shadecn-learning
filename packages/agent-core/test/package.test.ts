import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const packageDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

function sources(dir: string) {
  return fs
    .readdirSync(path.join(packageDir, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== 'package.test.ts')
    .map((file) => ({ file, code: fs.readFileSync(path.join(packageDir, dir, file), 'utf8') }))
}

/** 一个源文件 import / export from / 动态 import 的全部说明符（默认含只有类型的；含没有 from 的副作用 import）。 */
function specifiers(code: string, withTypes = true): string[] {
  // 整条 `import type … from` / `export type … from` 编译后消失；`import { type A, b }` 仍算运行时
  const text = withTypes ? code : code.replace(/(?:import|export)\s+type\s[^;']*?from\s+'[^']+'/g, '')
  return [...text.matchAll(/(?:\bfrom|\bimport\(?)\s*'([^']+)'/g)].map((match) => match[1]!)
}

/** 从入口出发沿相对 import 走出的文件集合；`withTypes` = false 时只算运行时（bundle 里真有的）。 */
function closure(entry: string, withTypes = true): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const stack = [path.join(packageDir, 'src', entry)]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiers(fs.readFileSync(file, 'utf8'), withTypes)) {
      if (specifier.startsWith('.')) stack.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')))
      else bare.add(specifier)
    }
  }
  return { files: [...seen].map((file) => path.relative(path.join(packageDir, 'src'), file)).sort(), bare }
}

describe('包的依赖边界（docs/31 §4.1）', () => {
  it('package.json 不声明 @shadecn/*、@nestjs/*、@mikro-orm/*，@learning/* 只有 contracts（peer）和 llm', () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
    const names = Object.keys(all)
    expect(names.filter((name) => /^@(shadecn|nestjs|mikro-orm)\//.test(name))).toEqual([])
    expect(names.filter((name) => name.startsWith('@learning/')).sort()).toEqual(['@learning/contracts', '@learning/llm'])
    expect(manifest.peerDependencies['@learning/contracts']).toBe('workspace:*')
    expect(manifest.peerDependencies['@learning/llm']).toBeUndefined()
    expect(manifest.dependencies['@learning/llm']).toBe('workspace:*')
  })

  it('源码和测试不 import @shadecn/*、@nestjs/*、@mikro-orm/*、别的 @learning 业务包', () => {
    for (const dir of ['src', 'test']) {
      for (const { file, code } of sources(dir)) {
        for (const specifier of specifiers(code)) {
          expect(specifier, file).not.toMatch(/^@(shadecn|nestjs|mikro-orm)\//)
          if (specifier.startsWith('@learning/')) expect(specifier, file).toMatch(/^@learning\/(contracts|llm)\//)
        }
      }
    }
  })

  it('pi 两个包和 yaml 是自己的依赖（不是 peer）；yjs 是 peer', () => {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'yaml']) {
      expect(manifest.dependencies[name], name).toBeDefined()
      expect(manifest.peerDependencies?.[name], name).toBeUndefined()
    }
    expect(manifest.peerDependencies.yjs).toBeDefined()
    expect(manifest.dependencies.yjs).toBeUndefined()
  })

  it('src 里 import 的每个包都声明了：tsc 不查这个，缺了到产物运行时才炸', () => {
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
    const imported = new Set<string>()
    for (const { code } of sources('src')) {
      for (const specifier of specifiers(code)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:') || builtinModules.includes(specifier)) continue
        const parts = specifier.split('/')
        imported.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!)
      }
    }
    expect([...imported].filter((name) => !declared.has(name))).toEqual([])
  })

  it('src 没有顶层 let / var：运行状态都在 createAgentRuntime 的闭包里，一个进程里起几个运行时互不串', () => {
    for (const { file, code } of sources('src')) {
      const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.ES2023, true)
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue
        expect(statement.declarationList.flags & ts.NodeFlags.Const, `${file}:${statement.getText().slice(0, 60)}`).toBeTruthy()
      }
    }
  })

  it('不搬 k8s 驱动，也不带模型选择（归 @learning/llm）', () => {
    const files = fs.readdirSync(path.join(packageDir, 'src'), { recursive: true, encoding: 'utf8' })
    expect(files.filter((file) => /k8s|kube/.test(file))).toEqual([])
    expect(files).not.toContain('model.ts')
    expect(files).not.toContain('llm-providers.ts')
    expect(Object.keys(manifest.exports).filter((key) => /k8s|kube|model$|llm-providers/.test(key))).toEqual([])
  })
})

describe('runner 的闭包（沙箱镜像只带这些）', () => {
  const runner = closure('runner/main.ts', false)

  it('连类型都不引用 @learning/llm、Nest、ORM（docs/31 §5.3），运行时也不碰服务端模块', () => {
    for (const specifier of closure('runner/main.ts').bare) expect(specifier).not.toMatch(/^@(nestjs|mikro-orm|shadecn)\/|^@learning\/llm\//)
    const serverSide = ['session.ts', 'gateway.ts', 'store.ts', 'canvas-changes.ts', 'model-stream.ts', 'title.ts', 'transcript.ts', 'testing.ts', 'agents.ts']
    expect(runner.files.filter((file) => serverSide.includes(file))).toEqual([])
    expect(runner.files.filter((file) => file.startsWith('sandbox/drivers/'))).toEqual([])
  })

  it('第三方依赖只有 pi 两个包、yjs 和 contracts', () => {
    const bare = [...runner.bare].filter((specifier) => !specifier.startsWith('node:') && !builtinModules.includes(specifier))
    const packages = new Set(bare.map((specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])))
    expect([...packages].sort()).toEqual(['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@learning/contracts', 'yjs'])
  })
})

describe('exports', () => {
  it('每个子路径都有对应源文件，且都带 source / types / default 三个条件', () => {
    for (const [key, value] of Object.entries<string | Record<string, string>>(manifest.exports)) {
      if (key === './package.json') continue
      expect(Object.keys(value), key).toEqual(['source', 'types', 'default'])
      const entry = value as Record<string, string>
      expect(fs.existsSync(path.join(packageDir, entry.source!)), key).toBe(true)
      expect(entry.types, key).toBe(entry.source!.replace('./src/', './dist/').replace(/\.ts$/, '.d.ts'))
      expect(entry.default, key).toBe(entry.source!.replace('./src/', './dist/').replace(/\.ts$/, '.js'))
    }
  })

  it('驱动按子路径导出：process、oci、engine、inline；包内没有聚合入口', () => {
    expect(Object.keys(manifest.exports)).toEqual(
      expect.arrayContaining(['./sandbox/drivers/process', './sandbox/drivers/oci', './sandbox/drivers/engine', './sandbox/drivers/inline']),
    )
    expect(Object.keys(manifest.exports)).not.toContain('./sandbox/drivers')
  })

  it('包里每个 src 文件都能从 exports 出发到达（不会有永远用不上的文件）', () => {
    const reachable = new Set<string>()
    for (const value of Object.values<string | Record<string, string>>(manifest.exports)) {
      if (typeof value === 'string') continue
      for (const file of closure(value.source!.replace('./src/', '')).files) reachable.add(file)
    }
    const all = fs.readdirSync(path.join(packageDir, 'src'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'))
    expect(all.filter((file) => !reachable.has(file)).sort()).toEqual([])
  })

  it('资源文件随包走：agents/*.md、skills/README.md 在包根，源码路径下能找到', () => {
    for (const file of ['agents/canvas.md', 'agents/reviewer.md', 'skills/README.md']) expect(fs.existsSync(path.join(packageDir, file)), file).toBe(true)
  })
})
