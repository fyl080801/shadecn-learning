import { nodesMap, toYEdge, toYNode } from '@learning/contracts/flow-doc'
import { appendGeneratedText, attachAsset, hasIncomingEdges, readNodeRecord, recordGeneration } from '@learning/contracts/flow-ops'
import { FlowOpError, opContext } from '@learning/contracts/flow-ops-core'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { nodeRecord } from './helpers.js'

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
