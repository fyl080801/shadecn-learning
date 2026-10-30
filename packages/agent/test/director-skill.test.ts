import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { fauxAssistantMessage, fauxToolCall, validateToolArguments, type Context } from '@mariozechner/pi-ai'
import { AgentEventType, formatNodeMention, type AgentStreamEvent } from '@shadecn/shared/agent'
import { DIRECTOR_LIMITS, readDirectorScene } from '@shadecn/shared/director-doc'
import { compileDirectorTimeline, objectStateAt } from '@shadecn/shared/director-eval'
import { nodeGroup, nodesMap, toYNode } from '@shadecn/shared/flow-doc'
import { buildNodeRecord } from '@shadecn/shared/flow-node-types'
import { createMemoryAuthorityProvider } from '../src/authority.ts'
import { createDocCanvasHandle } from '../src/canvas.ts'
import { createAgentRuntime, type OpenedCanvas } from '../src/session.ts'
import {
  BUILTIN_SKILLS,
  createDirectorTools,
  DIRECTOR_READ_TOOL_NAMES,
  DIRECTOR_WRITE_TOOL_NAMES,
  directorSkill,
  NO_SANDBOX,
} from '../src/skills/index.ts'
import { createMemoryConversationStore, createMemoryRunLog } from '../src/store.ts'
import { createInlineDriver, gatewayFetch, loadSkillStep, registerScriptedModel, type ScriptedStep } from '../src/testing.ts'
import { createCanvasTools, TOOL_LIMITS, type CanvasTool, type ToolRunState } from '../src/tools.ts'

/**
 * 导演台技能 `director`（docs/07 §7.3.1–§7.3.2、§7.4）：
 * - 端到端（scripted model + 进程内 runner，网关按 schema 再校验、按技能判加载）：提及自动加载 / 按需加载、全局 agent（任意导演台）、写 → 量的数值闭环；
 * - 其余直接对 `createDocCanvasHandle` 上的工具测：删除预算、整批拒绝且文档不变、按秒取时刻、elementIds、画布工具不碰 dc.*。
 */

const DIRECTOR_TOOLS = [...DIRECTOR_WRITE_TOOL_NAMES, ...DIRECTOR_READ_TOOL_NAMES]

function seedNode(doc: Y.Doc, id: string, type: string, label = `名字-${id}`, data: Record<string, unknown> = {}) {
  nodesMap(doc).set(id, toYNode({ ...buildNodeRecord({ id, type, label, position: { x: 0, y: 0 } }), data }))
}

const dataOf = (doc: Y.Doc, id: string) => (nodeGroup(doc, id, 'data')?.toJSON() ?? {}) as Record<string, unknown>
const sceneOf = (doc: Y.Doc, id: string) => readDirectorScene(dataOf(doc, id))
const json = (res: { content: { type: string; text?: string }[] }) => JSON.parse((res.content[0] as { text: string }).text)

// —— 直接对工具测 ——

function setup(options: { runState?: ToolRunState } = {}) {
  const doc = new Y.Doc()
  doc.transact(() => {
    seedNode(doc, 'n_dir', 'director', '片头')
    seedNode(doc, 'n_b', 'director', '别的导演台')
    seedNode(doc, 'n_txt', 'text', '文案')
  })
  let writes = 0
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) writes++
  })
  const canvas = createDocCanvasHandle(doc, { flowId: 'f1', runId: 'run_1' })
  const runState = options.runState ?? { deleted: 0, mediaBytes: 0 }
  const tools = new Map(
    createDirectorTools({ side: 'server', canvas, runState, sandbox: NO_SANDBOX }).map((tool) => [tool.name, tool]),
  )
  const canvasTools = new Map(createCanvasTools({ canvas, runState }).map((tool) => [tool.name, tool]))
  const toolOf = (name: string) => (tools.get(name) ?? canvasTools.get(name)) as CanvasTool
  /** 照网关的做法：先按 schema 校验，再执行 */
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = toolOf(name)
    const checked = validateToolArguments(tool, { type: 'toolCall', id: 'c', name, arguments: args })
    return tool.execute('c', checked as never)
  }
  /** 绕开 schema 直接执行：模拟 schema 漏网的输入，看工具 / ops 自己挡不挡 */
  const raw = (name: string, args: Record<string, unknown>) => toolOf(name).execute('c', args as never)
  return { doc, call, raw, runState, writes: () => writes }
}

