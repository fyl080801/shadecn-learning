import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { edgesMap, fromYEdge, fromYNode, nodeGroup, nodesMap, toYEdge, toYNode } from '../src/flow-doc.ts'
import { defaultEdgeData, type FlowEdge, type FlowNodeRecord } from '../src/flow-graph.ts'
import { GROUP_HEADER, GROUP_PADDING, LAYOUT_NODE_GAP, LAYOUT_RANK_GAP } from '../src/flow-layout.ts'
import { buildNodeRecord } from '../src/flow-node-types.ts'
import * as ops from '../src/flow-ops.ts'
import { FlowOpError, type FlowOpContext } from '../src/flow-ops.ts'

/**
 * 原子操作层 —— 编辑器和 agent 写画布的同一份实现。盯的是每个操作自己守的不变式，
 * 以及「在调用方的事务里跑、自己不开事务、出错时一个字节都不写」这条形状。
 */

const ORIGIN = Symbol('test')

function record(id: string, type = 'process', position = { x: 0, y: 0 }): FlowNodeRecord {
  return buildNodeRecord({ id, type, label: id, position })
}

function edge(id: string, source: string, target: string, data: FlowEdge['data'] = defaultEdgeData()): FlowEdge {
  return { id, source, target, sourceHandle: null, targetHandle: null, data }
}

function setup(nodes: FlowNodeRecord[] = [], links: FlowEdge[] = []) {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const node of nodes) nodesMap(doc).set(node.id, toYNode(node))
    for (const item of links) edgesMap(doc).set(item.id, toYEdge(item))
  })
  const transactions: unknown[] = []
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) transactions.push(tr.origin)
  })
  /** 调用方开事务，操作在里面跑 —— 和 store.mutate / canvas.write 同一个形状 */
  const run = <T>(fn: (ctx: FlowOpContext) => T): T => {
    let result!: T
    doc.transact(() => {
      result = fn(ops.opContext(doc))
    }, ORIGIN)
    return result
  }
  const node = (id: string) => {
    const value = nodesMap(doc).get(id)
    return value ? fromYNode(id, value) : null
  }
  const edges = () => [...edgesMap(doc).entries()].map(([id, value]) => fromYEdge(id, value)!)
  return { doc, run, node, edges, transactions }
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof FlowOpError ? error.code : `非 FlowOpError：${String(error)}`
  }
}

describe('事务形状', () => {
  it('操作不自己开事务：一次调用的所有改动都落在调用方那一个事务里、带调用方的 origin', () => {
    const { run, transactions } = setup([record('src', 'text')])
    run((ctx) => ops.createConnectedNode(ctx, record('img', 'image'), { source: 'src' }))
    expect(transactions).toEqual([ORIGIN])
  })

  it('前提不满足 → 抛 FlowOpError，文档一个字节都没动', () => {
    const { doc, run, transactions } = setup([record('a', 'text'), record('img', 'image')])
    const before = Y.encodeStateVector(doc)
    expect(codeOf(() => run((ctx) => ops.connect(ctx, { source: 'img', target: 'a' })))).toBe('CONNECTION_REJECTED')
    expect(codeOf(() => run((ctx) => ops.writeNodeFields(ctx, 'ghost', 'data', { set: { x: 1 } })))).toBe('NODE_NOT_FOUND')
    expect(transactions).toEqual([])
    expect(Y.encodeStateVector(doc)).toEqual(before)
  })
})

