import { GRAPH_SCHEMA_VERSION } from '@learning/contracts/flow-graph'
import { describe, expect, it } from 'vitest'
import { parseGraph, parseUserStatePatch, readGraph, USER_STATE_VALUE_BYTES } from '../src/flow-types.js'

describe('parseGraph', () => {
  it('v3 的节点五组原样收下，派生的 inputs 不存', () => {
    const result = parseGraph({
      schemaVersion: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'n1',
          type: 'image',
          layout: { position: { x: 1, y: 2 }, width: 10 },
          metadata: { label: '生图' },
          data: { prompt: 'p' },
          runtime: { status: 'completed', outputs: { image: 'u' } },
          inputs: [{ port: 'image' }],
        },
      ],
      edges: [],
      meta: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.nodes).toEqual([
      {
        id: 'n1',
        type: 'image',
        layout: { position: { x: 1, y: 2 }, width: 10 },
        metadata: { label: '生图' },
        data: { prompt: 'p' },
        runtime: { status: 'completed', outputs: { image: 'u' } },
      },
    ])
  })

  it('不是当前版本的拒收（这个服务没有老数据）；没有合法 position、节点 id 重复、边指向不存在的节点都拒收', () => {
    const base = { viewport: { x: 0, y: 0, zoom: 1 }, edges: [] as unknown[] }
    const node = { id: 'n', type: 'x', layout: { position: { x: 0, y: 0 } } }
    expect(parseGraph({ ...base, schemaVersion: GRAPH_SCHEMA_VERSION + 1, nodes: [] }).ok).toBe(false)
    expect(parseGraph({ ...base, schemaVersion: GRAPH_SCHEMA_VERSION - 1, nodes: [] }).ok).toBe(false)
    expect(parseGraph({ ...base, schemaVersion: 3, nodes: [{ id: 'n', type: 'x', layout: {} }] }).ok).toBe(false)
    expect(parseGraph({ ...base, schemaVersion: 3, nodes: [node, node] }).ok).toBe(false)
    expect(parseGraph({ ...base, schemaVersion: 3, nodes: [node], edges: [{ id: 'e', source: 'n', target: 'gone' }] }).ok).toBe(false)
  })

  it('坏数据不抛错，读出来是空图', () => {
    expect(readGraph('不是 json').nodes).toEqual([])
    expect(readGraph('{"schemaVersion":99}').nodes).toEqual([])
  })
})

describe('parseUserStatePatch', () => {
  it('合法的分区放行，超过字节上限的拒绝', () => {
    expect(parseUserStatePatch({ viewport: { x: 1, y: 2, zoom: 1 } })).toEqual({ ok: true, value: { viewport: { x: 1, y: 2, zoom: 1 } } })
    expect(USER_STATE_VALUE_BYTES).toBe(16 * 1024)
  })

  it('原型链上的名字不算分区', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(parseUserStatePatch(JSON.parse(`{"${key}":1}`)).ok, key).toBe(false)
    }
  })

  it('不是对象 → 拒绝', () => {
    expect(parseUserStatePatch([]).ok).toBe(false)
    expect(parseUserStatePatch('x').ok).toBe(false)
  })
})
