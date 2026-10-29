import { describe, expect, it } from 'vitest'
import { FALLBACK_NODE_TYPE, type FlowEdge } from '../src/flow-graph.ts'
import {
  buildNodeRecord,
  connectableNodeTypes,
  connectionEdgeData,
  CREATABLE_NODE_TYPES,
  FLOW_NODE_TYPE_DEFAULTS,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_Z_INDEX,
  hasNodeResource,
  hasSide,
  nodeTypeDefaultsOf,
  portsOf,
  resolveConnection,
  resolveGrowConnection,
  type ConnectionContext,
} from '../src/flow-node-types.ts'

/**
 * 节点类型的默认值和端口规则 —— 人在界面上点出来的节点 / 连出来的线和 agent 建的必须一样，
 * 所以默认值和校验都只有这一份（REQ-AGENT §3.2）。
 */
describe('节点类型默认值', () => {
  it('文本节点：metadata 带名字和创建时刻，data 只有空正文，运行态空闲', () => {
    const node = buildNodeRecord({ id: 'n', type: 'text', label: '标题', position: { x: 1, y: 2 } })
    expect(node.metadata.label).toBe('标题')
    expect(typeof node.metadata.createdAt).toBe('number')
    expect(node.data).toEqual({ text: '' })
    expect(node.runtime).toEqual({ status: 'idle' })
    expect(node.layout).toEqual({ position: { x: 1, y: 2 } })
  })

  it('分组：底色 + 固定尺寸 + 负层级（压在所有节点下面）', () => {
    const node = buildNodeRecord({ id: 'g', type: 'group', label: '组', position: { x: 0, y: 0 } })
    expect(node.data).toEqual({ background: GROUP_DEFAULT_BACKGROUND })
    expect(node.layout).toEqual({ position: { x: 0, y: 0 }, ...GROUP_DEFAULT_SIZE, zIndex: GROUP_Z_INDEX })
    expect(GROUP_Z_INDEX).toBeLessThan(0)
  })

  it('认不出的类型按兜底类型（和 fromYNode 同一个）的默认值，但 type 照写', () => {
    expect(nodeTypeDefaultsOf('不存在的类型').type).toBe(FALLBACK_NODE_TYPE)
    const node = buildNodeRecord({ id: 'n', type: '不存在的类型', label: 'x', position: { x: 0, y: 0 } })
    expect(node.type).toBe('不存在的类型')
    expect(node.data).toEqual({})
  })

  it('data 里没有任何框架字段（label / status / createdAt 都各归其位）', () => {
    for (const type of Object.keys(FLOW_NODE_TYPE_DEFAULTS)) {
      const node = buildNodeRecord({ id: 'n', type, label: 'x', position: { x: 0, y: 0 } })
      for (const reserved of ['label', 'status', 'createdAt', 'inputs', 'ports']) {
        expect(node.data, `${type}.data.${reserved}`).not.toHaveProperty(reserved)
      }
    }
  })

  it('每次拿到的是新对象：改一个节点的默认值不会串到下一个', () => {
    const a = buildNodeRecord({ id: 'a', type: 'group', label: 'x', position: { x: 0, y: 0 } })
    a.layout.width = 1
    a.data.background = 'red'
    const b = buildNodeRecord({ id: 'b', type: 'group', label: 'x', position: { x: 0, y: 0 } })
    expect(b.layout.width).toBe(GROUP_DEFAULT_SIZE.width)
    expect(b.data.background).toBe(GROUP_DEFAULT_BACKGROUND)
  })


  it('可新建的只有 text / image / video / director，按这个顺序；兜底的 process 和分组不可新建', () => {
    expect([...CREATABLE_NODE_TYPES]).toEqual(['text', 'image', 'video', 'director'])
    for (const type of CREATABLE_NODE_TYPES) expect(FLOW_NODE_TYPE_DEFAULTS[type], type).toBeDefined()
    // 注册表的键：可新建的四种在前（顺序一致），后面只有兜底和分组
    expect(Object.keys(FLOW_NODE_TYPE_DEFAULTS)).toEqual([...CREATABLE_NODE_TYPES, FALLBACK_NODE_TYPE, 'group'])
    // 兜底类型没有端口：认不出来的老节点和谁都能连
    expect(portsOf(FALLBACK_NODE_TYPE, 'inputs')).toEqual([])
    expect(portsOf('group', 'outputs')).toEqual([])
  })

  it('资源地址平铺在 data 上：图片 src，视频 src + poster，导演台没有必填字段', () => {
    const data = (type: string) => buildNodeRecord({ id: 'n', type, label: 'x', position: { x: 0, y: 0 } }).data
    expect(data('image')).toEqual({ src: '' })
    expect(data('video')).toEqual({ src: '', poster: '' })
    expect(data('director')).toEqual({})
  })
})

