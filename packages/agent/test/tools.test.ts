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
    const res = await call('add_node', { type: 'image', metadata: { label: 'B' }, connectFrom: 'a' })
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
    // 文本 → 图片：端口自动选 text → text，写在 data 上
    expect(edge!.data).toMatchObject({ sourcePort: 'text', targetPort: 'text', index: 1 })
    // 自动摆放：放在来源节点右边，不和它重叠
    expect(node(doc, id)!.layout.position.x).toBeGreaterThan(300)
  })

  it('connectFrom 指向不存在的节点 → 报错，画布一个字节都没变', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    await expect(call('add_node', { type: 'text', metadata: { label: 'X' }, connectFrom: 'ghost' })).rejects.toThrow('不存在')
    expect(nodesMap(doc).size).toBe(1)
    expect(origins).toHaveLength(0)
  })

  it('带端口的节点：默认业务字段 + 给出的 data；connectFrom 自动选兼容端口', async () => {
    const { doc, call } = setup([typedNode('src', 'image')])
    const res = await call('add_node', {
      type: 'video',
      metadata: { label: '视频' },
      data: { prompt: '一只猫' },
      connectFrom: 'src',
    })
    const { id, edgeId, sourcePort, targetPort } = JSON.parse((res.content[0] as { text: string }).text)
    expect(node(doc, id)!.data).toEqual({ src: '', poster: '', prompt: '一只猫' })
    expect([sourcePort, targetPort]).toEqual(['image', 'image'])
    const edge = edges(doc).find((item) => item.id === edgeId)!
    expect(edge).toMatchObject({ sourceHandle: null, targetHandle: null, data: { sourcePort: 'image', targetPort: 'image', index: 1 } })
  })

  it('connectFrom 两端没有兼容端口 → 报错，节点也不建', async () => {
    const { doc, call } = setup([typedNode('vid', 'video')])
    await expect(
      call('add_node', { type: 'director', metadata: { label: 'X' }, connectFrom: 'vid' }),
    ).rejects.toThrow('不匹配')
    // 文本没有输入，谁也连不进去
    await expect(call('add_node', { type: 'text', metadata: { label: 'X' }, connectFrom: 'vid' })).rejects.toThrow('没有输入端口')
    expect(nodesMap(doc).size).toBe(1)
  })

  it('新节点带着素材（data.src）：没有连入 → asset 形态；同时 connectFrom 连进来 → 保持 generate', async () => {
    const { doc, call } = setup([textNode('a', 'A')])
    const idOf = (res: Awaited<ReturnType<typeof call>>) =>
      (JSON.parse((res.content[0] as { text: string }).text) as { id: string }).id

    const alone = idOf(await call('add_node', { type: 'image', metadata: { label: '素材' }, data: { src: 'https://x/a.png' } }))
    expect(node(doc, alone)!.data).toEqual({ src: 'https://x/a.png', form: 'asset' })

    const wired = idOf(
      await call('add_node', {
        type: 'video',
        metadata: { label: '生成' },
        data: { src: 'https://x/v.mp4', poster: 'https://x/p.jpg' },
        connectFrom: 'a',
      }),
    )
    expect(node(doc, wired)!.data).toEqual({ src: 'https://x/v.mp4', poster: 'https://x/p.jpg', form: 'generate' })
    expect(edges(doc)).toHaveLength(1)
  })

  it('data.form 不让给：形态由画布按连线自己维护', async () => {
    const { doc, call } = setup()
    await expect(call('add_node', { type: 'image', metadata: { label: 'X' }, data: { form: 'asset' } })).rejects.toThrow('form')
    expect(nodesMap(doc).size).toBe(0)
  })

  it('只能新建 text / image / video / director：兜底的 process、分组都不行', async () => {
    const { call } = setup()
    await expect(call('add_node', { type: 'process', metadata: { label: 'X' } })).rejects.toThrow()
    await expect(call('add_node', { type: 'group', metadata: { label: 'X' } })).rejects.toThrow()
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

  it('src / form 不能用 update_node 改（写和删都不行），画布不动', async () => {
    const { doc, call } = setup([typedNode('img', 'image')])
    await expect(call('update_node', { id: 'img', data: { src: 'https://x/a.png' } })).rejects.toThrow('add_node')
    await expect(call('update_node', { id: 'img', data: { form: 'asset' } })).rejects.toThrow('自动维护')
    await expect(call('update_node', { id: 'img', removeData: ['src'] })).rejects.toThrow('src')
    expect(node(doc, 'img')!.data).toEqual({ src: '' })
  })

  it('节点不存在 → 报错；什么都不给 → 报错', async () => {
    const { call } = setup([textNode('a', 'A')])
    await expect(call('update_node', { id: 'nope', metadata: { label: 'x' } })).rejects.toThrow('不存在')
    await expect(call('update_node', { id: 'a' })).rejects.toThrow('至少')
  })


})