describe('connect', () => {
  it('端口按 resolveConnection 选：导演台 → 图片先落 image → image，再连落到 video → video', () => {
    const { run, edges } = setup([record('dc', 'director'), record('img', 'image')])
    const first = run((ctx) => ops.connect(ctx, { source: 'dc', target: 'img' }))
    run((ctx) => ops.connect(ctx, { source: 'dc', target: 'img' }))
    expect(first).toMatchObject({ sourceHandle: null, targetHandle: null, type: 'default', animated: false })
    expect(edges().map((item) => [item.data.sourcePort, item.data.targetPort, item.data.index])).toEqual([
      ['image', 'image', 1],
      ['video', 'video', 1],
    ])
  })

  it('多输入端口的序号取现有最大 + 1；给了 id / label 就用它们', () => {
    const { run, edges } = setup([record('t1', 'text'), record('t2', 'text'), record('img', 'image')])
    run((ctx) => ops.connect(ctx, { source: 't1', target: 'img' }))
    const second = run((ctx) => ops.connect(ctx, { source: 't2', target: 'img', id: 'e_fixed', label: '参考' }))
    expect(second).toMatchObject({ id: 'e_fixed', label: '参考', data: { targetPort: 'text', index: 2 } })
    expect(edges()).toHaveLength(2)
  })

  it('拒绝：类型不兼容、端口不存在、已经连过、节点不存在 —— 原因原样带上；有图不拒（逻辑门只配端口）', () => {
    const { run, edges } = setup([record('t', 'text'), record('img', 'image'), record('v', 'video')])
    const reasonOf = (fn: (ctx: FlowOpContext) => unknown) => {
      try {
        run(fn)
        return null
      } catch (error) {
        return error instanceof FlowOpError ? `${error.code}:${error.message}` : String(error)
      }
    }
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 'img', target: 't' }))).toMatch(/^CONNECTION_REJECTED:.*没有输入端口/)
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 't', target: 'img', targetPort: 'nope' }))).toMatch(/没有输入端口 nope/)
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 'img', target: 'v', sourcePort: 'image', targetPort: 'text' }))).toMatch(/不匹配/)
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 't', target: 'ghost' }))).toBe('NODE_NOT_FOUND:终点节点 ghost 不存在')

    run((ctx) => ops.connect(ctx, { source: 't', target: 'img' }))
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 't', target: 'img' }))).toMatch(/已经有线/)
    run((ctx) => ops.writeNodeFields(ctx, 'v', 'data', { set: { src: 'https://x/a.mp4' } }))
    expect(reasonOf((ctx) => ops.connect(ctx, { source: 't', target: 'v' }))).toBeNull()
    expect(edges()).toHaveLength(2)
  })

  it('端点已经没了的悬空边不参与连线规则（和编辑器投影的口径一致）', () => {
    const { run, edges } = setup(
      [record('t', 'text'), record('img', 'image')],
      [edge('dangling', 'gone', 'img', { ...defaultEdgeData(), sourcePort: 'text', targetPort: 'text', index: 7 })],
    )
    const created = run((ctx) => ops.connect(ctx, { source: 't', target: 'img' }))
    expect(created.data.index).toBe(1)
    expect(edges()).toHaveLength(2)
  })
})

describe('createConnectedNode', () => {
  it('节点和线同一个事务：一次撤销两样都拿掉', () => {
    const { doc, run, node, edges } = setup([record('dc', 'director')])
    const undo = new Y.UndoManager([nodesMap(doc), edgesMap(doc)], { trackedOrigins: new Set([ORIGIN]) })
    const { node: created, edge: link } = run((ctx) => ops.createConnectedNode(ctx, record('vid', 'video'), { source: 'dc' }))
    expect(node(created.id)!.type).toBe('video')
    expect(link).toMatchObject({ source: 'dc', target: 'vid', data: { sourcePort: 'image', targetPort: 'image', index: 1 } })

    undo.undo()
    expect(node('vid')).toBeNull()
    expect(edges()).toHaveLength(0)
  })

  it('连不上（端口不兼容 / 起点不存在）→ 节点也不建', () => {
    const { run, node, edges } = setup([record('t', 'text'), record('v', 'video')])
    expect(codeOf(() => run((ctx) => ops.createConnectedNode(ctx, record('dc', 'director'), { source: 'v' })))).toBe(
      'CONNECTION_REJECTED',
    )
    expect(codeOf(() => run((ctx) => ops.createConnectedNode(ctx, record('x', 'image'), { source: 'ghost' })))).toBe(
      'NODE_NOT_FOUND',
    )
    expect(node('dc')).toBeNull()
    expect(node('x')).toBeNull()
    expect(edges()).toHaveLength(0)
  })
})

describe('createUpstreamNode', () => {
  it('新节点是起点、连到已有节点，同一个事务：一次撤销两样都拿掉', () => {
    const { doc, run, node, edges } = setup([record('img', 'image')])
    const undo = new Y.UndoManager([nodesMap(doc), edgesMap(doc)], { trackedOrigins: new Set([ORIGIN]) })
    const { edge: link } = run((ctx) => ops.createUpstreamNode(ctx, record('ref', 'image'), { target: 'img' }))
    expect(node('ref')!.type).toBe('image')
    expect(link).toMatchObject({ source: 'ref', target: 'img', data: { sourcePort: 'image', targetPort: 'image', index: 1 } })

    undo.undo()
    expect(node('ref')).toBeNull()
    expect(edges()).toHaveLength(0)
  })

  it('连不上（导演台不收视频 / 终点不存在）→ 节点也不建', () => {
    const { run, node, edges } = setup([record('dc', 'director')])
    expect(codeOf(() => run((ctx) => ops.createUpstreamNode(ctx, record('v', 'video'), { target: 'dc' })))).toBe(
      'CONNECTION_REJECTED',
    )
    expect(codeOf(() => run((ctx) => ops.createUpstreamNode(ctx, record('x', 'image'), { target: 'ghost' })))).toBe(
      'NODE_NOT_FOUND',
    )
    expect(node('v')).toBeNull()
    expect(node('x')).toBeNull()
    expect(edges()).toHaveLength(0)
  })
})