/** 调用必须失败、且文档一个字节都没变；返回错误信息 */
async function rejected(env: ReturnType<typeof setup>, run: () => Promise<unknown>): Promise<string> {
  const before = Y.encodeStateAsUpdate(env.doc)
  const writes = env.writes()
  let message = '没有抛'
  try {
    await run()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).not.toBe('没有抛')
  expect(Y.encodeStateAsUpdate(env.doc)).toEqual(before)
  expect(env.writes()).toBe(writes)
  return message
}

async function addTableAndCube(env: ReturnType<typeof setup>) {
  const res = await env.call('add_objects', {
    nodeId: 'n_dir',
    objects: [
      { kind: 'box', name: '桌子', geometry: { width: 1.2, height: 0.8, depth: 0.6 }, color: '#8b5a2b' },
      { kind: 'box', name: '方块', geometry: { width: 0.5, height: 0.5, depth: 0.5 }, position: [2, 1, 0] },
    ],
  })
  const out = json(res)
  return { res, table: out.objects[0].id as string, cube: out.objects[1].id as string }
}

describe('技能定义', () => {
  it('director 在内置注册表里：auto 命中 director 类型，16 个工具都在网关执行，删除工具是 flow:delete', () => {
    expect(BUILTIN_SKILLS.get('director')).toBe(directorSkill)
    expect(directorSkill.activation).toBe('auto')
    expect(directorSkill.activatesFor?.nodeTypes).toEqual(['director'])
    const tools = BUILTIN_SKILLS.get('director')!.tools({ side: 'runner', canvas: { flowId: '', read: vi.fn(), write: vi.fn() }, runState: { deleted: 0, mediaBytes: 0 }, sandbox: NO_SANDBOX })
    expect(tools.map((tool) => tool.name).sort()).toEqual([...DIRECTOR_TOOLS].sort())
    for (const tool of tools) expect(tool.execution ?? 'gateway').toBe('gateway')
    const capability = Object.fromEntries(tools.map((tool) => [tool.name, tool.capability]))
    for (const name of DIRECTOR_READ_TOOL_NAMES) expect(capability[name]).toBe('flow:read')
    expect(capability.delete_director_elements).toBe('flow:delete')
    for (const name of DIRECTOR_WRITE_TOOL_NAMES.filter((name) => name !== 'delete_director_elements')) {
      expect(capability[name]).toBe('flow:write')
    }
    // 提示段写清单位、坐标系和「看不到画面」
    expect(directorSkill.prompt).toContain('米、度、秒')
    expect(directorSkill.prompt).toContain('y = 0')
    expect(directorSkill.prompt).toContain('-Z')
    expect(directorSkill.prompt).toContain('180°')
    expect(directorSkill.prompt).toContain('看不到画面')
  })
})