describe('connect', () => {
  it('两端存在才连；同方向不重复；不连自己', async () => {
    const { doc, call } = setup([textNode('a', 'A'), typedNode('b', 'image', 'B')])
    const res = await call('connect', { source: 'a', target: 'b', label: '下一步' })
    expect(res.details.summary).toBe('连线「A」 → 「B」')
    expect(edges(doc)[0]).toMatchObject({ source: 'a', target: 'b', label: '下一步' })

    await expect(call('connect', { source: 'a', target: 'b' })).rejects.toThrow('已经有')
    await expect(call('connect', { source: 'a', target: 'x' })).rejects.toThrow('不存在')
    await expect(call('connect', { source: 'a', target: 'a' })).rejects.toThrow('同一个')
    expect(edges(doc)).toHaveLength(1)
  })

  it('端口校验和前端同一套（resolveConnection）：类型不兼容、端口不存在、同一对重复、文本不能被连入都拒绝', async () => {
    const { doc, call } = setup([
      typedNode('src', 'image'),
      textNode('txt', 'txt'),
      textNode('txt2', 'txt2'),
      typedNode('cfg', 'image'),
    ])
    await expect(call('connect', { source: 'src', target: 'cfg', sourcePort: 'image', targetPort: 'text' })).rejects.toThrow('不匹配')
    await expect(call('connect', { source: 'src', target: 'cfg', targetPort: 'nope' })).rejects.toThrow('没有输入端口')
    await expect(call('connect', { source: 'src', target: 'txt' })).rejects.toThrow('没有输入端口')

    await call('connect', { source: 'txt', target: 'cfg' })
    expect(edges(doc)[0]).toMatchObject({
      sourceHandle: null,
      targetHandle: null,
      data: { sourcePort: 'text', targetPort: 'text', index: 1 }
    })
    // 被连过之后还能从别的节点连进来；同一个上游同一对端口不连第二条
    await call('connect', { source: 'txt2', target: 'cfg' })
    expect(edges(doc).find((item) => item.source === 'txt2')!.data).toMatchObject({ targetPort: 'text', index: 2 })
    await expect(call('connect', { source: 'txt', target: 'cfg' })).rejects.toThrow('已经有线')
    expect(edges(doc)).toHaveLength(2)
  })

  it('agent 只过逻辑门：能连进 asset 形态的图片，连上时它改回 generate', async () => {
    const { doc, call } = setup([textNode('txt', 'txt'), typedNode('img', 'image')])
    nodeGroup(doc, 'img', 'data')!.set('src', 'https://x/a.png')
    nodeGroup(doc, 'img', 'data')!.set('form', 'asset')
    await call('connect', { source: 'txt', target: 'img' })
    expect(edges(doc)).toHaveLength(1)
    expect(node(doc, 'img')!.data).toEqual({ src: 'https://x/a.png', form: 'generate' })
  })

  it('导演台 → 图片：先连截图 image → image，再连落到录制 video → video', async () => {
    const { doc, call } = setup([typedNode('dc', 'director'), typedNode('img', 'image')])
    await call('connect', { source: 'dc', target: 'img' })
    await call('connect', { source: 'dc', target: 'img' })
    expect(edges(doc).map((edge) => [edge.data.sourcePort, edge.data.targetPort])).toEqual([
      ['image', 'image'],
      ['video', 'video'],
    ])
  })

  it('多输入端口：不给端口时自动选兼容的那个；序号递增，删线不重排', async () => {
    const { doc, call } = setup([typedNode('s1', 'image'), typedNode('s2', 'image'), typedNode('s3', 'image'), typedNode('cfg', 'image')])
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
      { ...typedNode('src', 'image'), runtime: { status: 'completed', outputs: { image: 'u.png' } } },
      typedNode('cfg', 'image'),
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
    expect(snapshot.nodeTypes.image.inputs.map((port: { id: string }) => port.id)).toEqual(['text', 'image', 'video'])
    // 文本只有输出
    expect(snapshot.nodeTypes.text).toEqual({ inputs: [], outputs: [expect.objectContaining({ id: 'text', dataType: 'text' })] })
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

/** 工具结果的 JSON 正文 */
function body<T = Record<string, unknown>>(res: { content: unknown[] }): T {
  return JSON.parse((res.content[0] as { text: string }).text) as T
}

function linkEdge(doc: Y.Doc, id: string, source: string, target: string) {
  doc.transact(() => {
    edgesMap(doc).set(id, toYEdge({ id, source, target, sourceHandle: null, targetHandle: null, data: defaultEdgeData() }))
  })
}

describe('get_node', () => {
  it('形状同 read_canvas 的节点条目，另附该类型的端口；只读不写', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A', '正文'), typedNode('img', 'image')])
    const fromCanvas = body<{ nodes: { id: string }[] }>(await call('read_canvas', {})).nodes.find((item) => item.id === 'img')
    const res = await call('get_node', { id: 'img' })
    const { ports, ...entry } = body<{ ports: { inputs: { id: string }[] } }>(res)
    expect(entry).toEqual(fromCanvas)
    expect(ports.inputs.map((port) => port.id)).toEqual(['text', 'image', 'video'])
    expect(res.details.elementIds).toEqual([])
    expect(origins).toHaveLength(0)
    expect(nodesMap(doc).size).toBe(2)
  })

  it('不存在 → 报错并提示先 read_canvas；id 不合法 → 报错', async () => {
    const { call } = setup()
    await expect(call('get_node', { id: 'ghost' })).rejects.toThrow('read_canvas')
    await expect(call('get_node', { id: 'bad id!' })).rejects.toThrow('不是合法的 id')
  })
})

describe('check_connection', () => {
  it('只给裁决不写：能连返回会连的端口对，不能连返回原因', async () => {
    const { doc, origins, call } = setup([textNode('t', 'T'), typedNode('img', 'image')])
    expect(body(await call('check_connection', { source: 't', target: 'img' }))).toEqual({
      ok: true,
      sourcePort: 'text',
      targetPort: 'text',
    })
    const rejected = body<{ ok: boolean; reason: string }>(await call('check_connection', { source: 'img', target: 't' }))
    expect(rejected.ok).toBe(false)
    expect(rejected.reason).toBeTruthy()
    expect(edgesMap(doc).size).toBe(0)
    expect(origins).toHaveLength(0)
  })

  it('一端不存在 → 报错', async () => {
    const { call } = setup([textNode('t', 'T')])
    await expect(call('check_connection', { source: 't', target: 'ghost' })).rejects.toThrow('ghost')
  })
})

describe('move_nodes', () => {
  it('一笔挪一批，一个事务', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A'), textNode('b', 'B')])
    const res = await call('move_nodes', { moves: [{ id: 'a', x: 10, y: 20 }, { id: 'b', x: -30, y: 40 }] })
    expect(node(doc, 'a')!.layout.position).toEqual({ x: 10, y: 20 })
    expect(node(doc, 'b')!.layout.position).toEqual({ x: -30, y: 40 })
    expect(res.details.elementIds).toEqual(['a', 'b'])
    expect(origins).toHaveLength(1)
  })

  it('有一个不存在就整个拒绝；重复 id、超出数量、坐标越界 → 拒绝，都不写', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    await expect(call('move_nodes', { moves: [{ id: 'a', x: 1, y: 1 }, { id: 'ghost', x: 1, y: 1 }] })).rejects.toThrow('ghost')
    await expect(call('move_nodes', { moves: [{ id: 'a', x: 1, y: 1 }, { id: 'a', x: 2, y: 2 }] })).rejects.toThrow('重复')
    const many = Array.from({ length: TOOL_LIMITS.movePerCall + 1 }, (_, i) => ({ id: `n${i}`, x: 0, y: 0 }))
    await expect(call('move_nodes', { moves: many })).rejects.toThrow(`最多 ${TOOL_LIMITS.movePerCall}`)
    await expect(call('move_nodes', { moves: [{ id: 'a', x: 1e9, y: 0 }] })).rejects.toThrow('超出范围')
    expect(node(doc, 'a')!.layout.position).toEqual({ x: 0, y: 0 })
    expect(origins).toHaveLength(0)
  })
})

describe('resize_node', () => {
  it('写宽高，位置不动', async () => {
    const { doc, call } = setup([{ ...typedNode('g', 'group'), layout: { position: { x: 5, y: 6 }, width: 520, height: 360 } }])
    const res = await call('resize_node', { id: 'g', width: 800, height: 600 })
    expect(node(doc, 'g')!.layout).toMatchObject({ position: { x: 5, y: 6 }, width: 800, height: 600 })
    expect(res.details.elementIds).toEqual(['g'])
  })

  it('尺寸越界 → 拒绝；节点不存在 → 报错并提示 read_canvas', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A')])
    await expect(call('resize_node', { id: 'a', width: TOOL_LIMITS.sizeMin - 1, height: 100 })).rejects.toThrow('之间')
    await expect(call('resize_node', { id: 'a', width: 100, height: TOOL_LIMITS.sizeMax + 1 })).rejects.toThrow('之间')
    await expect(call('resize_node', { id: 'ghost', width: 100, height: 100 })).rejects.toThrow('read_canvas')
    expect(node(doc, 'a')!.layout.width).toBeUndefined()
    expect(origins).toHaveLength(0)
  })
})

