import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { isAgentOrigin } from '@shadecn/shared/agent'
import { edgesMap, fromYEdge, fromYNode, nodesMap, toYEdge, toYNode } from '@shadecn/shared/flow-doc'
import { defaultEdgeData, defaultNodeData, type FlowNode } from '@shadecn/shared/flow-graph'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createCanvasTools, placeNewNode, TOOL_LIMITS, type CanvasTool } from '../src/tools.ts'

/**
 * 画布工具直接对一个内存里的 Y.Doc 测 —— 工具只认 `CanvasHandle`，不认识 Hocuspocus。
 * 守的是：写进去的形状和前端建的一样、按 key 合并、先校验后动手（出错不留半截）、删除预算。
 */

function seed(doc: Y.Doc, nodes: FlowNode[]) {
  doc.transact(() => {
    for (const node of nodes) nodesMap(doc).set(node.id, toYNode(node))
  })
}

function textNode(id: string, label: string, text = '', position = { x: 0, y: 0 }): FlowNode {
  return { id, type: 'text', position, data: defaultNodeData(label, { text }) }
}

function setup(nodes: FlowNode[] = [], guard?: () => void) {
  const doc = new Y.Doc()
  seed(doc, nodes)
  const origins: unknown[] = []
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin)
  })
  const canvas = createDocCanvasHandle(doc, { flowId: 'f1', runId: 'run_1', guard })
  const tools = new Map(createCanvasTools({ canvas }).map((tool) => [tool.name, tool]))
  const call = (name: string, args: unknown) => (tools.get(name) as CanvasTool).execute('call', args as never)
  return { doc, origins, call }
}

function node(doc: Y.Doc, id: string) {
  const value = nodesMap(doc).get(id)
  return value ? fromYNode(id, value) : null
}

function edges(doc: Y.Doc) {
  return [...edgesMap(doc).entries()].map(([id, value]) => fromYEdge(id, value)!)
}

describe('add_node', () => {
  it('建出来的文本节点和前端建的同形：框架字段 + text，origin 是 agent', async () => {
    const { doc, origins, call } = setup()
    const res = await call('add_node', { type: 'text', label: '标题', text: '正文' })
    const { id } = JSON.parse((res.content[0] as { text: string }).text) as { id: string }

    expect(id).toMatch(/^n_[0-9a-z]+_[0-9a-z]{8}$/)
    const created = node(doc, id)!
    expect(created.type).toBe('text')
    expect(created.data).toMatchObject({ label: '标题', status: 'idle', text: '正文' })
    expect(typeof created.data.createdAt).toBe('number')
    expect(origins).toHaveLength(1)
    expect(isAgentOrigin(origins[0])).toBe(true)
    expect(res.details.summary).toBe('新建节点「标题」')
  })

  it('带 connectFrom：节点和连线在同一个事务里出现，边的形状照前端 onConnect', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    const res = await call('add_node', { type: 'process', label: 'B', connectFrom: 'a' })
    const { id, edgeId } = JSON.parse((res.content[0] as { text: string }).text) as { id: string; edgeId: string }

    expect(origins).toHaveLength(1)
    const [edge] = edges(doc)
    expect(edge).toMatchObject({
      id: edgeId,
      source: 'a',
      target: id,
      sourceHandle: null,
      targetHandle: null,
      type: 'default',
      animated: false,
    })
    expect(typeof edge!.data.createdAt).toBe('number')
    // 自动摆放：放在来源节点右边，不和它重叠
    expect(node(doc, id)!.position.x).toBeGreaterThan(300)
  })

  it('connectFrom 指向不存在的节点 → 报错，画布一个字节都没变', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    await expect(call('add_node', { type: 'text', label: 'X', connectFrom: 'ghost' })).rejects.toThrow('不存在')
    expect(nodesMap(doc).size).toBe(1)
    expect(origins).toHaveLength(0)
  })

  it('流程节点不收正文', async () => {
    const { call } = setup()
    await expect(call('add_node', { type: 'process', label: 'P', text: '正文' })).rejects.toThrow('只有 text')
  })
})

describe('update_node', () => {
  it('只改给出的 key：别人同时改的字段和 data 里的其他键都留着', async () => {
    const { doc, call } = setup([textNode('a', '旧名', '旧正文')])
    ;(nodesMap(doc).get('a')!.get('data') as Y.Map<unknown>).set('custom', 42)

    await call('update_node', { id: 'a', text: '新正文' })
    expect(node(doc, 'a')!.data).toMatchObject({ label: '旧名', text: '新正文', custom: 42 })

    await call('update_node', { id: 'a', label: '新名' })
    expect(node(doc, 'a')!.data).toMatchObject({ label: '新名', text: '新正文' })
  })

  it('节点不存在 → 报错；什么都不给 → 报错', async () => {
    const { call } = setup([textNode('a', 'A')])
    await expect(call('update_node', { id: 'nope', label: 'x' })).rejects.toThrow('不存在')
    await expect(call('update_node', { id: 'a' })).rejects.toThrow('至少')
  })

  it('非文本节点改正文 → 拒绝', async () => {
    const { doc, call } = setup()
    seed(doc, [{ id: 'p', type: 'process', position: { x: 0, y: 0 }, data: defaultNodeData('P') }])
    await expect(call('update_node', { id: 'p', text: '正文' })).rejects.toThrow('不是文本节点')
  })
})