describe('写 → 量的数值闭环', () => {
  it('add → place on_top → measure：0.5m 方块放到 0.8m 高的桌面上，底面高度 0.8m（误差 < 1mm），check_scene 不报穿插', async () => {
    const env = setup()
    const { res, table, cube } = await addTableAndCube(env)
    // 不给位置的几何体落地放在原点
    expect(json(res).objects[0].bounds).toMatchObject({ bottom: 0, size: [1.2, 0.8, 0.6], precision: 'exact' })

    const placed = json(await env.call('place_object', { nodeId: 'n_dir', id: cube, mode: 'on_top', target: table }))
    expect(placed.objects[0].bounds.bottom).toBeCloseTo(0.8, 3)

    const measured = json(await env.call('measure_objects', { nodeId: 'n_dir', objectIds: [cube] }))
    expect(measured.t).toBe(0)
    expect(Math.abs(measured.objects[0].bottom - 0.8)).toBeLessThan(0.001)
    expect(measured.objects[0].center[0]).toBeCloseTo(0, 6)

    const checked = json(await env.call('check_scene', { nodeId: 'n_dir' }))
    expect(checked.ok).toBe(true)
    expect(checked.samples[0]).toMatchObject({ t: 0, intersections: [], floating: [], belowGround: [] })

    const distance = json(await env.call('measure_distance', { nodeId: 'n_dir', a: cube, b: table }))
    expect(distance.overlapping).toBe(false)
    expect(distance.gaps[1]).toBeCloseTo(0, 6)
  })

  it('animate_motion 之后 check_scene / camera_view 按秒取时刻：camera_view 在 1.5 秒的位置就是 objectStateAt(1500ms)', async () => {
    const env = setup()
    const { table } = await addTableAndCube(env)
    const camera = json(await env.call('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'camera', name: '机位1', position: [0, 1.6, 6] }] }))
      .objects[0].id as string

    const orbit = await env.call('animate_motion', {
      nodeId: 'n_dir',
      objectId: camera,
      preset: 'orbit',
      angle: 360,
      centerObjectId: table,
      duration: 4,
    })
    const out = json(orbit)
    // 每 15° 一帧：360° = 24 段 25 帧，位置 + 朝向两条轨道
    expect(out.keyframes.map((report: { property: string; count: number; start: number; end: number }) => [report.property, report.count, report.start, report.end])).toEqual([
      ['position', 25, 0, 4],
      ['rotation', 25, 0, 4],
    ])
    expect(orbit.details.summary).toBe('「机位1」的 orbit 动画：生成 50 个关键帧（0–4 秒）')
    // 时长默认 5 秒，没超就不延长
    expect(out.duration).toBe(5)
    expect(out.durationExtended).toBeUndefined()

    const view = json(await env.call('camera_view', { nodeId: 'n_dir', cameraId: camera, t: 1.5 }))
    const expected = objectStateAt(compileDirectorTimeline(sceneOf(env.doc, 'n_dir')), camera, 1500)!
    expect(view.t).toBe(1.5)
    expect(view.position[0]).toBeCloseTo(expected.position[0], 3)
    expect(view.position[2]).toBeCloseTo(expected.position[2], 3)
    // 机位一直对准桌子：桌子在画面里
    expect(view.objects.find((object: { id: string }) => object.id === table).status).toBe('inside')

    const checked = json(await env.call('check_scene', { nodeId: 'n_dir', times: [0, 1, 2.5], cameraId: camera }))
    expect(checked.samples.map((sample: { t: number }) => sample.t)).toEqual([0, 1, 2.5])
    expect(checked.cameraId).toBe(camera)
  })
})

describe('参数与整批拒绝', () => {
  it('批量超过上限：schema 先挡；绕开 schema 也被 ops 整个拒绝，文档不变', async () => {
    const env = setup()
    const many = Array.from({ length: DIRECTOR_LIMITS.batch + 1 }, () => ({ kind: 'box' }))
    expect(await rejected(env, () => env.call('add_objects', { nodeId: 'n_dir', objects: many }))).toContain('Validation failed')
    expect(await rejected(env, () => env.raw('add_objects', { nodeId: 'n_dir', objects: many }))).toContain(`一次最多 ${DIRECTOR_LIMITS.batch} 项`)
    expect(sceneOf(env.doc, 'n_dir').objects.size).toBe(0)
  })

  it('一批里有一项不合格（box 没有 radius）：整个拒绝，前面合格的也不写', async () => {
    const env = setup()
    const message = await rejected(env, () =>
      env.call('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'sphere' }, { kind: 'box', geometry: { radius: 1 } }] }),
    )
    expect(message).toContain('没有几何参数 radius')
    expect(sceneOf(env.doc, 'n_dir').objects.size).toBe(0)
  })

  it('非法参数：枚举外的种类、越界的数、模式不配的字段都被拒，文档不变', async () => {
    const env = setup()
    const { cube, table } = await addTableAndCube(env)
    await rejected(env, () => env.call('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'model' }] }))
    await rejected(env, () => env.call('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'box', position: [0, 0, 5000] }] }))
    await rejected(env, () => env.call('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'box', color: 'red' }] }))
    expect(await rejected(env, () => env.call('place_object', { nodeId: 'n_dir', id: cube, mode: 'on_top' }))).toContain('必须给 target')
    expect(
      await rejected(env, () => env.call('place_object', { nodeId: 'n_dir', id: cube, mode: 'ground', target: table })),
    ).toContain('不用 target')
    expect(
      await rejected(env, () => env.call('animate_motion', { nodeId: 'n_dir', objectId: cube, preset: 'turn', axis: 'y', duration: 1 })),
    ).toContain('必须给 degrees')
    expect(
      await rejected(env, () =>
        env.call('animate_motion', { nodeId: 'n_dir', objectId: cube, preset: 'turn', axis: 'y', degrees: 90, points: [[0, 0, 0]], duration: 1 }),
      ),
    ).toContain('不用 points')
    expect(await rejected(env, () => env.call('aim_camera', { nodeId: 'n_dir', cameraId: cube, targetObjectId: table }))).toContain('不是机位')
    expect(await rejected(env, () => env.call('set_director_settings', { nodeId: 'n_dir' }))).toContain('至少给一个')
  })

  it('点名的对象不存在（写和量都一样）：整个拒绝，提示先 get_director_scene', async () => {
    const env = setup()
    const { cube } = await addTableAndCube(env)
    expect(
      await rejected(env, () =>
        env.call('transform_objects', { nodeId: 'n_dir', transforms: [{ id: cube, by: { translate: [1, 0, 0] } }, { id: 'obj_nope', set: { position: [0, 0, 0] } }] }),
      ),
    ).toContain('get_director_scene')
    expect(await rejected(env, () => env.call('measure_objects', { nodeId: 'n_dir', objectIds: [cube, 'obj_nope'] }))).toContain('obj_nope')
  })

  it('节点不存在 / 不是导演台：给模型可读的错误', async () => {
    const env = setup()
    expect(await rejected(env, () => env.call('get_director_scene', { nodeId: 'n_gone' }))).toContain('先 read_canvas')
    expect(await rejected(env, () => env.call('add_objects', { nodeId: 'n_txt', objects: [{ kind: 'box' }] }))).toContain('不是导演台')
    expect(await rejected(env, () => env.call('measure_objects', { nodeId: 'n_txt' }))).toContain('只能用在 director 类型的节点上')
  })
})

describe('elementIds 与摘要', () => {
  it('写工具的 elementIds 是 <nodeId>/<data 键>；读 / 量的工具为空数组', async () => {
    const env = setup()
    const { res, table, cube } = await addTableAndCube(env)
    expect(res.details.elementIds).toEqual([`n_dir/dc.obj.${table}`, `n_dir/dc.obj.${cube}`])
    expect(res.details.summary).toBe('新建 2 个对象（桌子、方块）')

    const keyed = await env.call('set_keyframes', {
      nodeId: 'n_dir',
      objectId: cube,
      property: 'position',
      keyframes: [
        { t: 0, value: [0, 0.25, 0] },
        { t: 6, value: [1, 0.25, 0] },
      ],
    })
    const out = json(keyed)
    const [report] = out.keyframes
    // 关键帧超出时长自动延长；返回里有轨道 id、帧 id、起止时刻（秒）
    expect(out.durationExtended).toEqual({ from: 5, to: 6 })
    expect(report).toMatchObject({ objectId: cube, property: 'position', createdTrack: true, count: 2, start: 0, end: 6 })
    expect(keyed.details.elementIds).toEqual(
      expect.arrayContaining([
        `n_dir/dc.track.${report.trackId}`,
        ...report.keyframeIds.map((id: string) => `n_dir/dc.kf.${id}`),
        'n_dir/dc.duration',
      ]),
    )
    for (const id of keyed.details.elementIds) expect(id.split('/')).toEqual(['n_dir', expect.stringMatching(/^dc\./)])

    for (const [name, args] of [
      ['get_director_scene', { nodeId: 'n_dir' }],
      ['measure_objects', { nodeId: 'n_dir' }],
      ['measure_distance', { nodeId: 'n_dir', a: table, b: cube }],
      ['check_scene', { nodeId: 'n_dir' }],
    ] as const) {
      expect((await env.call(name, args)).details.elementIds).toEqual([])
    }
  })

  it('get_director_scene 按米 / 度 / 秒给出，带计数；只读部分 id、不列关键帧都行', async () => {
    const env = setup()
    const { cube, table } = await addTableAndCube(env)
    await env.call('transform_objects', { nodeId: 'n_dir', transforms: [{ id: cube, set: { rotation: [0, 45, 0] } }] })
    await env.call('animate_motion', { nodeId: 'n_dir', objectId: cube, preset: 'turn', axis: 'y', degrees: 180, duration: 2 })
    const full = json(await env.call('get_director_scene', { nodeId: 'n_dir' }))
    expect(full).toMatchObject({ nodeId: 'n_dir', name: '片头', duration: 5, counts: { objects: 2, tracks: 1, keyframes: 3 } })
    expect(full.objects.find((object: { id: string }) => object.id === cube).rotation).toEqual([0, 45, 0])
    expect(full.tracks[0].keyframes.map((keyframe: { t: number }) => keyframe.t)).toEqual([0, 1, 2])

    const part = json(await env.call('get_director_scene', { nodeId: 'n_dir', objectIds: [table], includeKeyframes: false }))
    expect(part.objects.map((object: { id: string }) => object.id)).toEqual([table])
    expect(part.tracks).toEqual([])
  })
})

describe('删除预算', () => {
  it('显式点名的各算 1、连带删除不算；和画布删除共用每轮上限，超了整个拒绝', async () => {
    const env = setup()
    const { cube, table } = await addTableAndCube(env)
    await env.call('animate_motion', { nodeId: 'n_dir', objectId: cube, preset: 'turn', axis: 'y', degrees: 90, duration: 1 })

    // 删方块：连带它的轨道和关键帧，只算 1
    const removed = await env.call('delete_director_elements', { nodeId: 'n_dir', objectIds: [cube] })
    expect(env.runState.deleted).toBe(1)
    const out = json(removed)
    expect(out.deleted.objects).toEqual([cube])
    expect(out.deleted.tracks).toHaveLength(1)
    expect(out.deleted.keyframes).toHaveLength(2)
    expect(removed.details.summary).toBe('删除 1 个对象、1 条轨道、2 个关键帧')
    expect(removed.details.elementIds).toContain(`n_dir/dc.obj.${cube}`)

    // 已经不在的点名不扣预算，列进 missing
    const again = json(await env.call('delete_director_elements', { nodeId: 'n_dir', objectIds: [cube] }))
    expect(again.missing).toEqual([cube])
    expect(env.runState.deleted).toBe(1)

    // 画布那边已经花掉一大半：再删 1 个就超
    env.runState.deleted = TOOL_LIMITS.deletePerRun
    const message = await rejected(env, () => env.call('delete_director_elements', { nodeId: 'n_dir', objectIds: [table] }))
    expect(message).toContain('每轮上限')
    expect(sceneOf(env.doc, 'n_dir').objects.has(table)).toBe(true)
  })

  it('一次点名超过 20 个：schema 挡；绕开 schema 工具自己也挡', async () => {
    const env = setup()
    const ids = Array.from({ length: 21 }, (_, i) => `kf_${i}`)
    await rejected(env, () => env.call('delete_director_elements', { nodeId: 'n_dir', keyframeIds: ids }))
    expect(
      await rejected(env, () => env.raw('delete_director_elements', { nodeId: 'n_dir', objectIds: ids.slice(0, 11), keyframeIds: ids.slice(11) })),
    ).toContain('一次最多删 20 个')
    expect(env.runState.deleted).toBe(0)
  })
})

describe('画布工具不碰 dc.*', () => {
  it('update_node 写 / 删 dc.* 被拒，add_node 带 dc.* 被拒；文档不变', async () => {
    const env = setup()
    await addTableAndCube(env)
    expect(await rejected(env, () => env.call('update_node', { id: 'n_dir', data: { 'dc.obj.x': { kind: 'box' } } }))).toContain(
      'director 技能',
    )
    await rejected(env, () => env.call('update_node', { id: 'n_dir', removeData: ['dc.duration'] }))
    // 非导演台节点也不让写 dc.*（这个前缀归导演台）
    await rejected(env, () => env.call('update_node', { id: 'n_txt', data: { 'dc.fps': 24 } }))
    await rejected(env, () => env.call('add_node', { type: 'director', metadata: { label: '新的' }, data: { 'dc.fps': 24 } }))
    // 别的字段照常能改
    await env.call('update_node', { id: 'n_dir', data: { prompt: '一个桌面' } })
    expect(dataOf(env.doc, 'n_dir').prompt).toBe('一个桌面')
  })

  it('read_canvas / get_node 对导演台只给摘要，不逐个列出 dc.* 键', async () => {
    const env = setup()
    const { cube } = await addTableAndCube(env)
    await env.call('animate_motion', { nodeId: 'n_dir', objectId: cube, preset: 'turn', axis: 'y', degrees: 90, duration: 2 })
    await env.call('update_node', { id: 'n_dir', data: { prompt: '一个桌面' } })

    const canvas = json(await env.call('read_canvas', {}))
    const node = canvas.nodes.find((item: { id: string }) => item.id === 'n_dir')
    const single = json(await env.call('get_node', { id: 'n_dir' }))
    for (const view of [node, single]) {
      const keys = Object.keys(view.data)
      expect(keys.filter((key) => key.startsWith('dc.') && key !== 'dc.*')).toEqual([])
      expect(view.data.prompt).toBe('一个桌面')
      expect(view.data['dc.*']).toMatchObject({ objects: 2, tracks: 1, keyframes: 2, durationSeconds: 5 })
      expect(view.data['dc.*'].note).toContain('get_director_scene')
    }
  })
})

describe('没有会话范围（直接调工具，docs/20 §3.10.9）', () => {
  it('同一套工具对画布上任意导演台都能读写量；点名不是导演台的节点由 ops 拒绝、文档不变', async () => {
    const env = setup()
    await addTableAndCube(env)
    const added = json(await env.call('add_objects', { nodeId: 'n_b', objects: [{ kind: 'box', name: '箱子' }] }))
    expect(json(await env.call('get_director_scene', { nodeId: 'n_b' })).objects.map((object: { name: string }) => object.name)).toEqual(['箱子'])
    expect(json(await env.call('measure_objects', { nodeId: 'n_b' })).objects).toHaveLength(1)
    await env.call('delete_director_elements', { nodeId: 'n_b', objectIds: [added.objects[0].id] })
    expect(sceneOf(env.doc, 'n_b').objects.size).toBe(0)
    // 另一个导演台没被碰
    expect(sceneOf(env.doc, 'n_dir').objects.size).toBe(2)
    await rejected(env, () => env.call('add_objects', { nodeId: 'n_txt', objects: [{ kind: 'box' }] }))
  })
})

// —— 端到端：scripted model + 进程内 runner ——

let faux: ReturnType<typeof registerScriptedModel> | null = null

afterEach(() => {
  faux = null
  vi.unstubAllGlobals()
})

function runtimeWith(steps: ScriptedStep[]) {
  faux = registerScriptedModel({ imageInput: true })
  faux.setResponses(steps)
  const store = createMemoryConversationStore()
  const runLog = createMemoryRunLog()
  // 默认路径：内置注册表（runtime 和 runner 两侧都用 BUILTIN_SKILLS）
  const runtime = createAgentRuntime({
    ...faux.runtimeOptions(createInlineDriver()),
    store,
    runLog,
    userProfiles: async (ids) => new Map(ids.map((id) => [id, { id, name: id, avatarUrl: null }])),
    authorities: createMemoryAuthorityProvider(),
  })
  vi.stubGlobal('fetch', gatewayFetch((request) => runtime.gateway.handle(request)))
  return Object.assign(runtime, { store, runLog })
}

async function run(runtime: ReturnType<typeof runtimeWith>, doc: Y.Doc, options: { text?: string; nodeId?: string | null } = {}) {
  const events: AgentStreamEvent[] = []
  const open = async (runId: string): Promise<OpenedCanvas> => ({
    ...createDocCanvasHandle(doc, { flowId: 'flow-1', runId }),
    async close() {},
  })
  const started = await runtime.start({
    flowId: 'flow-1',
    userId: 'u1',
    conversationId: null,
    nodeId: options.nodeId ?? null,
    text: options.text ?? '搭个场景',
    openCanvas: open,
    emit: (event) => events.push(event),
  })
  if (!started.ok) throw new Error(started.message)
  await started.done
  const first = events[0]
  return { events, threadId: first?.type === AgentEventType.RUN_STARTED ? first.threadId : '' }
}

/** 记下每次模型请求看到的工具名与系统提示 */
function probe() {
  const requests: { tools: string[]; systemPrompt: string; context: Context }[] = []
  const step =
    (reply: (context: Context) => ReturnType<typeof fauxAssistantMessage>): ScriptedStep =>
    (context) => {
      requests.push({ tools: (context.tools ?? []).map((tool) => tool.name), systemPrompt: context.systemPrompt ?? '', context })
      return reply(context)
    }
  return { requests, step }
}

/** 上一个工具结果（模型看到的那份文字，按 JSON 解析） */
function lastResult(context: Context) {
  const message = [...context.messages].reverse().find((item) => item.role === 'toolResult')
  const text = message?.role === 'toolResult' ? message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
  return JSON.parse(text)
}

function storedResults(runtime: ReturnType<typeof runtimeWith>, threadId: string) {
  return (runtime.store.rows.get(threadId)?.llmMessages ?? []).flatMap((message) =>
    message.role === 'toolResult'
      ? [{ name: message.toolName, isError: message.isError, text: message.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }]
      : [],
  )
}

const toolCall = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })

describe('端到端：自动加载与按需加载', () => {
  it('普通会话里 @ 提及导演台节点：第一次请求就有导演台工具（和画布编辑工具一起）', async () => {
    const doc = new Y.Doc()
    seedNode(doc, 'n_dir', 'director', '片头')
    const { requests, step } = probe()
    const runtime = runtimeWith([step(() => fauxAssistantMessage('好'))])
    await run(runtime, doc, { text: `在 ${formatNodeMention('n_dir')} 里搭个桌子` })
    expect(requests[0]!.tools).toEqual(expect.arrayContaining([...DIRECTOR_TOOLS, 'add_node', 'read_canvas']))
    expect(requests[0]!.systemPrompt).toContain('### 导演台（director）')
    expect(requests[0]!.systemPrompt).toContain('看不到画面')
  })

  it('不提及：技能目录里有 director；load_skill 之后同一轮就能用，写进了文档', async () => {
    const doc = new Y.Doc()
    seedNode(doc, 'n_dir', 'director', '片头')
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() => loadSkillStep('director')),
      step(() => toolCall('add_objects', { nodeId: 'n_dir', objects: [{ kind: 'box', name: '桌子' }] })),
      step(() => fauxAssistantMessage('好了')),
    ])
    const { events, threadId } = await run(runtime, doc)
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })
    expect(requests[0]!.tools).not.toContain('add_objects')
    expect(requests[0]!.systemPrompt).toContain('- director：')
    expect(requests[1]!.tools).toEqual(expect.arrayContaining(DIRECTOR_TOOLS))
    expect(storedResults(runtime, threadId)).toMatchObject([
      { name: 'load_skill', isError: false },
      { name: 'add_objects', isError: false },
    ])
    expect([...sceneOf(doc, 'n_dir').objects.values()].map((object) => object.name)).toEqual(['桌子'])
  })
})

describe('端到端：从导演台 A 发起的会话（入口 nodeId + 提及 A，全局 agent）', () => {
  it('canvas 工具全在；对 A 写 → 量闭环成功（底面误差 < 1mm），elementIds 进审计；也能改导演台 B、加画布节点', async () => {
    const doc = new Y.Doc()
    seedNode(doc, 'n_a', 'director', '片头')
    seedNode(doc, 'n_b', 'director', '片尾')
    const ids: { table?: string; cube?: string } = {}
    const { requests, step } = probe()
    const runtime = runtimeWith([
      step(() =>
        toolCall('add_objects', {
          nodeId: 'n_a',
          objects: [
            { kind: 'box', name: '桌子', geometry: { width: 1.2, height: 0.8, depth: 0.6 } },
            { kind: 'box', name: '方块', geometry: { width: 0.5, height: 0.5, depth: 0.5 }, position: [3, 0.25, 0] },
          ],
        }),
      ),
      step((context) => {
        const added = lastResult(context)
        ids.table = added.objects[0].id
        ids.cube = added.objects[1].id
        return toolCall('place_object', { nodeId: 'n_a', id: ids.cube, mode: 'on_top', target: ids.table })
      }),
      step(() => toolCall('measure_objects', { nodeId: 'n_a', objectIds: [ids.cube] })),
      step(() => toolCall('check_scene', { nodeId: 'n_a' })),
      step(() => toolCall('add_objects', { nodeId: 'n_b', objects: [{ kind: 'box', name: '片尾的箱子' }] })),
      step(() => toolCall('add_node', { type: 'text', metadata: { label: '分镜说明' } })),
      step(() => fauxAssistantMessage('搭好了')),
    ])
    // 导演台里发起的新会话：前端在开头放上这个导演台的提及，第一条消息带入口 nodeId
    const { events, threadId } = await run(runtime, doc, { nodeId: 'n_a', text: `${formatNodeMention('n_a')} 搭个桌子` })
    expect(events.at(-1)).toMatchObject({ type: AgentEventType.RUN_FINISHED, outcome: { type: 'success' } })

    // 第一次请求：提及触发导演台工具自动加载，画布工具一个不少
    const first = requests[0]!
    expect(first.tools).toEqual(
      expect.arrayContaining([...DIRECTOR_TOOLS, 'read_canvas', 'get_node', 'add_node', 'update_node', 'connect', 'delete_elements', 'auto_layout']),
    )

    // 量出来的底面高度就是桌面高度
    const measured = lastResult(requests[3]!.context)
    expect(Math.abs(measured.objects[0].bottom - 0.8)).toBeLessThan(0.001)
    expect(lastResult(requests[4]!.context).ok).toBe(true)

    const results = storedResults(runtime, threadId)
    expect(results.map((item) => [item.name, item.isError])).toEqual([
      ['add_objects', false],
      ['place_object', false],
      ['measure_objects', false],
      ['check_scene', false],
      ['add_objects', false],
      ['add_node', false],
    ])
    expect([...sceneOf(doc, 'n_b').objects.values()].map((object) => object.name)).toEqual(['片尾的箱子'])
    expect([...nodesMap(doc).values()].map((node) => (node.get('metadata') as Y.Map<unknown>).get('label'))).toContain('分镜说明')

    // 审计里的 elementIds：写的是 <nodeId>/<键>，读 / 量的为空
    const calls = runtime.runLog.toolCalls.map((call) => [call.name, call.ok, call.elementIds] as const)
    expect(calls[0]).toEqual(['add_objects', true, [`n_a/dc.obj.${ids.table}`, `n_a/dc.obj.${ids.cube}`]])
    expect(calls[1]).toEqual(['place_object', true, [`n_a/dc.obj.${ids.cube}`]])
    expect(calls[2]).toEqual(['measure_objects', true, []])
  })
})