describe('分组边界', () => {
  /** 400×300 的分组框 g 在 (0,0)，组员 a（200×100）在相对 (40,60)；组外节点 o 在 (600,0) */
  function grouped() {
    const group: FlowNodeRecord = {
      ...typedNode('g', 'group', '分组'),
      layout: { position: { x: 0, y: 0 }, width: 400, height: 300 },
    }
    const a: FlowNodeRecord = {
      ...textNode('a', 'A'),
      layout: { position: { x: 40, y: 60 }, width: 200, height: 100, parentNode: 'g', extent: 'parent' },
    }
    const o: FlowNodeRecord = { ...textNode('o', 'O'), layout: { position: { x: 600, y: 0 }, width: 100, height: 100 } }
    return setup([group, a, o])
  }

  it('add_node 带 group：建进分组（相对坐标、extent），分组框同一个事务长大', async () => {
    const { doc, origins, call } = grouped()
    const res = await call('add_node', {
      type: 'text',
      metadata: { label: '新' },
      group: 'g',
      position: { x: 40, y: 220 },
    })
    const { id, group } = JSON.parse((res.content[0] as { text: string }).text) as { id: string; group: string }
    expect(group).toBe('g')
    expect(node(doc, id)!.layout).toMatchObject({ parentNode: 'g', extent: 'parent', position: { x: 40, y: 220 } })
    expect(node(doc, 'g')!.layout.height!).toBeGreaterThan(300)
    expect(origins).toHaveLength(1)
  })

  it('add_node 带 group 不给坐标：排在现有组员下面', async () => {
    const { doc, call } = grouped()
    const res = await call('add_node', { type: 'text', metadata: { label: '新' }, group: 'g' })
    const { id } = JSON.parse((res.content[0] as { text: string }).text) as { id: string }
    expect(node(doc, id)!.layout.position.x).toBe(40)
    expect(node(doc, id)!.layout.position.y).toBeGreaterThan(160)
  })

  it('add_node 不给 group、画布坐标落在分组框里：建进那个分组；group 不是分组 → 拒绝、不写', async () => {
    const { doc, origins, call } = grouped()
    const res = await call('add_node', { type: 'text', metadata: { label: '新' }, position: { x: 100, y: 120 } })
    const { id, group } = JSON.parse((res.content[0] as { text: string }).text) as { id: string; group: string }
    expect(group).toBe('g')
    expect(node(doc, id)!.layout).toMatchObject({ parentNode: 'g', position: { x: 100, y: 120 } })
    expect(origins).toHaveLength(1)
    await expect(call('add_node', { type: 'text', metadata: { label: '新' }, group: 'o' })).rejects.toThrow('不是顶层的分组框')
    expect(origins).toHaveLength(1)
  })

  it('move_nodes：组员探出 → 框长大；组员拖出 → 移出；组外节点拖进 → 加入，框重新罩住', async () => {
    const { doc, call } = grouped()
    const grow = await call('move_nodes', { moves: [{ id: 'a', x: 250, y: 150 }] })
    expect(JSON.parse((grow.content[0] as { text: string }).text)).toEqual({ moved: ['a'], grownGroups: ['g'] })

    const out = await call('move_nodes', { moves: [{ id: 'a', x: 900, y: 500 }] })
    expect(JSON.parse((out.content[0] as { text: string }).text)).toMatchObject({ left: [{ id: 'a', group: 'g' }] })
    expect(node(doc, 'a')!.layout.parentNode).toBeUndefined()
    expect(node(doc, 'a')!.layout.position).toEqual({ x: 900, y: 500 })

    const into = await call('move_nodes', { moves: [{ id: 'o', x: 200, y: 150 }] })
    expect(JSON.parse((into.content[0] as { text: string }).text)).toMatchObject({ joined: [{ id: 'o', group: 'g' }] })
    expect(node(doc, 'o')!.layout).toMatchObject({ parentNode: 'g', extent: 'parent' })
  })

  it('resize_node：分组框拉小长回罩得住组员', async () => {
    const { doc, call } = grouped()
    await call('resize_node', { id: 'g', width: 100, height: 100 })
    expect(node(doc, 'g')!.layout.width!).toBeGreaterThanOrEqual(240)
  })
})

