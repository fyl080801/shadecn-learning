import { describe, expect, it } from 'vitest'
import { FALLBACK_NODE_TYPE, type FlowEdge } from '../src/flow-graph.ts'
import {
  buildNodeRecord,
  connectableNodeTypes,
  defaultNodeSize,
  FALLBACK_NODE_SIZE,
  nodeSizeOf,
  connectionEdgeData,
  CREATABLE_NODE_TYPES,
  FLOW_NODE_TYPE_DEFAULTS,
  GROUP_DEFAULT_BACKGROUND,
  GROUP_DEFAULT_SIZE,
  GROUP_Z_INDEX,
  hasNodeResource,
  hasSide,
  interactionGate,
  nodeFormOf,
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

/**
 * 「类型 × 资源 × 形态」的状态。导演台没有资源、没有形态，只有一种；
 * 图片 / 视频：generate 没图、generate 有图（有连入时上传的）、asset（没有连入时上传的）。
 */
const STATES: Fixture = {
  文本空: ['text', { text: '' }],
  文本有: ['text', { text: '一只猫' }],
  图片生成: ['image', { src: '' }],
  图片生成有图: ['image', { src: 'https://x/a.png', form: 'generate' }],
  图片素材: ['image', { src: 'https://x/a.png', form: 'asset' }],
  视频生成: ['video', { src: '', poster: '' }],
  视频生成有图: ['video', { src: 'https://x/a.mp4', poster: 'https://x/p.png' }],
  视频素材: ['video', { src: 'https://x/a.mp4', poster: 'https://x/p.png', form: 'asset' }],
  导演台: ['director', {}],
}

const COLUMNS = Object.keys(STATES)
const NO_INPUT = '没有输入端口'
const MISMATCH = '数据类型不匹配'
const ASSET = '素材'

/**
 * 逻辑门（`resolveConnection`，agent 的 `connect`、`flow-ops`）：**只做端口匹配**，资源、形态都不看。
 * 每一格：能连就是选中的那对端口 `起点端口→终点端口`；不能连写拒绝原因的关键词。
 * 和 `flow-node-types.ts` 里 `FLOW_NODE_TYPE_DEFAULTS` 上面那张关系表是同一份事实。
 */
const T = 'text→text'
const I = 'image→image'
const V = 'video→video'
const LOGIC_ROW = {
  //        文本空     文本有     图片生成 图片生成有图 图片素材 视频生成 视频生成有图 视频素材 导演台
  text: [NO_INPUT, NO_INPUT, T, T, T, T, T, T, T],
  image: [NO_INPUT, NO_INPUT, I, I, I, I, I, I, I],
  video: [NO_INPUT, NO_INPUT, V, V, V, V, V, V, MISMATCH],
  director: [NO_INPUT, NO_INPUT, I, I, I, I, I, I, I],
} as const
const rowOf = (state: string) => LOGIC_ROW[STATES[state]![0] as keyof typeof LOGIC_ROW]

/** 人拖线 = 先过交互门、再过逻辑门（`useFlowCanvas` 的 `resolve`） */
function interactive(context: ConnectionContext) {
  const gate = interactionGate({ target: 'dst' }, context)
  return gate.ok ? resolveConnection({ source: 'src', target: 'dst' }, context) : gate
}

function expectVerdict(verdict: ReturnType<typeof interactive>, expected: string) {
  if (expected.includes('→')) {
    const [sourcePort, targetPort] = expected.split('→')
    expect(verdict).toEqual({ ok: true, sourcePort, targetPort })
  } else {
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.reason).toContain(expected)
  }
}

describe('连线关系表（逻辑门）：起点 × 终点的全矩阵，形态和资源都不影响', () => {
  for (const from of COLUMNS) {
    COLUMNS.forEach((to, column) => {
      const expected = rowOf(from)[column]!
      it(`${from} → ${to}：${expected}`, () => {
        // 起点、终点各是一个节点（同一状态也是两个不同的节点）
        expectVerdict(resolveConnection({ source: 'src', target: 'dst' }, contextOf({ src: STATES[from]!, dst: STATES[to]! })), expected)
      })
    })
  }

  it('矩阵覆盖了每一种可新建的类型（加了类型就得补这张表）', () => {
    const covered = new Set(Object.values(STATES).map(([type]) => type))
    expect([...covered].sort()).toEqual([...CREATABLE_NODE_TYPES].sort())
  })
})