describe('hasNodeResource：节点有没有内容 / 资源', () => {
  it('text 看正文、image / video 看 src，空白不算；导演台、兜底、分组永远没有', () => {
    expect(hasNodeResource('text', { text: '' })).toBe(false)
    expect(hasNodeResource('text', { text: '  \n ' })).toBe(false)
    expect(hasNodeResource('text', { text: '你好' })).toBe(true)
    expect(hasNodeResource('image', { src: '' })).toBe(false)
    expect(hasNodeResource('image', { src: 'https://x/a.png' })).toBe(true)
    // 只有封面不算有视频
    expect(hasNodeResource('video', { src: '', poster: 'https://x/p.png' })).toBe(false)
    expect(hasNodeResource('video', { src: 'https://x/a.mp4' })).toBe(true)
    // 类型不对的值不算
    expect(hasNodeResource('image', { src: 42 })).toBe(false)
    expect(hasNodeResource('director', { src: 'https://x/a.png' })).toBe(false)
    expect(hasNodeResource(FALLBACK_NODE_TYPE, { text: 'x' })).toBe(false)
  })
})

/** 一条已有的线：handle 为空，端口在 data 上 */
const link = (id: string, source: string, target: string, sourcePort?: string, targetPort?: string): FlowEdge => ({
  id,
  source,
  target,
  sourceHandle: null,
  targetHandle: null,
  data: {
    ...(sourcePort ? { sourcePort } : {}),
    ...(targetPort ? { targetPort } : {}),
  },
})

/** 画布上的节点：id → [类型, data] */
type Fixture = Record<string, [string, Record<string, unknown>]>

function contextOf(nodes: Fixture, edges: FlowEdge[] = []): ConnectionContext {
  return { typeOf: (id) => nodes[id]?.[0], dataOf: (id) => nodes[id]?.[1], edges }
}

/** 七种「类型 × 有没有资源」的状态。导演台没有资源这回事，只有一种 */
const STATES: Fixture = {
  文本空: ['text', { text: '' }],
  文本有: ['text', { text: '一只猫' }],
  图片空: ['image', { src: '' }],
  图片有: ['image', { src: 'https://x/a.png' }],
  视频空: ['video', { src: '', poster: '' }],
  视频有: ['video', { src: 'https://x/a.mp4', poster: 'https://x/p.png' }],
  导演台: ['director', {}],
}