describe('writeNodeFields', () => {
  it('按 key 写和删，别的 key 原样；老节点没有这一组时现建', () => {
    const { doc, run, node } = setup([{ ...record('a'), data: { keep: 1, drop: 2 } }])
    run((ctx) => ops.writeNodeFields(ctx, 'a', 'data', { set: { add: 3, skip: undefined }, remove: ['drop'] }))
    expect(node('a')!.data).toEqual({ keep: 1, add: 3 })

    doc.transact(() => {
      const old = new Y.Map<unknown>()
      nodesMap(doc).set('old', old)
      old.set('position', { x: 0, y: 0 })
    })
    run((ctx) => ops.writeNodeFields(ctx, 'old', 'metadata', { set: { label: '新名字' } }))
    expect(nodeGroup(doc, 'old', 'metadata')).toBeInstanceOf(Y.Map)
    expect(node('old')!.metadata.label).toBe('新名字')
  })

  it('组的 key 上不是 Y.Map → GROUP_NOT_MAP，不覆盖', () => {
    const { doc, run } = setup([record('a')])
    doc.transact(() => nodesMap(doc).get('a')!.set('runtime', 'broken'))
    expect(codeOf(() => run((ctx) => ops.writeNodeFields(ctx, 'a', 'runtime', { set: { status: 'idle' } })))).toBe(
      'GROUP_NOT_MAP',
    )
    expect(nodesMap(doc).get('a')!.get('runtime')).toBe('broken')
  })

  it('key 的类型首次写入即固定：Y 类型不能被改写或删掉，普通值不能换成 Y 类型；全新的 Y.Text 键可以', () => {
    const { doc, run } = setup([{ ...record('a'), data: { plain: 'x' } }])
    const data = nodeGroup(doc, 'a', 'data')!
    doc.transact(() => data.set('rich', new Y.Text('协同正文')))

    expect(codeOf(() => run((ctx) => ops.writeNodeFields(ctx, 'a', 'data', { set: { other: 1, rich: 'x' } })))).toBe(
      'KEY_TYPE_LOCKED',
    )
    expect(codeOf(() => run((ctx) => ops.writeNodeFields(ctx, 'a', 'data', { remove: ['rich'] })))).toBe('KEY_TYPE_LOCKED')
    expect(codeOf(() => run((ctx) => ops.writeNodeFields(ctx, 'a', 'data', { set: { plain: new Y.Text('y') } })))).toBe(
      'KEY_TYPE_LOCKED',
    )
    // 拒绝时整次都不写：同一次里合法的 other 也没进去
    expect(data.has('other')).toBe(false)
    expect((data.get('rich') as Y.Text).toString()).toBe('协同正文')

    run((ctx) => ops.writeNodeFields(ctx, 'a', 'data', { set: { fresh: new Y.Text('新') } }))
    expect(data.get('fresh')).toBeInstanceOf(Y.Text)
  })
})

describe('removeElements', () => {
  it('删节点连带删边；删分组只解散，子节点清掉 parentNode / extent，位置换算回画布坐标', () => {
    const { run, node, edges } = setup(
      [
        { ...record('g', 'group', { x: 100, y: 200 }), layout: { position: { x: 100, y: 200 }, width: 400, height: 300 } },
        { ...record('child'), layout: { position: { x: 10, y: 20 }, parentNode: 'g', extent: 'parent' } },
        record('a'),
        record('b'),
        record('c'),
      ],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'b', 'c')],
    )

    const removed = run((ctx) => ops.removeElements(ctx, ['g', 'a', 'ghost'], ['e2', 'nope']))
    expect(removed).toEqual({ nodes: ['g', 'a'], edges: ['e2', 'e1'], ungrouped: 1 })
    expect(node('g')).toBeNull()
    expect(node('child')!.layout).toEqual({ position: { x: 110, y: 220 } })
    expect(edges().map((item) => item.id)).toEqual(['e3'])
  })

  it('分组框和组员一起删：组员跟着没，不算移出分组', () => {
    const { run, node } = setup([
      record('g', 'group'),
      { ...record('child'), layout: { position: { x: 10, y: 20 }, parentNode: 'g', extent: 'parent' } },
    ])
    expect(run((ctx) => ops.removeElements(ctx, ['g', 'child'], [])).ungrouped).toBe(0)
    expect(node('child')).toBeNull()
  })
})

describe('disconnectNodes', () => {
  it('只删 source → target 方向的线（几对端口都删），反方向、别的线不动；没连着回 []', () => {
    const { run, edges } = setup(
      [record('a'), record('b'), record('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a'), edge('e4', 'a', 'c')],
    )
    expect(run((ctx) => ops.disconnectNodes(ctx, 'a', 'b')).sort()).toEqual(['e1', 'e2'])
    expect(edges().map((item) => item.id).sort()).toEqual(['e3', 'e4'])
    expect(run((ctx) => ops.disconnectNodes(ctx, 'a', 'b'))).toEqual([])
  })
})