describe('duplicate_node', () => {
  it('副本错开默认步长，照抄 data、运行态清空、不复制连线', async () => {
    const { doc, call } = setup([
      { ...textNode('a', 'A', '正文', { x: 100, y: 100 }), runtime: { status: 'completed', outputs: { text: '产出' } } },
      textNode('b', 'B'),
    ])
    linkEdge(doc, 'e1', 'a', 'b')
    const res = await call('duplicate_node', { id: 'a' })
    const { id } = body<{ id: string }>(res)
    const copy = node(doc, id)!
    expect(copy.layout.position).toEqual({ x: 100 + TOOL_LIMITS.duplicateOffset, y: 100 + TOOL_LIMITS.duplicateOffset })
    expect(copy.data).toEqual({ text: '正文' })
    expect(copy.runtime).toEqual({ status: 'idle' })
    expect(edges(doc)).toHaveLength(1)
    expect(res.details.elementIds).toEqual([id])

    const shifted = body<{ id: string }>(await call('duplicate_node', { id: 'a', offset: { x: 0, y: 300 } }))
    expect(node(doc, shifted.id)!.layout.position).toEqual({ x: 100, y: 400 })
  })

  it('分组框不能复制；不存在 → 报错', async () => {
    const { doc, call } = setup([typedNode('g', 'group')])
    await expect(call('duplicate_node', { id: 'g' })).rejects.toThrow('分组框不能复制')
    await expect(call('duplicate_node', { id: 'ghost' })).rejects.toThrow('read_canvas')
    expect(nodesMap(doc).size).toBe(1)
  })
})