describe('连线关系表：4 种类型 × 有 / 无资源的全矩阵', () => {
  /**
   * 每一格：能连就是选中的那对端口 `起点端口→终点端口`；不能连写拒绝原因的关键词。
   * 和 `flow-node-types.ts` 里 `FLOW_NODE_TYPE_DEFAULTS` 上面那张关系表是同一份事实。
   */
  const NO_INPUT = '没有输入端口'
  const HAS_RESOURCE = '已经有资源'
  const MISMATCH = '数据类型不匹配'
  const COLUMNS = ['文本空', '文本有', '图片空', '图片有', '视频空', '视频有', '导演台'] as const
  const MATRIX: Record<string, readonly string[]> = {
    //        文本空     文本有     图片空          图片有        视频空          视频有        导演台
    文本空: [NO_INPUT, NO_INPUT, 'text→text', HAS_RESOURCE, 'text→text', HAS_RESOURCE, 'text→text'],
    文本有: [NO_INPUT, NO_INPUT, 'text→text', HAS_RESOURCE, 'text→text', HAS_RESOURCE, 'text→text'],
    图片空: [NO_INPUT, NO_INPUT, 'image→image', HAS_RESOURCE, 'image→image', HAS_RESOURCE, 'image→image'],
    图片有: [NO_INPUT, NO_INPUT, 'image→image', HAS_RESOURCE, 'image→image', HAS_RESOURCE, 'image→image'],
    视频空: [NO_INPUT, NO_INPUT, 'video→video', HAS_RESOURCE, 'video→video', HAS_RESOURCE, MISMATCH],
    视频有: [NO_INPUT, NO_INPUT, 'video→video', HAS_RESOURCE, 'video→video', HAS_RESOURCE, MISMATCH],
    导演台: [NO_INPUT, NO_INPUT, 'image→image', HAS_RESOURCE, 'image→image', HAS_RESOURCE, 'image→image'],
  }

  for (const [from, row] of Object.entries(MATRIX)) {
    COLUMNS.forEach((to, column) => {
      const expected = row[column]!
      it(`${from} → ${to}：${expected}`, () => {
        // 起点、终点各是一个节点（同一状态也是两个不同的节点）
        const context = contextOf({ src: STATES[from]!, dst: STATES[to]! })
        const verdict = resolveConnection({ source: 'src', target: 'dst' }, context)
        if (expected.includes('→')) {
          const [sourcePort, targetPort] = expected.split('→')
          expect(verdict).toEqual({ ok: true, sourcePort, targetPort })
        } else {
          expect(verdict.ok).toBe(false)
          expect(!verdict.ok && verdict.reason).toContain(expected)
        }
      })
    })
  }

  it('矩阵覆盖了每一种可新建的类型（加了类型就得补这张表）', () => {
    const covered = new Set(Object.values(STATES).map(([type]) => type))
    expect([...covered].sort()).toEqual([...CREATABLE_NODE_TYPES].sort())
  })
})