describe('布局', () => {
  it('moveNodes 只写 position，不存在的跳过；resizeNode 尺寸和位置同一笔，节点不在 → NODE_NOT_FOUND', () => {
    const { run, node } = setup([record('a'), record('b')])
    expect(run((ctx) => ops.moveNodes(ctx, new Map([['a', { x: 5, y: 6 }], ['ghost', { x: 1, y: 1 }], ['b', { x: 7, y: 8 }]])))).toEqual([
      'a',
      'b',
    ])
    expect(node('a')!.layout.position).toEqual({ x: 5, y: 6 })

    run((ctx) => ops.resizeNode(ctx, 'a', { width: 300, height: 200, x: 1, y: 2 }))
    expect(node('a')!.layout).toMatchObject({ width: 300, height: 200, position: { x: 1, y: 2 } })
    expect(codeOf(() => run((ctx) => ops.resizeNode(ctx, 'ghost', { width: 1, height: 1 })))).toBe('NODE_NOT_FOUND')
  })

  it('groupNodes：分组框和组员同一个事务，组员挂上 parentNode + extent，位置用调用方给的相对坐标', () => {
    const { run, node, transactions } = setup([record('a', 'process', { x: 100, y: 100 }), record('b')])
    const group = { ...record('g', 'group', { x: 60, y: 60 }), layout: { position: { x: 60, y: 60 }, width: 400, height: 300 } }
    const attached = run((ctx) => ops.groupNodes(ctx, group, new Map([['a', { x: 40, y: 40 }], ['ghost', { x: 0, y: 0 }]])))
    expect(attached).toEqual(['a'])
    expect(transactions).toHaveLength(1)
    expect(node('a')!.layout).toEqual({ position: { x: 40, y: 40 }, parentNode: 'g', extent: 'parent' })
    expect(node('g')!.type).toBe('group')
  })
})