describe('group_nodes / ungroup', () => {
  it('打组：分组框按位置 + 估计尺寸围出来，组员挂上去、坐标改为相对分组框，一个事务；默认名自动编号', async () => {
    const { doc, origins, call } = setup([textNode('a', 'A', '', { x: 100, y: 100 }), textNode('b', 'B', '', { x: 600, y: 100 })])
    const res = await call('group_nodes', { ids: ['a', 'b'] })
    const created = body<{ id: string; position: { x: number; y: number }; width: number; height: number; children: string[] }>(res)
    expect(origins).toHaveLength(1)
    expect(created.children).toEqual(['a', 'b'])
    const group = node(doc, created.id)!
    expect(group.type).toBe('group')
    expect(group.metadata.label).toBe('分组 1')
    // 外接矩形 (100,100)–(920,220)：text 估 320×120
    expect(group.layout).toMatchObject({ position: { x: 68, y: 48 }, width: 884, height: 204, zIndex: -1 })
    expect(node(doc, 'a')!.layout).toEqual({ position: { x: 32, y: 52 }, parentNode: created.id, extent: 'parent' })
    expect(res.details.elementIds).toEqual([created.id, 'a', 'b'])
  })

  it('打组资格同编辑器：已在分组里的、分组本身、不够两个 → 拒绝；成员不存在 → 报错；都不写', async () => {
    const { doc, origins, call } = setup([
      textNode('a', 'A'),
      textNode('b', 'B'),
      typedNode('g', 'group'),
      { ...textNode('inner', 'I'), layout: { position: { x: 0, y: 0 }, parentNode: 'g', extent: 'parent' } },
    ])
    await expect(call('group_nodes', { ids: ['a', 'inner'] })).rejects.toThrow('先解组')
    await expect(call('group_nodes', { ids: ['a', 'g'] })).rejects.toThrow('分组不能再被圈进分组')
    await expect(call('group_nodes', { ids: ['a', 'ghost'] })).rejects.toThrow('read_canvas')
    await expect(call('group_nodes', { ids: ['a', 'a'] })).rejects.toThrow('重复')
    expect(nodesMap(doc).size).toBe(4)
    expect(origins).toHaveLength(0)
  })

  it('解组：拆掉分组框，组员留在原地（换回画布坐标）；不是分组 → 拒绝', async () => {
    const { doc, call } = setup([
      { ...typedNode('g', 'group', '组'), layout: { position: { x: 100, y: 200 }, width: 500, height: 300 } },
      { ...textNode('child', '子'), layout: { position: { x: 10, y: 20 }, parentNode: 'g', extent: 'parent' } },
      textNode('a', 'A'),
    ])
    await expect(call('ungroup', { id: 'a' })).rejects.toThrow('不是分组')
    expect(nodesMap(doc).has('a')).toBe(true)

    const res = await call('ungroup', { id: 'g' })
    expect(nodesMap(doc).has('g')).toBe(false)
    expect(node(doc, 'child')!.layout).toEqual({ position: { x: 110, y: 220 } })
    expect(body(res)).toEqual({ children: ['child'], edges: [] })
    expect(res.details.elementIds).toEqual(['g', 'child'])
  })

  it('解组拆掉的分组框计入每轮删除预算：预算用完就拒绝解组；拒绝过的、失败的不扣', async () => {
    const nodes = Array.from({ length: TOOL_LIMITS.deletePerRun }, (_, i) => textNode(`n${i}`, `N${i}`))
    const { doc, call } = setup([...nodes, typedNode('g1', 'group'), typedNode('g2', 'group'), textNode('plain', 'P')])
    await expect(call('ungroup', { id: 'plain' })).rejects.toThrow('不是分组')
    await call('delete_elements', { ids: nodes.slice(0, TOOL_LIMITS.deletePerRun - 1).map((n) => n.id) })
    await call('ungroup', { id: 'g1' })
    await expect(call('ungroup', { id: 'g2' })).rejects.toThrow('每轮上限')
    await expect(call('delete_elements', { ids: ['plain'] })).rejects.toThrow('每轮上限')
    expect(nodesMap(doc).has('g2')).toBe(true)
  })
})

