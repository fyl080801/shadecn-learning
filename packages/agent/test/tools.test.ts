import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { isAgentOrigin } from '@shadecn/shared/agent'
import { edgesMap, fromYEdge, fromYNode, nodeGroup, nodesMap, toYEdge, toYNode } from '@shadecn/shared/flow-doc'
import { defaultEdgeData, type FlowNodeRecord } from '@shadecn/shared/flow-graph'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createCanvasTools, placeNewNode, TOOL_LIMITS, type CanvasTool } from '../src/tools.ts'

/**
 * 画布工具直接对一个内存里的 Y.Doc 测 —— 工具只认 `CanvasHandle`，不认识 Hocuspocus。
 * 守的是：写进去的形状和前端建的一样、按 key 合并、先校验后动手（出错不留半截）、删除预算。
 */

function seed(doc: Y.Doc, nodes: FlowNodeRecord[]) {
  doc.transact(() => {
    for (const node of nodes) nodesMap(doc).set(node.id, toYNode(node))
  })
}

function textNode(id: string, label: string, text = '', position = { x: 0, y: 0 }): FlowNodeRecord {
  return { ...buildNodeRecord({ id, type: 'text', label, position }), data: { text } }
}

function typedNode(id: string, type: string, label = id): FlowNodeRecord {
  return buildNodeRecord({ id, type, label, position: { x: 0, y: 0 } })
}

function setup(nodes: FlowNodeRecord[] = [], guard?: () => void) {
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
  it('建出来的文本节点和前端建的同形：metadata 带名字，data 只有 text，origin 是 agent', async () => {
    const { doc, origins, call } = setup()
    const res = await call('add_node', { type: 'text', metadata: { label: '标题' }, data: { text: '正文' } })
    const { id } = JSON.parse((res.content[0] as { text: string }).text) as { id: string }

    expect(id).toMatch(/^n_[0-9a-z]+_[0-9a-z]{8}$/)
    const created = node(doc, id)!
    expect(created.type).toBe('text')
    expect(created.metadata.label).toBe('标题')
    expect(typeof created.metadata.createdAt).toBe('number')
    expect(created.data).toEqual({ text: '正文' })
    expect(created.runtime).toEqual({ status: 'idle' })
    expect(origins).toHaveLength(1)
    expect(isAgentOrigin(origins[0])).toBe(true)
    expect(res.details.summary).toBe('新建节点「标题」')
  })

  it('带 connectFrom：节点和连线在同一个事务里出现，边的形状照前端 onConnect', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    const res = await call('add_node', { type: 'process', metadata: { label: 'B' }, connectFrom: 'a' })
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
    // 两端都是无端口类型：data 里不写端口和序号
    expect(edge!.data).not.toHaveProperty('index')
    expect(edge!.data).not.toHaveProperty('targetPort')
    // 自动摆放：放在来源节点右边，不和它重叠
    expect(node(doc, id)!.layout.position.x).toBeGreaterThan(300)
  })

  it('connectFrom 指向不存在的节点 → 报错，画布一个字节都没变', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    await expect(call('add_node', { type: 'text', metadata: { label: 'X' }, connectFrom: 'ghost' })).rejects.toThrow('不存在')
    expect(nodesMap(doc).size).toBe(1)
    expect(origins).toHaveLength(0)
  })

  it('带端口的业务节点：默认业务字段 + 给出的 data；connectFrom 自动选兼容端口', async () => {
    const { doc, call } = setup([typedNode('src', 'image-source')])
    const res = await call('add_node', {
      type: 'image-config',
      metadata: { label: '生图' },
      data: { prompt: '一只猫' },
      connectFrom: 'src',
    })
    const { id, edgeId, sourcePort, targetPort } = JSON.parse((res.content[0] as { text: string }).text)
    expect(node(doc, id)!.data).toMatchObject({ prompt: '一只猫', model: '', width: 1024 })
    expect([sourcePort, targetPort]).toEqual(['image', 'image'])
    const edge = edges(doc).find((item) => item.id === edgeId)!
    expect(edge).toMatchObject({ sourceHandle: null, targetHandle: null, data: { sourcePort: 'image', targetPort: 'image', index: 1 } })
  })

  it('connectFrom 两端没有兼容端口 → 报错，节点也不建', async () => {
    const { doc, call } = setup([typedNode('txt', 'text-input')])
    await expect(
      call('add_node', { type: 'image-source', metadata: { label: 'X' }, connectFrom: 'txt' }),
    ).rejects.toThrow('不匹配')
    expect(nodesMap(doc).size).toBe(1)
  })

  it('不认识的 data 键名、超长字符串都在动手之前拒绝', async () => {
    const { doc, call } = setup()
    await expect(call('add_node', { type: 'text', metadata: { label: 'X' }, data: { '1bad': 1 } })).rejects.toThrow('不合法')
    await expect(
      call('add_node', { type: 'text', metadata: { label: 'X' }, data: { text: 'x'.repeat(TOOL_LIMITS.text + 1) } }),
    ).rejects.toThrow('超过')
    expect(nodesMap(doc).size).toBe(0)
  })

  it('不能建分组', async () => {
    const { call } = setup()
    await expect(call('add_node', { type: 'group', metadata: { label: 'G' } })).rejects.toThrow('group')
  })
})