describe('分组边界（settleLayout）', () => {
  /** 一个 400×300 的分组框在 (0,0)，组员 a（200×100）在相对 (40,60) */
  function grouped(extra: FlowNodeRecord[] = []) {
    const group: FlowNodeRecord = {
      ...record('g', 'group'),
      layout: { position: { x: 0, y: 0 }, width: 400, height: 300 },
    }
    const a: FlowNodeRecord = {
      ...record('a'),
      layout: { position: { x: 40, y: 60 }, width: 200, height: 100, parentNode: 'g', extent: 'parent' },
    }
    return setup([group, a, ...extra])
  }

  it('组员探出框边（中心还在框里）：分组框同一个事务长到罩住它（含留白），左上角不动', () => {
    const { run, node, transactions } = grouped()
    run((ctx) => ops.moveNodes(ctx, new Map([['a', { x: 250, y: 160 }]]), { reparent: true }))
    expect(transactions).toHaveLength(1)
    expect(node('a')!.layout).toMatchObject({ parentNode: 'g', position: { x: 250, y: 160 } })
    expect(node('g')!.layout).toMatchObject({
      position: { x: 0, y: 0 },
      width: 450 + GROUP_PADDING,
      height: 300,
    })
  })

  it('组员往左上探出：框往左上长，所有组员的相对坐标一起补偿，画布上谁都不跳', () => {
    const b: FlowNodeRecord = {
      ...record('b'),
      layout: { position: { x: 100, y: 180 }, width: 100, height: 50, parentNode: 'g', extent: 'parent' },
    }
    const { run, node } = grouped([b])
    run((ctx) => ops.moveNodes(ctx, new Map([['a', { x: -50, y: 60 }]]), { reparent: true }))
    const g = node('g')!.layout
    const dx = 50 + GROUP_PADDING
    expect(g.position).toEqual({ x: -dx, y: 0 })
    expect(g.width).toBe(400 + dx)
    expect(node('a')!.layout.position).toEqual({ x: -50 + dx, y: 60 })
    expect(node('b')!.layout.position).toEqual({ x: 100 + dx, y: 180 })
  })

  it('组员中心拖出框：移出分组（清掉 parentNode / extent，换回画布坐标），分组框不缩', () => {
    const { run, node } = grouped()
    const result = run((ctx) =>
      ops.settleLayout(ctx, { positions: [['a', { x: 500, y: 60 }]] }, { reparent: true }),
    )
    expect(result.left).toEqual([['a', 'g']])
    expect(result.joined).toEqual([])
    expect(node('a')!.layout).toEqual({ position: { x: 500, y: 60 }, width: 200, height: 100 })
    expect(node('g')!.layout).toMatchObject({ position: { x: 0, y: 0 }, width: 400, height: 300 })
  })

  it('组外节点中心拖进框：加入分组（相对坐标 + extent），框重新罩住它', () => {
    const outsider: FlowNodeRecord = { ...record('o'), layout: { position: { x: 600, y: 0 }, width: 100, height: 100 } }
    const { run, node, transactions } = grouped([outsider])
    const result = run((ctx) =>
      ops.settleLayout(ctx, { positions: [['o', { x: 330, y: 200 }]] }, { reparent: true }),
    )
    expect(result.joined).toEqual([['o', 'g']])
    expect(transactions).toHaveLength(1)
    expect(node('o')!.layout).toMatchObject({ parentNode: 'g', extent: 'parent', position: { x: 330, y: 200 } })
    expect(node('g')!.layout).toMatchObject({ width: 430 + GROUP_PADDING, height: 300 + GROUP_PADDING })
  })

  it('组员从一个分组拖进另一个：换到那个分组，坐标按新框换算', () => {
    const other: FlowNodeRecord = {
      ...record('h', 'group'),
      layout: { position: { x: 1000, y: 0 }, width: 400, height: 300 },
    }
    const { run, node } = grouped([other])
    run((ctx) => ops.moveNodes(ctx, new Map([['a', { x: 1100, y: 100 }]]), { reparent: true }))
    expect(node('a')!.layout).toMatchObject({ parentNode: 'h', extent: 'parent', position: { x: 100, y: 100 } })
  })

  it('分组框挪到 / 盖住组外节点：什么都不发生（不加入、不拦）；不开 reparent 时组外节点挪进框也只是挪', () => {
    const outsider: FlowNodeRecord = { ...record('o'), layout: { position: { x: 450, y: 0 }, width: 100, height: 100 } }
    const { run, node } = grouped([outsider])
    run((ctx) => ops.moveNodes(ctx, new Map([['g', { x: 300, y: 0 }]]), { reparent: true }))
    expect(node('g')!.layout.position).toEqual({ x: 300, y: 0 })
    expect(node('o')!.layout.parentNode).toBeUndefined()

    run((ctx) => ops.moveNodes(ctx, new Map([['o', { x: 400, y: 100 }]])))
    expect(node('o')!.layout.parentNode).toBeUndefined()
  })

  it('分组框拉得比组员小：长回罩得住组员的大小', () => {
    const { run, node } = grouped()
    run((ctx) => ops.resizeNode(ctx, 'g', { width: 100, height: 100 }))
    expect(node('g')!.layout).toMatchObject({ width: 240 + GROUP_PADDING, height: 160 + GROUP_PADDING })
  })

  it('createNode 建进分组：补上 extent，框同一个事务长大；父节点不是分组 → NOT_A_GROUP', () => {
    const { run, node, transactions } = grouped([record('p', 'process', { x: 900, y: 900 })])
    const child = { ...record('c'), layout: { position: { x: 380, y: 60 }, width: 100, height: 100, parentNode: 'g' } }
    run((ctx) => ops.createNode(ctx, child))
    expect(transactions).toHaveLength(1)
    expect(node('c')!.layout).toMatchObject({ parentNode: 'g', extent: 'parent' })
    expect(node('g')!.layout.width).toBe(480 + GROUP_PADDING)

    const stray = { ...record('d'), layout: { position: { x: 0, y: 0 }, parentNode: 'p' } }
    expect(codeOf(() => run((ctx) => ops.createNode(ctx, stray)))).toBe('NOT_A_GROUP')
    const ghost = { ...record('e'), layout: { position: { x: 0, y: 0 }, parentNode: 'ghost' } }
    expect(codeOf(() => run((ctx) => ops.createNode(ctx, ghost)))).toBe('NODE_NOT_FOUND')
  })

  it('createNode 建在顶层 + reparent：中心点在分组框里就建成组员（相对坐标），否则照常建在顶层', () => {
    const { run, node } = grouped()
    const inside = run((ctx) =>
      ops.createNode(ctx, { ...record('c'), layout: { position: { x: 300, y: 150 }, width: 100, height: 100 } }, { reparent: true }),
    )
    expect(inside.layout).toMatchObject({ parentNode: 'g', extent: 'parent', position: { x: 300, y: 150 } })
    expect(node('c')!.layout.parentNode).toBe('g')
    const outside = run((ctx) =>
      ops.createNode(ctx, { ...record('d'), layout: { position: { x: 900, y: 0 }, width: 100, height: 100 } }, { reparent: true }),
    )
    expect(outside.layout.parentNode).toBeUndefined()
  })

  it('duplicateNode 复制组员：副本留在同一分组，框按需长大', () => {
    const { run, node } = grouped()
    const copy = run((ctx) => ops.duplicateNode(ctx, 'a', { id: 'a2', offset: { x: 200, y: 0 } }))
    expect(copy.layout.parentNode).toBe('g')
    expect(node('g')!.layout.width).toBe(440 + GROUP_PADDING)
  })
})