describe('connect', () => {
  it('两端存在才连；同方向不重复；不连自己', async () => {
    const { doc, call } = setup([textNode('a', 'A'), textNode('b', 'B')])
    const res = await call('connect', { source: 'a', target: 'b', label: '下一步' })
    expect(res.details.summary).toBe('连线「A」 → 「B」')
    expect(edges(doc)[0]).toMatchObject({ source: 'a', target: 'b', label: '下一步' })

    await expect(call('connect', { source: 'a', target: 'b' })).rejects.toThrow('已经有')
    await expect(call('connect', { source: 'a', target: 'x' })).rejects.toThrow('不存在')
    await expect(call('connect', { source: 'a', target: 'a' })).rejects.toThrow('同一个')
    expect(edges(doc)).toHaveLength(1)
  })
})

describe('delete_elements', () => {
  it('删节点连带删边；删分组只解散，子节点换算回画布坐标', async () => {
    const { doc, call } = setup()
    seed(doc, [
      { id: 'g', type: 'group', position: { x: 100, y: 200 }, width: 500, height: 300, data: defaultNodeData('组') },
      { ...textNode('child', '子', '', { x: 10, y: 20 }), parentNode: 'g', extent: 'parent' },
      textNode('a', 'A'),
      textNode('b', 'B'),
    ])
    doc.transact(() => {
      edgesMap(doc).set(
        'e1',
        toYEdge({ id: 'e1', source: 'a', target: 'b', sourceHandle: null, targetHandle: null, data: defaultEdgeData() }),
      )
    })

    const res = await call('delete_elements', { ids: ['g', 'a'] })
    expect(nodesMap(doc).has('g')).toBe(false)
    expect(nodesMap(doc).has('a')).toBe(false)
    expect(edgesMap(doc).has('e1')).toBe(false)

    const child = node(doc, 'child')!
    expect(child.parentNode).toBeUndefined()
    expect(child.extent).toBeUndefined()
    expect(child.position).toEqual({ x: 110, y: 220 })
    expect(res.details.elementIds).toEqual(expect.arrayContaining(['g', 'a', 'e1']))
  })

  it('有一个 id 不存在就整个拒绝，不删半截', async () => {
    const { doc, call } = setup([textNode('a', 'A')])
    await expect(call('delete_elements', { ids: ['a', 'ghost'] })).rejects.toThrow('ghost')
    expect(nodesMap(doc).has('a')).toBe(true)
  })

  it('一轮的删除预算用完 → 拒绝', async () => {
    const nodes = Array.from({ length: TOOL_LIMITS.deletePerRun + 5 }, (_, i) => textNode(`n${i}`, `N${i}`))
    const { doc, call } = setup(nodes)
    const first = nodes.slice(0, TOOL_LIMITS.deletePerRun - 2).map((n) => n.id)
    await call('delete_elements', { ids: first })
    await expect(call('delete_elements', { ids: ['n20', 'n21', 'n22'] })).rejects.toThrow('每轮上限')
    expect(nodesMap(doc).size).toBe(nodes.length - first.length)
  })
})

describe('read_canvas', () => {
  it('精简视图：id / 类型 / 名字 / 正文摘要；超长正文截断', async () => {
    const { call } = setup([textNode('a', 'A', 'x'.repeat(1000))])
    const res = await call('read_canvas', {})
    const snapshot = JSON.parse((res.content[0] as { text: string }).text)
    expect(snapshot.nodeCount).toBe(1)
    expect(snapshot.nodes[0]).toMatchObject({ id: 'a', type: 'text', label: 'A' })
    expect(snapshot.nodes[0].text.length).toBeLessThan(500)
    expect(snapshot.nodes[0].text).toContain('已截断')
  })

  it('节点太多时截断并说明', async () => {
    const nodes = Array.from({ length: TOOL_LIMITS.readNodes + 3 }, (_, i) => textNode(`n${i}`, `N${i}`))
    const { call } = setup(nodes)
    const snapshot = JSON.parse(((await call('read_canvas', {})).content[0] as { text: string }).text)
    expect(snapshot.nodes).toHaveLength(TOOL_LIMITS.readNodes)
    expect(snapshot.truncated).toContain(String(nodes.length))
  })
})

describe('权限复核', () => {
  it('handle 拒绝（发起人失权）→ 工具报错且不写', async () => {
    let allowed = true
    const { doc, call } = setup([], () => {
      if (!allowed) throw new Error('你已无权编辑这张画布')
    })
    await call('add_node', { type: 'text', label: 'ok' })
    allowed = false
    await expect(call('add_node', { type: 'text', label: 'no' })).rejects.toThrow('无权')
    await expect(call('read_canvas', {})).rejects.toThrow('无权')
    expect(nodesMap(doc).size).toBe(1)
  })
})

describe('placeNewNode', () => {
  it('空画布放原点；否则放在现有内容右侧且不重叠', () => {
    expect(placeNewNode([], 'text')).toEqual({ x: 0, y: 0 })
    const spot = placeNewNode(
      [{ id: 'a', type: 'text', label: 'A', position: { x: 0, y: 0 } }],
      'text',
    )
    expect(spot.x).toBeGreaterThanOrEqual(320)
  })
})
