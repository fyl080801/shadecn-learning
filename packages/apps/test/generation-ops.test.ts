import fs from 'node:fs'
import path from 'node:path'
import { nodesMap, toYEdge, toYNode } from '@learning/contracts/flow-doc'
import { FlowOpError, opContext } from '@learning/contracts/flow-ops-core'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { appendGeneratedText, attachAsset, hasIncomingEdges, readNodeRecord, recordGeneration } from '../src/generation-ops.js'
import { nodeRecord } from './helpers.js'

const FUNCTIONS = ['readNodeRecord', 'requireNodeRecord', 'hasIncomingEdges', 'attachAsset', 'recordGeneration', 'appendGeneratedText']
const here = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8')

function sourceOf(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`[test] 找不到函数 ${name}`)
  return code.slice(start, code.indexOf('\n}\n', start) + 3)
}

describe('防漂移', () => {
  // 文档形状对不上时节点会静默写坏，所以这里逐字比较，不放宽
  it.each(FUNCTIONS)('%s 和 packages/shared/src/flow-ops.ts 里的逐字相同', (name) => {
    expect(sourceOf(here('../src/generation-ops.ts'), name)).toBe(sourceOf(here('../../shared/src/flow-ops.ts'), name))
  })

  it('摘录没有多出别的函数', () => {
    expect([...here('../src/generation-ops.ts').matchAll(/^(?:export )?function (\w+)\(/gm)].map((match) => match[1])).toEqual(FUNCTIONS)
  })
})

describe('写回节点的原子操作', () => {
  function docWith(...nodes: ReturnType<typeof nodeRecord>[]) {
    const doc = new Y.Doc()
    doc.transact(() => {
      for (const node of nodes) nodesMap(doc).set(node.id, toYNode(node))
    })
    return { doc, ctx: opContext(doc) }
  }

  it('recordGeneration：挂上素材并留进历史；同一个 id 再记只有一条；首次生成时节点上已有的图补成第一条', () => {
    const { ctx } = docWith(nodeRecord('n', 'image', { src: 'https://old/a.png' }))
    recordGeneration(ctx, 'n', { id: 't1', src: 'https://new/b.png', createdAt: 100 })
    recordGeneration(ctx, 'n', { id: 't1', src: 'https://new/b.png', createdAt: 200 })
    const { data } = readNodeRecord(ctx, 'n')!
    expect(data).toMatchObject({ src: 'https://new/b.png', form: 'asset' })
    expect(data['gen.t1']).toEqual({ src: 'https://new/b.png', createdAt: 200 })
    expect(data['gen.original']).toEqual({ src: 'https://old/a.png', createdAt: 99 })
  })

  it('有连入的线就保持 generate 形态；不能挂素材的类型抛 NO_FORMS，文档不动', () => {
    const { doc, ctx } = docWith(nodeRecord('src', 'text'), nodeRecord('n', 'image'))
    ctx.edges.set('e', toYEdge({ id: 'e', source: 'src', target: 'n', sourceHandle: 'out', targetHandle: 'in', type: 'default', data: {} } as never))
    expect(hasIncomingEdges(ctx, 'n')).toBe(true)
    expect(attachAsset(ctx, 'n', { src: 'x' })).toBe('generate')
    const before = Y.encodeStateAsUpdate(doc)
    expect(() => attachAsset(ctx, 'src', { src: 'x' })).toThrow(FlowOpError)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('appendGeneratedText：接在已有正文后面；不输出文字的节点、空文字都不写', () => {
    const { ctx } = docWith(nodeRecord('t', 'text', { text: '我写的\n' }), nodeRecord('i', 'image'))
    expect(appendGeneratedText(ctx, 't', ' 生成的 ')).toBe(true)
    expect(readNodeRecord(ctx, 't')!.data.text).toBe('我写的\n\n生成的')
    expect(appendGeneratedText(ctx, 't', '   ')).toBe(false)
    expect(appendGeneratedText(ctx, 'i', '文字')).toBe(false)
    expect(readNodeRecord(ctx, 'i')!.data.text).toBeUndefined()
  })
})