describe('duplicateNode', () => {
  it('照抄类型 / 布局（错开）/ metadata / data，运行态重置为空闲且不带产出，连线一条都不复制', () => {
    const source: FlowNodeRecord = {
      ...record('src', 'image', { x: 10, y: 20 }),
      metadata: { label: '素材', description: '说明', createdAt: 1_700_000_000_000 },
      data: { src: 'a.png', nested: { deep: [1, 2] } },
      runtime: { status: 'completed', taskId: 't1', outputs: { image: 'a.png' } },
    }
    const { doc, run, node, edges } = setup([source, record('cfg', 'image')], [edge('e1', 'src', 'cfg')])

    const copy = run((ctx) => ops.duplicateNode(ctx, 'src', { id: 'copy', offset: { x: 24, y: 24 }, createdAt: 1_800_000_000_000 }))
    expect(copy.id).toBe('copy')
    const stored = node('copy')!
    expect(stored.type).toBe('image')
    expect(stored.layout.position).toEqual({ x: 34, y: 44 })
    expect(stored.metadata).toEqual({ label: '素材', description: '说明', createdAt: 1_800_000_000_000 })
    expect(stored.data).toEqual({ src: 'a.png', nested: { deep: [1, 2] } })
    expect(stored.runtime).toEqual({ status: 'idle' })
    expect(edges().map((item) => item.id)).toEqual(['e1'])

    // 深拷贝：副本的嵌套值和原件不是同一个对象
    const originNested = nodeGroup(doc, 'src', 'data')!.get('nested')
    expect(nodeGroup(doc, 'copy', 'data')!.get('nested')).not.toBe(originNested)
  })

  it('原件不存在 → NODE_NOT_FOUND，什么都不建', () => {
    const { run, transactions } = setup()
    expect(codeOf(() => run((ctx) => ops.duplicateNode(ctx, 'ghost', { id: 'copy', offset: { x: 0, y: 0 } })))).toBe(
      'NODE_NOT_FOUND',
    )
    expect(transactions).toEqual([])
  })
})

describe('形态：attachAsset / 连入改回 generate', () => {
  const formOf = (doc: Y.Doc, id: string) => nodeGroup(doc, id, 'data')!.get('form')

  it('没有连入的线：挂上素材 → asset；连出去的线不算连入', () => {
    const { doc, run, node } = setup([record('img', 'image'), record('dst', 'image')], [edge('out', 'img', 'dst')])
    expect(run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))).toBe('asset')
    expect(node('img')!.data).toEqual({ src: 'https://x/a.png', form: 'asset' })
    expect(formOf(doc, 'img')).toBe('asset')
  })

  it('有连入的线：挂上素材仍是 generate；视频的 src / poster 一起写', () => {
    const { run, node } = setup([record('t', 'text'), record('vid', 'video')], [edge('in', 't', 'vid')])
    expect(run((ctx) => ops.attachAsset(ctx, 'vid', { src: 'https://x/v.mp4', poster: 'https://x/p.jpg' }))).toBe('generate')
    expect(node('vid')!.data).toEqual({ src: 'https://x/v.mp4', poster: 'https://x/p.jpg', form: 'generate' })
  })

  it('起点已经不在的悬空边不算连入', () => {
    const { run } = setup([record('img', 'image')], [edge('dangling', 'gone', 'img')])
    expect(run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))).toBe('asset')
  })

  it('挂素材是一步撤销：src 和 form 一起回去', () => {
    const { doc, run, node } = setup([record('img', 'image')])
    const undo = new Y.UndoManager([nodesMap(doc), edgesMap(doc)], { trackedOrigins: new Set([ORIGIN]) })
    run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))
    undo.undo()
    expect(node('img')!.data).toEqual({ src: '' })
  })

  it('没有形态的类型不能挂素材；节点不存在 → NODE_NOT_FOUND', () => {
    const { run, transactions } = setup([record('t', 'text')])
    expect(codeOf(() => run((ctx) => ops.attachAsset(ctx, 't', { src: 'x' })))).toBe('NO_FORMS')
    expect(codeOf(() => run((ctx) => ops.attachAsset(ctx, 'ghost', { src: 'x' })))).toBe('NODE_NOT_FOUND')
    expect(transactions).toEqual([])
  })

  it('连进 asset 节点 = 同一个事务把它改回 generate，一次撤销线和形态一起回去', () => {
    const { doc, run, node, edges, transactions } = setup([record('t', 'text'), record('img', 'image')])
    run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))
    const undo = new Y.UndoManager([nodesMap(doc), edgesMap(doc)], { trackedOrigins: new Set([ORIGIN]) })
    transactions.length = 0

    run((ctx) => ops.connect(ctx, { source: 't', target: 'img' }))
    expect(transactions).toEqual([ORIGIN])
    expect(formOf(doc, 'img')).toBe('generate')
    expect(node('img')!.data.src).toBe('https://x/a.png')

    undo.undo()
    expect(edges()).toHaveLength(0)
    expect(formOf(doc, 'img')).toBe('asset')
  })

  it('长出新节点、原样放边（insertEdge）连进 asset 也一样改回；删掉连入的线不会改回 asset', () => {
    const { doc, run } = setup([record('t', 'text'), record('img', 'image')])
    run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))
    run((ctx) => ops.insertEdge(ctx, edge('e1', 't', 'img')))
    expect(formOf(doc, 'img')).toBe('generate')
    run((ctx) => ops.removeElements(ctx, [], ['e1']))
    expect(formOf(doc, 'img')).toBe('generate')
  })

  it('起点不存在的悬空边放进 asset 节点：形态不变（和 hasIncomingEdges 同一口径）', () => {
    const { doc, run } = setup([record('img', 'image')])
    run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))
    run((ctx) => ops.insertEdge(ctx, edge('dangling', 'gone', 'img')))
    expect(formOf(doc, 'img')).toBe('asset')
  })

  it('复制节点连形态一起抄', () => {
    const { doc, run } = setup([record('img', 'image')])
    run((ctx) => ops.attachAsset(ctx, 'img', { src: 'https://x/a.png' }))
    run((ctx) => ops.duplicateNode(ctx, 'img', { id: 'copy', offset: { x: 0, y: 0 } }))
    expect(formOf(doc, 'copy')).toBe('asset')
  })
})