describe('连线规则：resolveConnection 的其余规则', () => {
  const nodes: Fixture = {
    t1: ['text', { text: 'a' }],
    t2: ['text', { text: 'b' }],
    img: ['image', { src: '' }],
    img2: ['image', { src: '' }],
    full: ['image', { src: 'https://x/a.png' }],
    vid: ['video', { src: '' }],
    dc: ['director', {}],
    p1: [FALLBACK_NODE_TYPE, {}],
    p2: [FALLBACK_NODE_TYPE, {}],
    old: ['image-config', { prompt: '老画布里下线的类型' }],
  }
  const context = (edges: FlowEdge[] = []) => contextOf(nodes, edges)

  it('被连过之后还能从别的节点连进来：每个输入都是不限条数的多输入', () => {
    for (const type of ['image', 'video', 'director']) {
      for (const port of portsOf(type, 'inputs')) {
        expect(port.multiple, `${type}.${port.id}`).toBe(true)
        expect(port.max, `${type}.${port.id}`).toBeUndefined()
      }
    }
    const occupied = [link('e1', 't1', 'img', 'text', 'text'), link('e2', 'img2', 'img', 'image', 'image')]
    expect(resolveConnection({ source: 't2', target: 'img' }, context(occupied))).toEqual({
      ok: true,
      sourcePort: 'text',
      targetPort: 'text',
    })
    expect(resolveConnection({ source: 'dc', target: 'img' }, context(occupied))).toMatchObject({ ok: true, targetPort: 'image' })
  })

  it('同一个上游、同一对端口连过了就试下一对；没有下一对就拒绝', () => {
    const once = [link('e1', 't1', 'img', 'text', 'text')]
    const verdict = resolveConnection({ source: 't1', target: 'img' }, context(once))
    expect(!verdict.ok && verdict.reason).toContain('已经有线')
    // 导演台 → 视频：先 image → image，连过了落到 video → video，两对都连过就拒绝
    const first = [link('e1', 'dc', 'vid', 'image', 'image')]
    expect(resolveConnection({ source: 'dc', target: 'vid' }, context(first))).toEqual({
      ok: true,
      sourcePort: 'video',
      targetPort: 'video',
    })
    const both = [...first, link('e2', 'dc', 'vid', 'video', 'video')]
    expect(resolveConnection({ source: 'dc', target: 'vid' }, context(both)).ok).toBe(false)
  })

  it('导演台 → 图片（没资源时）：先连截图 image → image，连过再连落到录制 video → video；图片 → 导演台走 image → image', () => {
    expect(resolveConnection({ source: 'dc', target: 'img' }, context())).toEqual({ ok: true, sourcePort: 'image', targetPort: 'image' })
    const shot = [link('e1', 'dc', 'img', 'image', 'image')]
    expect(resolveConnection({ source: 'dc', target: 'img' }, context(shot))).toEqual({ ok: true, sourcePort: 'video', targetPort: 'video' })
    expect(resolveConnection({ source: 'dc', target: 'full' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'img', target: 'dc' }, context())).toEqual({ ok: true, sourcePort: 'image', targetPort: 'image' })
  })

  it('有了资源只拒绝新线：已经连着的线不算违规（规则不回头删线）', () => {
    const existing = [link('e1', 't1', 'full', 'text', 'text')]
    const verdict = resolveConnection({ source: 't2', target: 'full' }, context(existing))
    expect(!verdict.ok && verdict.reason).toContain('已经有资源')
    // 重连那条已有的线（它自己被忽略）照样被拒：输入关着就是关着
    expect(resolveConnection({ source: 't1', target: 'full' }, { ...context(existing), ignoreEdgeId: 'e1' }).ok).toBe(false)
  })

  it('取不到 data 的按空对象算（输入开着）', () => {
    const verdict = resolveConnection(
      { source: 't1', target: 'img' },
      { typeOf: (id) => nodes[id]?.[0], dataOf: () => undefined, edges: [] },
    )
    expect(verdict.ok).toBe(true)
  })

  it('max 限制条数：满了就拒绝并说「接满」', () => {
    const inputs = FLOW_NODE_TYPE_DEFAULTS.image!.inputs!
    const original = inputs[1]!
    inputs[1] = { ...original, max: 1 }
    try {
      const occupied = [link('e1', 'img2', 'img', 'image', 'image')]
      const verdict = resolveConnection({ source: 'dc', target: 'img', targetPort: 'image' }, context(occupied))
      expect(!verdict.ok && verdict.reason).toContain('接满')
    } finally {
      inputs[1] = original
    }
  })

  it('显式指定端口时只校验那一对：不存在、类型不兼容、给无端口类型指定端口都拒绝', () => {
    expect(resolveConnection({ source: 't1', target: 'img', targetPort: 'nope' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 't1', target: 'img', targetPort: 'image' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'p1', target: 'p2', sourcePort: 'x' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'dc', target: 'vid', sourcePort: 'video' }, context())).toEqual({
      ok: true,
      sourcePort: 'video',
      targetPort: 'video',
    })
  })

  it('hasSide 带数据：text 只有右边；图片 / 视频有资源时左边收起；兜底类型两边都有', () => {
    expect(hasSide('text', 'inputs', { text: '' })).toBe(false)
    expect(hasSide('text', 'outputs', { text: '' })).toBe(true)
    expect(hasSide('image', 'inputs', { src: '' })).toBe(true)
    expect(hasSide('image', 'inputs', { src: 'https://x/a.png' })).toBe(false)
    expect(hasSide('image', 'outputs', { src: 'https://x/a.png' })).toBe(true)
    expect(hasSide('video', 'inputs', { src: 'https://x/a.mp4' })).toBe(false)
    expect(hasSide('director', 'inputs', {})).toBe(true)
    expect(hasSide(FALLBACK_NODE_TYPE, 'inputs', {})).toBe(true)
    expect(hasSide(FALLBACK_NODE_TYPE, 'outputs', {})).toBe(true)
  })

  it('认不出的老类型按兜底算（无端口、和谁都能连）；无端口之间选出 null / null，同方向已有一条就不连第二条', () => {
    expect(resolveConnection({ source: 'old', target: 'img' }, context())).toEqual({ ok: true, sourcePort: null, targetPort: 'text' })
    expect(resolveConnection({ source: 'p1', target: 'p2' }, context())).toEqual({ ok: true, sourcePort: null, targetPort: null })
    const verdict = resolveConnection({ source: 'p1', target: 'p2' }, context([link('e1', 'p1', 'p2')]))
    expect(!verdict.ok && verdict.reason).toContain('已经有')
  })

  it('自己连自己、节点不存在都拒绝', () => {
    expect(resolveConnection({ source: 'img', target: 'img' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'ghost', target: 'img' }, context()).ok).toBe(false)
  })

  it('connectionEdgeData：带端口的写 sourcePort / targetPort / index（该端口现有最大 + 1）；无端口的不写', () => {
    const existing = [{ ...link('e1', 'img2', 'img', 'image', 'image'), data: { sourcePort: 'image', targetPort: 'image', index: 4 } }]
    expect(connectionEdgeData({ sourcePort: 'image', targetPort: 'image' }, 'img', existing)).toMatchObject({
      sourcePort: 'image',
      targetPort: 'image',
      index: 5,
    })
    const plain = connectionEdgeData({ sourcePort: null, targetPort: null }, 'p2', [])
    expect(Object.keys(plain)).toEqual(['createdAt'])
    // 一侧无端口：只写有的那一侧
    expect(connectionEdgeData({ sourcePort: null, targetPort: 'text' }, 'img', [])).toMatchObject({ targetPort: 'text', index: 1 })
  })
})

