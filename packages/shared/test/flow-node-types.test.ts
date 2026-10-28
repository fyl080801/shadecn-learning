import { describe, expect, it } from 'vitest'
import { FALLBACK_NODE_TYPE, type FlowEdge } from '../src/flow-graph.ts'
import {
  buildNodeRecord,
  findGrowType,
  FLOW_NODE_TYPE_DEFAULTS,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_Z_INDEX,
  connectionEdgeData,
  hasSide,
  nodeTypeDefaultsOf,
  portsOf,
  resolveConnection,
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

  it('样例里的七种业务节点都在注册表里，且都声明了端口', () => {
    for (const type of ['text-input', 'text-config', 'image-source', 'image-config', 'video-source', 'video-config', 'director-console']) {
      const def = FLOW_NODE_TYPE_DEFAULTS[type]
      expect(def, type).toBeDefined()
      expect((def!.inputs?.length ?? 0) + (def!.outputs?.length ?? 0), type).toBeGreaterThan(0)
    }
    // 没声明端口的保持现状：单个无 id 的连接点
    expect(portsOf('text', 'inputs')).toEqual([])
    expect(portsOf('group', 'outputs')).toEqual([])
  })
})

describe('连线规则：resolveConnection 自动选端口', () => {
  const types: Record<string, string> = {
    src: 'image-source',
    src2: 'image-source',
    cfg: 'image-config',
    vid: 'video-config',
    vsrc: 'video-source',
    dc: 'director-console',
    txt: 'text-input',
    txt2: 'text-input',
    t1: 'text',
    t2: 'text',
  }
  const context = (edges: FlowEdge[] = []) => ({ typeOf: (id: string) => types[id], edges })
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

  it('样例里出现过的连线都能连，并自动选出那对端口', () => {
    const cases: [string, string, string, string][] = [
      ['src', 'cfg', 'image', 'image'],
      ['cfg', 'vid', 'image', 'image'],
      ['src', 'src2', 'image', 'image'],
      ['txt', 'vid', 'text', 'text'],
      ['dc', 'src', 'image', 'image'],
      ['vsrc', 'vid', 'video', 'video'],
    ]
    for (const [source, target, sourcePort, targetPort] of cases) {
      expect(resolveConnection({ source, target }, context()), `${source} → ${target}`).toEqual({
        ok: true,
        sourcePort,
        targetPort,
      })
    }
  })

  it('多输出连到只收某一种的：跳过不兼容的输出（导演台 → 视频素材走 video）', () => {
    expect(resolveConnection({ source: 'dc', target: 'vsrc' }, context())).toEqual({
      ok: true,
      sourcePort: 'video',
      targetPort: 'video',
    })
  })

  it('按声明顺序、起点在外层：导演台 → 视频生成先选 image → image；那对连过了再连就落到 video → video', () => {
    expect(resolveConnection({ source: 'dc', target: 'vid' }, context())).toMatchObject({
      sourcePort: 'image',
      targetPort: 'image',
    })
    expect(resolveConnection({ source: 'dc', target: 'vid' }, context([link('e1', 'dc', 'vid', 'image', 'image')]))).toMatchObject({
      sourcePort: 'video',
      targetPort: 'video',
    })
  })

  it('一对兼容的都没有就拒绝', () => {
    const verdict = resolveConnection({ source: 'txt', target: 'src' }, context())
    expect(verdict).toMatchObject({ ok: false })
    expect(!verdict.ok && verdict.reason).toContain('数据类型不匹配')
  })

  it('目标端口满了就试下一对；全满才拒绝', () => {
    // 提示词是单输入：第二个文本输入连不进图生图（图片端口类型不兼容）
    const occupied = [link('e1', 'txt', 'cfg', 'text', 'text')]
    const verdict = resolveConnection({ source: 'txt2', target: 'cfg' }, context(occupied))
    expect(!verdict.ok && verdict.reason).toContain('接满')
    // 无端口的 text 节点按 any 算：提示词满了，就落到还没满的图片端口上
    expect(resolveConnection({ source: 't1', target: 'cfg' }, context(occupied))).toEqual({
      ok: true,
      sourcePort: null,
      targetPort: 'image',
    })
  })

  it('多输入端口不限条数；max 限制条数', () => {
    const many = [link('e1', 'src', 'cfg', 'image', 'image'), link('e2', 'src2', 'cfg', 'image', 'image')]
    expect(resolveConnection({ source: 'dc', target: 'cfg' }, context(many))).toMatchObject({ ok: true, targetPort: 'image' })

    const original = FLOW_NODE_TYPE_DEFAULTS['image-config']!.inputs![0]!
    FLOW_NODE_TYPE_DEFAULTS['image-config']!.inputs![0] = { ...original, max: 2 }
    try {
      expect(resolveConnection({ source: 'dc', target: 'cfg', targetPort: 'image' }, context(many)).ok).toBe(false)
    } finally {
      FLOW_NODE_TYPE_DEFAULTS['image-config']!.inputs![0] = original
    }
  })

  it('显式指定端口时只校验那一对：不存在、类型不兼容、给无端口类型指定端口都拒绝', () => {
    expect(resolveConnection({ source: 'src', target: 'cfg', targetPort: 'nope' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'src', target: 'cfg', targetPort: 'text' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 't1', target: 't2', sourcePort: 'x' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'dc', target: 'vid', sourcePort: 'video' }, context())).toEqual({
      ok: true,
      sourcePort: 'video',
      targetPort: 'video',
    })
  })

  it('声明过端口、但这一侧一个都没有的类型连不进去（text-input 没有输入，画布上左边也没有连接点）', () => {
    expect(resolveConnection({ source: 't1', target: 'txt' }, context()).ok).toBe(false)
    expect(hasSide('text-input', 'inputs')).toBe(false)
    expect(hasSide('text-input', 'outputs')).toBe(true)
    expect(hasSide('text', 'inputs')).toBe(true)
  })

  it('无端口类型之间照旧可连（选出来是 null / null），同方向已经有一条就不连第二条', () => {
    expect(resolveConnection({ source: 't1', target: 't2' }, context())).toEqual({ ok: true, sourcePort: null, targetPort: null })
    const verdict = resolveConnection({ source: 't1', target: 't2' }, context([link('e1', 't1', 't2')]))
    expect(!verdict.ok && verdict.reason).toContain('已经有')
  })

  it('改端点时被改的那条自己不算占用；自己连自己、节点不存在都拒绝', () => {
    const occupied = [link('e1', 'txt', 'cfg', 'text', 'text')]
    expect(
      resolveConnection({ source: 'txt2', target: 'cfg' }, { ...context(occupied), ignoreEdgeId: 'e1' }),
    ).toEqual({ ok: true, sourcePort: 'text', targetPort: 'text' })
    expect(resolveConnection({ source: 'src', target: 'src' }, context()).ok).toBe(false)
    expect(resolveConnection({ source: 'ghost', target: 'cfg' }, context()).ok).toBe(false)
  })

  it('connectionEdgeData：带端口的写 sourcePort / targetPort / index（该端口现有最大 + 1）；无端口的不写', () => {
    const existing = [{ ...link('e1', 'src', 'cfg', 'image', 'image'), data: { sourcePort: 'image', targetPort: 'image', index: 4 } }]
    expect(connectionEdgeData({ sourcePort: 'image', targetPort: 'image' }, 'cfg', existing)).toMatchObject({
      sourcePort: 'image',
      targetPort: 'image',
      index: 5,
    })
    const plain = connectionEdgeData({ sourcePort: null, targetPort: null }, 't2', [])
    expect(Object.keys(plain)).toEqual(['createdAt'])
    // 一侧无端口：只写有的那一侧
    expect(connectionEdgeData({ sourcePort: null, targetPort: 'text' }, 'cfg', [])).toMatchObject({ targetPort: 'text', index: 1 })
  })

  it('findGrowType 按顺序取第一个能连上的类型，不看无端口类型', () => {
    const order = Object.keys(FLOW_NODE_TYPE_DEFAULTS)
    const fromSource = (source: string) => (type: string) =>
      resolveConnection({ source, target: 'new' }, { typeOf: (id) => (id === 'new' ? type : types[id]), edges: [] })
    expect(findGrowType(order, fromSource('src'))).toEqual({ type: 'image-config', ports: { sourcePort: 'image', targetPort: 'image' } })
    expect(findGrowType(order, fromSource('vsrc'))?.type).toBe('video-config')
    expect(findGrowType(order, fromSource('txt'))).toEqual({ type: 'image-config', ports: { sourcePort: 'text', targetPort: 'text' } })
    expect(findGrowType(['text', 'process'], fromSource('src'))).toBeNull()
  })
})