describe('auto_layout', () => {
  it('整张画布横向分层：只挪顶层，组员不动，连到组内的线按分组计；一个事务', async () => {
    const { doc, origins, call } = setup([
      textNode('a', 'A', '', { x: 900, y: 900 }),
      { ...typedNode('g', 'group'), layout: { position: { x: 0, y: 0 }, width: 400, height: 300 } },
      { ...typedNode('child', 'image'), layout: { position: { x: 10, y: 10 }, parentNode: 'g', extent: 'parent' } },
    ])
    linkEdge(doc, 'e1', 'a', 'child')
    const agentWrites = () => origins.filter(isAgentOrigin).length
    const res = await call('auto_layout', {})
    expect(agentWrites()).toBe(1)
    expect(node(doc, 'child')!.layout.position).toEqual({ x: 10, y: 10 })
    // a 在左一列，分组在它右边（text 估宽 320）
    expect(node(doc, 'g')!.layout.position.x).toBeGreaterThan(node(doc, 'a')!.layout.position.x + 320)
    expect(res.details.elementIds).not.toContain('child')

    // 再排一次：已经排好，什么都不写
    const again = await call('auto_layout', {})
    expect(body(again)).toEqual({ moved: [] })
    expect(agentWrites()).toBe(1)
  })

  it(`节点超过上限 → 拒绝，不写`, async () => {
    const nodes = Array.from({ length: TOOL_LIMITS.layoutNodes + 1 }, (_, i) => textNode(`n${i}`, `N${i}`, '', { x: i, y: i }))
    const { origins, call } = setup(nodes)
    await expect(call('auto_layout', {})).rejects.toThrow(String(TOOL_LIMITS.layoutNodes))
    expect(origins).toHaveLength(0)
  })
})