describe('ungroup', () => {
  it('拆掉分组框，组员留在原地（解除归属、换算回画布坐标），一个事务', () => {
    const { run, node, transactions } = setup([
      { ...record('g', 'group', { x: 100, y: 200 }), layout: { position: { x: 100, y: 200 }, width: 400, height: 300 } },
      { ...record('a'), layout: { position: { x: 10, y: 20 }, parentNode: 'g', extent: 'parent' } },
      { ...record('b'), layout: { position: { x: 50, y: 60 }, parentNode: 'g', extent: 'parent' } },
      record('outside'),
    ])
    expect(run((ctx) => ops.ungroup(ctx, 'g'))).toEqual({ children: ['a', 'b'], edges: [] })
    expect(transactions).toHaveLength(1)
    expect(node('g')).toBeNull()
    expect(node('a')!.layout).toEqual({ position: { x: 110, y: 220 } })
    expect(node('b')!.layout).toEqual({ position: { x: 150, y: 260 } })
    expect(node('outside')).not.toBeNull()
  })

  it('不是分组 → NOT_A_GROUP，不存在 → NODE_NOT_FOUND；都不写文档', () => {
    const { run, node, transactions } = setup([record('a')])
    expect(codeOf(() => run((ctx) => ops.ungroup(ctx, 'a')))).toBe('NOT_A_GROUP')
    expect(codeOf(() => run((ctx) => ops.ungroup(ctx, 'ghost')))).toBe('NODE_NOT_FOUND')
    expect(node('a')).not.toBeNull()
    expect(transactions).toHaveLength(0)
  })
})

describe('groupFrameFor（不量 DOM 的打组外框）', () => {
  it('外接矩形按存的位置 + nodeSizeOf（存的宽高优先，没有按类型估），留白同编辑器；成员位置换成相对分组框', () => {
    const { run } = setup([
      { ...record('a', 'text', { x: 100, y: 100 }) },
      { ...record('b', 'process', { x: 600, y: 300 }), layout: { position: { x: 600, y: 300 }, width: 200, height: 50 } },
    ])
    const frame = run((ctx) => ops.groupFrameFor(ctx, ['a', 'b', 'a']))
    // a：text 估 320×120 → 右下 (420, 220)；b：存的 200×50 → 右下 (800, 350)
    const position = { x: 100 - GROUP_PADDING, y: 100 - GROUP_PADDING - GROUP_HEADER }
    expect(frame.position).toEqual(position)
    expect(frame.width).toBe(700 + GROUP_PADDING * 2)
    expect(frame.height).toBe(250 + GROUP_PADDING * 2 + GROUP_HEADER)
    expect([...frame.children]).toEqual([
      ['a', { x: 100 - position.x, y: 100 - position.y }],
      ['b', { x: 600 - position.x, y: 300 - position.y }],
    ])
  })

  it('资格同编辑器的 groupableNodes：分组框、已在分组里的、不够两个 → NOT_GROUPABLE；成员不存在 → NODE_NOT_FOUND', () => {
    const { run } = setup([
      record('a'),
      record('b'),
      record('g', 'group'),
      { ...record('inner'), layout: { position: { x: 0, y: 0 }, parentNode: 'g', extent: 'parent' } },
    ])
    expect(codeOf(() => run((ctx) => ops.groupFrameFor(ctx, ['a', 'g'])))).toBe('NOT_GROUPABLE')
    expect(codeOf(() => run((ctx) => ops.groupFrameFor(ctx, ['a', 'inner'])))).toBe('NOT_GROUPABLE')
    expect(codeOf(() => run((ctx) => ops.groupFrameFor(ctx, ['a', 'a'])))).toBe('NOT_GROUPABLE')
    expect(codeOf(() => run((ctx) => ops.groupFrameFor(ctx, ['a', 'ghost'])))).toBe('NODE_NOT_FOUND')
    expect(codeOf(() => run((ctx) => ops.groupFrameFor(ctx, ['a', 'b'])))).toBeNull()
  })
})

