import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { edgesMap, metaMap, nodesMap } from '../src/flow-doc.js'

const packageDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const sharedDir = path.resolve(packageDir, '../shared/src')
const copies = fs.readdirSync(path.join(packageDir, 'src')).filter((file) => file.endsWith('.ts'))

/** 只归一化相对 import 的扩展名：shared 写 `.ts`，这里编译成 ESM 要写 `.js` */
const normalize = (code: string) => code.replace(/from '(\.\/[^']+)\.(?:ts|js)'/g, "from '$1'")

describe('防漂移', () => {
  it('复制的是约定的五个文件，一个不多一个不少，和 exports 对得上', () => {
    expect([...copies].sort()).toEqual(['auth.ts', 'canvas.ts', 'collab.ts', 'flow-doc.ts', 'flow-graph.ts'])
    expect(Object.keys(manifest.exports).map((entry) => `${entry.slice(2)}.ts`).sort()).toEqual([...copies].sort())
  })

  // 文件形状对不上时画布会静默变空，所以这里只归一化 import 扩展名，不放宽
  it.each(copies)('%s 和 packages/shared/src 的同名文件逐字相同', (file) => {
    const copy = fs.readFileSync(path.join(packageDir, 'src', file), 'utf8')
    const original = fs.readFileSync(path.join(sharedDir, file), 'utf8')
    expect(normalize(copy)).toBe(normalize(original))
  })

  it('归一化只动相对 import：内容不同一定比得出来', () => {
    expect(normalize("import a from './x.ts'\nconst p = 'a.ts'")).toBe("import a from './x'\nconst p = 'a.ts'")
    expect(normalize("const NODES_KEY = 'nodes'")).not.toBe(normalize("const NODES_KEY = 'node'"))
  })

  it('相对依赖闭包完整：复制的文件只 import 本包里有的文件', () => {
    for (const file of copies) {
      const code = fs.readFileSync(path.join(packageDir, 'src', file), 'utf8')
      for (const [, target] of code.matchAll(/from '\.\/([^']+)\.js'/g)) expect(copies, file).toContain(`${target}.ts`)
    }
  })
})

describe('yjs 单份', () => {
  it('复制的代码拿到的 Y.Map 和本包的是同一个类：两份的话 instanceof 恒为 false，画布静默变空', () => {
    const doc = new Y.Doc()
    expect(nodesMap(doc)).toBeInstanceOf(Y.Map)
    expect(edgesMap(doc)).toBeInstanceOf(Y.Map)
    expect(metaMap(doc)).toBeInstanceOf(Y.Map)
    nodesMap(doc).set('n1', new Y.Map())
    expect(nodesMap(doc).get('n1')).toBeInstanceOf(Y.Map)
  })

  it('yjs 是 peer，不是 dependency；第三方依赖只有它', () => {
    expect(manifest.peerDependencies).toEqual({ yjs: '^13.6.32' })
    expect(manifest.dependencies).toBeUndefined()
    const bare = new Set<string>()
    for (const file of copies) {
      const code = fs.readFileSync(path.join(packageDir, 'src', file), 'utf8')
      for (const [, name] of code.matchAll(/from '([^'.][^']*)'/g)) bare.add(name)
    }
    expect([...bare]).toEqual(['yjs'])
  })

  it('本包解析到的 yjs 和 packages/shared 的是同一个版本目录', () => {
    const real = (from: string) => fs.realpathSync(path.dirname(createRequire(path.join(from, 'package.json')).resolve('yjs/package.json')))
    expect(real(packageDir)).toBe(real(path.resolve(packageDir, '../shared')))
  })
})