describe('connectableNodeTypes：从一个出口能长出哪些类型', () => {
  const types = (nodeId: string, fixture: Fixture = STATES, edges: FlowEdge[] = []) =>
    connectableNodeTypes(nodeId, contextOf(fixture, edges)).map((item) => item.type)

  it('列出肯收它的类型，按可新建顺序；新节点按全新的空节点算（起点有没有资源不影响）', () => {
    expect(types('文本空')).toEqual(['image', 'video', 'director'])
    expect(types('文本有')).toEqual(['image', 'video', 'director'])
    expect(types('图片有')).toEqual(['image', 'video', 'director'])
    expect(types('视频空')).toEqual(['image', 'video'])
  })

  it('导演台的出口：图片、视频（还有导演台）都能长', () => {
    expect(types('导演台')).toEqual(['image', 'video', 'director'])
  })

  it('认不出的老节点（兜底、无端口）：出口能接所有收东西的类型', () => {
    expect(types('old', { old: ['image-config', {}] })).toEqual(['image', 'video', 'director'])
  })

  it('带上那条线会连的端口对，和随后真建时 resolveGrowConnection 选的一致', () => {
    const context = contextOf(STATES)
    const listed = connectableNodeTypes('导演台', context)
    expect(listed[0]).toEqual({ type: 'image', ports: { sourcePort: 'image', targetPort: 'image' } })
    for (const { type, ports } of listed) {
      expect(resolveGrowConnection('导演台', type, 'n_new', context)).toEqual({ ok: true, ...ports })
    }
  })

  it('节点不存在：一个都没有', () => {
    expect(types('ghost')).toEqual([])
  })
})