describe('连线关系表（交互门 + 逻辑门）：人拖线进 asset 形态的节点一律拒绝，其余同逻辑门', () => {
  for (const from of COLUMNS) {
    COLUMNS.forEach((to, column) => {
      const expected = to.endsWith('素材') ? ASSET : rowOf(from)[column]!
      it(`${from} ⇢ ${to}：${expected}`, () => {
        expectVerdict(interactive(contextOf({ src: STATES[from]!, dst: STATES[to]! })), expected)
      })
    })
  }
})

describe('形态：nodeFormOf / hasSide / interactionGate', () => {
  it('只有图片 / 视频有形态；字段缺失或不认识一律 generate（不按 src 反推）', () => {
    expect(nodeFormOf('image', {})).toBe('generate')
    expect(nodeFormOf('image', { src: 'https://x/a.png' })).toBe('generate')
    expect(nodeFormOf('image', { form: 'asset' })).toBe('asset')
    expect(nodeFormOf('video', { form: 'asset' })).toBe('asset')
    expect(nodeFormOf('video', { form: 'weird' })).toBe('generate')
    expect(nodeFormOf('text', { form: 'asset' })).toBeNull()
    expect(nodeFormOf('director', {})).toBeNull()
    expect(nodeFormOf(FALLBACK_NODE_TYPE, {})).toBeNull()
  })

  it('hasSide 按形态：asset 的左边收起，右边照旧；有没有图不影响；text 只有右边；兜底类型两边都有', () => {
    expect(hasSide('text', 'inputs', { text: '' })).toBe(false)
    expect(hasSide('text', 'outputs', { text: '' })).toBe(true)
    expect(hasSide('image', 'inputs', { src: '' })).toBe(true)
    expect(hasSide('image', 'inputs', { src: 'https://x/a.png' })).toBe(true)
    expect(hasSide('image', 'inputs', { src: 'https://x/a.png', form: 'asset' })).toBe(false)
    expect(hasSide('image', 'outputs', { form: 'asset' })).toBe(true)
    expect(hasSide('video', 'inputs', { form: 'asset' })).toBe(false)
    expect(hasSide('director', 'inputs', {})).toBe(true)
    expect(hasSide(FALLBACK_NODE_TYPE, 'inputs', {})).toBe(true)
    expect(hasSide(FALLBACK_NODE_TYPE, 'outputs', {})).toBe(true)
  })

  it('交互门只看终点的形态：起点是 asset 照样能拖出去；终点不存在交给逻辑门去报', () => {
    const context = contextOf({ a: ['image', { form: 'asset' }], b: ['image', {}] })
    expect(interactionGate({ target: 'b' }, context)).toEqual({ ok: true })
    expect(interactionGate({ target: 'ghost' }, context)).toEqual({ ok: true })
    expect(interactionGate({ target: 'a' }, context).ok).toBe(false)
  })

  it('长出新节点的候选菜单：从 asset 节点照样能长（新节点是 generate）', () => {
    const context = contextOf({ a: ['image', { src: 'https://x/a.png', form: 'asset' }] })
    expect(connectableNodeTypes('a', context).map((item) => item.type)).toEqual(['image', 'video', 'director'])
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

  it('导演台 → 图片：先连截图 image → image，连过再连落到录制 video → video；图片 → 导演台走 image → image', () => {
    expect(resolveConnection({ source: 'dc', target: 'img' }, context())).toEqual({ ok: true, sourcePort: 'image', targetPort: 'image' })
    const shot = [link('e1', 'dc', 'img', 'image', 'image')]
    expect(resolveConnection({ source: 'dc', target: 'img' }, context(shot))).toEqual({ ok: true, sourcePort: 'video', targetPort: 'video' })
    // 有没有图不影响逻辑门
    expect(resolveConnection({ source: 'dc', target: 'full' }, context())).toMatchObject({ ok: true, targetPort: 'image' })
    expect(resolveConnection({ source: 'img', target: 'dc' }, context())).toEqual({ ok: true, sourcePort: 'image', targetPort: 'image' })
  })

  it('取不到 data 的按空对象算（generate，交互门也放行）', () => {
    expect(interactionGate({ target: 'img' }, { typeOf: (id) => nodes[id]?.[0], dataOf: () => undefined })).toEqual({ ok: true })
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

describe('分组不参与连线', () => {
  const group: [string, Record<string, unknown>] = ['group', {}]
  const fallback: [string, Record<string, unknown>] = [FALLBACK_NODE_TYPE, {}]

  it('分组连不出去，也连不进来（和兜底类型、可新建类型都一样拒绝）', () => {
    for (const other of [fallback, ...Object.values(STATES)]) {
      const out = resolveConnection({ source: 'src', target: 'dst' }, contextOf({ src: group, dst: other }))
      const into = resolveConnection({ source: 'src', target: 'dst' }, contextOf({ src: other, dst: group }))
      expect(out.ok).toBe(false)
      expect(into.ok).toBe(false)
      expect(!into.ok && into.reason).toContain('不能连线')
    }
  })

  it('两侧都没有连接点，从分组长不出任何节点；兜底类型照旧左右各一个', () => {
    expect(hasSide('group', 'inputs', {})).toBe(false)
    expect(hasSide('group', 'outputs', {})).toBe(false)
    expect(connectableNodeTypes('src', contextOf({ src: group }))).toEqual([])
    expect(hasSide(FALLBACK_NODE_TYPE, 'inputs', {})).toBe(true)
    expect(hasSide(FALLBACK_NODE_TYPE, 'outputs', {})).toBe(true)
  })
})

describe('connectableNodeTypes：从一个出口能长出哪些类型', () => {
  const types = (nodeId: string, fixture: Fixture = STATES, edges: FlowEdge[] = []) =>
    connectableNodeTypes(nodeId, contextOf(fixture, edges)).map((item) => item.type)

  it('列出肯收它的类型，按可新建顺序；新节点按全新的空节点算（起点有没有资源不影响）', () => {
    expect(types('文本空')).toEqual(['image', 'video', 'director'])
    expect(types('文本有')).toEqual(['image', 'video', 'director'])
    expect(types('图片生成有图')).toEqual(['image', 'video', 'director'])
    expect(types('图片素材')).toEqual(['image', 'video', 'director'])
    expect(types('视频生成')).toEqual(['image', 'video'])
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

describe('nodeSizeOf：不量 DOM 时的节点尺寸', () => {
  it('布局里存了正数宽高就用存的，没存 / 不是正数的那一边按类型的 defaultSize 估', () => {
    expect(nodeSizeOf({ type: 'image', layout: { width: 480, height: 240 } })).toEqual({ width: 480, height: 240 })
    expect(nodeSizeOf({ type: 'text', layout: {} })).toEqual({ width: 320, height: 120 })
    expect(nodeSizeOf({ type: 'text', layout: { width: 0, height: Number.NaN } })).toEqual({ width: 320, height: 120 })
    expect(nodeSizeOf({ type: 'text', layout: { width: 500 } })).toEqual({ width: 500, height: 120 })
  })

  it('每种类型都声明了 defaultSize；认不出的类型按兜底类型估；分组的估计就是它的默认尺寸', () => {
    for (const type of Object.keys(FLOW_NODE_TYPE_DEFAULTS)) {
      expect(FLOW_NODE_TYPE_DEFAULTS[type]!.defaultSize, type).toBeDefined()
    }
    expect(defaultNodeSize('legacy-kind')).toEqual(defaultNodeSize(FALLBACK_NODE_TYPE))
    expect(defaultNodeSize('group')).toEqual(GROUP_DEFAULT_SIZE)
    expect(FALLBACK_NODE_SIZE.width).toBeGreaterThan(0)
  })
})