describe('update_node', () => {
  it('按组、只改给出的 key：别人同时改的字段和 data 里的其他键都留着', async () => {
    const { doc, call } = setup([textNode('a', '旧名', '旧正文')])
    nodeGroup(doc, 'a', 'data')!.set('custom', 42)

    await call('update_node', { id: 'a', data: { text: '新正文' } })
    expect(node(doc, 'a')!.data).toEqual({ text: '新正文', custom: 42 })
    expect(node(doc, 'a')!.metadata.label).toBe('旧名')

    await call('update_node', { id: 'a', metadata: { label: '新名' }, removeData: ['custom'] })
    expect(node(doc, 'a')!.metadata.label).toBe('新名')
    expect(node(doc, 'a')!.data).toEqual({ text: '新正文' })
  })

  it('老节点（没有 metadata 这一组）改名时现建这一组', async () => {
    const { doc, call } = setup()
    doc.transact(() => {
      const old = new Y.Map<unknown>()
      nodesMap(doc).set('old', old)
      old.set('type', 'text')
      old.set('position', { x: 0, y: 0 })
    })
    await call('update_node', { id: 'old', metadata: { label: '起个名' } })
    expect(node(doc, 'old')!.metadata.label).toBe('起个名')
  })

  it('data 键上是协同结构（Y 类型）的拒绝整体改写', async () => {
    const { doc, call } = setup([textNode('a', 'A')])
    nodeGroup(doc, 'a', 'data')!.set('rich', new Y.Text('协同正文'))
    await expect(call('update_node', { id: 'a', data: { rich: 'x' } })).rejects.toThrow('协同')
  })

  it('节点不存在 → 报错；什么都不给 → 报错', async () => {
    const { call } = setup([textNode('a', 'A')])
    await expect(call('update_node', { id: 'nope', metadata: { label: 'x' } })).rejects.toThrow('不存在')
    await expect(call('update_node', { id: 'a' })).rejects.toThrow('至少')
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

  it('端口校验和前端同一套（resolveConnection）：类型不兼容、端口不存在、单输入端口已满都拒绝', async () => {
    const { doc, call } = setup([
      typedNode('src', 'image-source'),
      typedNode('txt', 'text-input'),
      typedNode('txt2', 'text-input'),
      typedNode('cfg', 'image-config'),
    ])
    await expect(call('connect', { source: 'src', target: 'cfg', sourcePort: 'image', targetPort: 'text' })).rejects.toThrow('不匹配')
    await expect(call('connect', { source: 'src', target: 'cfg', targetPort: 'nope' })).rejects.toThrow('没有输入端口')

    await call('connect', { source: 'txt', target: 'cfg' })
    expect(edges(doc)[0]).toMatchObject({
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: 'text', targetPort: 'text', index: 1 }
    })
    // 不指定端口也一样：文本只能进提示词，而它已经接满了
    await expect(call('connect', { source: 'txt2', target: 'cfg' })).rejects.toThrow('接满')
    await expect(call('connect', { source: 'txt2', target: 'cfg', targetPort: 'text' })).rejects.toThrow('接满')
    expect(edges(doc)).toHaveLength(1)
  })

  it('导演台连到只收视频的节点：自动跳过图片输出，选 video → video', async () => {
    const { doc, call } = setup([typedNode('dc', 'director-console'), typedNode('vsrc', 'video-source')])
    await call('connect', { source: 'dc', target: 'vsrc' })
    expect(edges(doc)[0]!.data).toMatchObject({ sourcePort: 'video', targetPort: 'video', index: 1 })
  })

  it('多输入端口：不给端口时自动选兼容的那个；序号递增，删线不重排', async () => {
    const { doc, call } = setup([typedNode('s1', 'image-source'), typedNode('s2', 'image-source'), typedNode('s3', 'image-source'), typedNode('cfg', 'image-config')])
    await call('connect', { source: 's1', target: 'cfg' })
    await call('connect', { source: 's2', target: 'cfg' })
    const first = edges(doc).find((item) => item.source === 's1')!
    expect(first).toMatchObject({ data: { sourcePort: 'image', targetPort: 'image', index: 1 } })
    expect(edges(doc).find((item) => item.source === 's2')!.data.index).toBe(2)

    await call('delete_elements', { ids: [first.id] })
    await call('connect', { source: 's3', target: 'cfg' })
    expect(edges(doc).find((item) => item.source === 's2')!.data.index).toBe(2)
    expect(edges(doc).find((item) => item.source === 's3')!.data.index).toBe(3)
  })
})

describe('delete_elements', () => {
  it('删节点连带删边；删分组只解散，子节点换算回画布坐标', async () => {
    const { doc, call } = setup()
    seed(doc, [
      { ...typedNode('g', 'group', '组'), layout: { position: { x: 100, y: 200 }, width: 500, height: 300 } },
      { ...textNode('child', '子', '', { x: 10, y: 20 }), layout: { position: { x: 10, y: 20 }, parentNode: 'g', extent: 'parent' } },
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
    expect(child.layout).toEqual({ position: { x: 110, y: 220 } })
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
  it('按组给出：layout / metadata / data / runtime / inputs；超长正文截断，大对象只报大小', async () => {
    const { doc, call } = setup([
      textNode('a', 'A', 'x'.repeat(1000)),
      { ...typedNode('src', 'image-source'), runtime: { status: 'completed', outputs: { image: 'u.png' } } },
      typedNode('cfg', 'image-config'),
    ])
    nodeGroup(doc, 'a', 'data')!.set('scene', { objects: Array.from({ length: 100 }, (_, i) => ({ i })) })
    doc.transact(() => {
      edgesMap(doc).set('e1', toYEdge({ id: 'e1', source: 'src', target: 'cfg', sourceHandle: null, targetHandle: null, data: { sourcePort: 'image', targetPort: 'image', index: 1 } }))
    })
    const res = await call('read_canvas', {})
    const snapshot = JSON.parse((res.content[0] as { text: string }).text)
    expect(snapshot.nodeCount).toBe(3)
    const a = snapshot.nodes.find((item: { id: string }) => item.id === 'a')
    expect(a).toMatchObject({ id: 'a', type: 'text', metadata: { label: 'A' }, runtime: { status: 'idle' }, inputs: [] })
    expect(a.layout.position).toEqual({ x: 0, y: 0 })
    expect(a.data.text.length).toBeLessThan(500)
    expect(a.data.text).toContain('已截断')
    expect(a.data.scene).toMatchObject({ 省略: '对象' })

    const cfg = snapshot.nodes.find((item: { id: string }) => item.id === 'cfg')
    expect(cfg.inputs).toEqual([{ port: 'image', index: 1, edgeId: 'e1', source: 'src', sourcePort: 'image', value: 'u.png' }])
    expect(snapshot.edges).toEqual([{ id: 'e1', source: 'src', target: 'cfg', sourcePort: 'image', targetPort: 'image', index: 1 }])
    // 画布上出现过的带端口类型列出端口，好让模型连线时点名
    expect(snapshot.nodeTypes['image-config'].inputs.map((port: { id: string }) => port.id)).toEqual(['image', 'text'])
    expect(snapshot.nodeTypes.text).toBeUndefined()
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
    await call('add_node', { type: 'text', metadata: { label: 'ok' } })
    allowed = false
    await expect(call('add_node', { type: 'text', metadata: { label: 'no' } })).rejects.toThrow('无权')
    await expect(call('read_canvas', {})).rejects.toThrow('无权')
    expect(nodesMap(doc).size).toBe(1)
  })
})

describe('placeNewNode', () => {
  it('空画布放原点；否则放在现有内容右侧且不重叠', () => {
    expect(placeNewNode([], 'text')).toEqual({ x: 0, y: 0 })
    const spot = placeNewNode([{ id: 'a', type: 'text', layout: { position: { x: 0, y: 0 } } }], 'text')
    expect(spot.x).toBeGreaterThanOrEqual(320)
  })
})