describe('autoLayout', () => {
  it('按给定尺寸横向排顶层节点，组内节点不动、连到组内的线按分组计；一笔写完，返回移动了的 id', () => {
    const { run, node, transactions } = setup(
      [
        record('a', 'process', { x: 900, y: 900 }),
        { ...record('g', 'group', { x: 5, y: 5 }), layout: { position: { x: 5, y: 5 }, width: 400, height: 300 } },
        { ...record('child', 'process', { x: 10, y: 10 }), layout: { position: { x: 10, y: 10 }, parentNode: 'g', extent: 'parent' } },
      ],
      [edge('e1', 'a', 'child')],
    )
    const sizes = new Map([
      ['a', { width: 200, height: 100 }],
      ['g', { width: 400, height: 300 }],
      ['child', { width: 100, height: 100 }],
    ])
    const moved = run((ctx) => ops.autoLayout(ctx, { sizeOf: (item) => sizes.get(item.id)! }))
    expect(moved).toContain('a')
    expect(moved).not.toContain('child')
    expect(transactions).toHaveLength(1)
    expect(node('child')!.layout.position).toEqual({ x: 10, y: 10 })
    expect(node('g')!.layout.position.x - node('a')!.layout.position.x).toBe(200 + LAYOUT_RANK_GAP)
  })

  it('不给尺寸时用 nodeSizeOf（存的宽高，没有按类型估）；已经排好的再排一次不写', () => {
    const { run, transactions } = setup([record('a', 'text', { x: 900, y: 900 }), record('b', 'image', { x: 0, y: 900 })], [
      edge('e1', 'a', 'b'),
    ])
    expect(run((ctx) => ops.autoLayout(ctx)).length).toBeGreaterThan(0)
    expect(run((ctx) => ops.autoLayout(ctx))).toEqual([])
    expect(transactions).toHaveLength(1)
  })
})

describe('arrangeGroup（组内排列）', () => {
  function grouped() {
    const group: FlowNodeRecord = { ...record('g', 'group'), layout: { position: { x: 500, y: 500 }, width: 900, height: 900 } }
    const member = (id: string, x: number, y: number): FlowNodeRecord => ({
      ...record(id),
      layout: { position: { x, y }, width: 100, height: 50, parentNode: 'g', extent: 'parent' },
    })
    const outside: FlowNodeRecord = { ...record('o'), layout: { position: { x: 0, y: 0 }, width: 100, height: 50 } }
    return setup([group, member('b', 300, 40), member('a', 60, 400), outside])
  }

  it('横向：组员一行排开，分组框同一个事务收到正好罩住（左上角不动），组外节点不动', () => {
    const { run, node, transactions } = grouped()
    run((ctx) => ops.arrangeGroup(ctx, 'g', 'horizontal'))
    expect(transactions).toHaveLength(1)
    const top = GROUP_PADDING + GROUP_HEADER
    expect(node('a')!.layout.position).toEqual({ x: GROUP_PADDING, y: top })
    expect(node('b')!.layout.position).toEqual({ x: GROUP_PADDING + 100 + LAYOUT_NODE_GAP, y: top })
    expect(node('g')!.layout).toMatchObject({
      position: { x: 500, y: 500 },
      width: 200 + LAYOUT_NODE_GAP + 2 * GROUP_PADDING,
      height: 50 + 2 * GROUP_PADDING + GROUP_HEADER,
    })
    expect(node('o')!.layout.position).toEqual({ x: 0, y: 0 })
  })

  it('已经排好再排一次：什么都不写', () => {
    const { run, transactions } = grouped()
    run((ctx) => ops.arrangeGroup(ctx, 'g', 'vertical'))
    run((ctx) => ops.arrangeGroup(ctx, 'g', 'vertical'))
    expect(transactions).toHaveLength(1)
  })

  it('点名的不是分组 → NOT_A_GROUP，不存在 → NODE_NOT_FOUND', () => {
    const { run } = grouped()
    expect(codeOf(() => run((ctx) => ops.arrangeGroup(ctx, 'o', 'grid')))).toBe('NOT_A_GROUP')
    expect(codeOf(() => run((ctx) => ops.arrangeGroup(ctx, 'nope', 'grid')))).toBe('NODE_NOT_FOUND')
  })
})
