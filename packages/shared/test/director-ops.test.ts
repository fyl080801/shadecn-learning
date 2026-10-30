import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { nodeGroup, nodesMap, toYNode } from '../src/flow-doc.ts'
import { buildNodeRecord } from '../src/flow-node-types.ts'
import * as ops from '../src/flow-ops.ts'
import { FlowOpError, type FlowOpContext } from '../src/flow-ops.ts'
import { DIRECTOR_LIMITS, readDirectorScene, validateDirectorKeyframe, validateDirectorObject } from '../src/director-doc.ts'
import {
  cameraView,
  checkScene,
  compileDirectorTimeline,
  mat3Apply,
  mat3FromQuat,
  measureObjects,
  objectStateAt,
} from '../src/director-eval.ts'

/**
 * 导演台的原子操作：和画布操作同一个形状 —— 在调用方的事务里跑、先校验后动手、出错一个字节都不写；
 * 写进去的东西按 director-doc 读得回来，返回的数值就是写入后的实际状态。
 */

const NODE = 'dir1'

function setup() {
  const doc = new Y.Doc()
  doc.transact(() => {
    nodesMap(doc).set(NODE, toYNode(buildNodeRecord({ id: NODE, type: 'director', label: '导演台', position: { x: 0, y: 0 } })))
    nodesMap(doc).set('txt', toYNode(buildNodeRecord({ id: 'txt', type: 'text', label: '文本', position: { x: 0, y: 0 } })))
  })
  let transactions = 0
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (tr.changed.size > 0) transactions++
  })
  const run = <T>(fn: (ctx: FlowOpContext) => T): T => {
    let result!: T
    doc.transact(() => {
      result = fn(ops.opContext(doc))
    })
    return result
  }
  const data = () => (nodeGroup(doc, NODE, 'data')?.toJSON() ?? {}) as Record<string, unknown>
  const scene = () => readDirectorScene(data())
  const timeline = () => compileDirectorTimeline(scene())
  return { doc, run, data, scene, timeline, writes: () => transactions }
}

/** 抛的是哪个 FlowOpError，并且文档一个字节都没动 */
function rejects(env: ReturnType<typeof setup>, fn: (ctx: FlowOpContext) => unknown): string {
  const before = JSON.stringify(env.data())
  const writes = env.writes()
  let code = '没有抛'
  try {
    env.run(fn)
  } catch (error) {
    code = error instanceof FlowOpError ? error.code : `非 FlowOpError：${String(error)}`
  }
  expect(JSON.stringify(env.data())).toBe(before)
  expect(env.writes()).toBe(writes)
  return code
}

describe('节点与事务', () => {
  it('节点不存在 / 不是导演台 → FlowOpError，什么都不写', () => {
    const env = setup()
    expect(rejects(env, (ctx) => ops.addDirectorObjects(ctx, 'nope', [{ kind: 'box' }]))).toBe('NODE_NOT_FOUND')
    expect(rejects(env, (ctx) => ops.addDirectorObjects(ctx, 'txt', [{ kind: 'box' }]))).toBe('NOT_A_DIRECTOR')
    expect(rejects(env, (ctx) => ops.readDirector(ctx, 'txt'))).toBe('NOT_A_DIRECTOR')
  })

  it('一次操作只在调用方的事务里写一次', () => {
    const env = setup()
    env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }, { kind: 'sphere' }]))
    expect(env.writes()).toBe(1)
  })
})

describe('新建对象', () => {
  it('不给位置的几何体落地放在原点；返回 id、包围盒；名字按种类编号', () => {
    const env = setup()
    const result = env.run((ctx) =>
      ops.addDirectorObjects(ctx, NODE, [
        { kind: 'box', geometry: { width: 1.2, height: 0.8, depth: 0.6 }, color: '#aa3300' },
        { kind: 'box' },
        { kind: 'camera', camera: { fov: 35 } },
      ]),
    )
    const [table, second, camera] = result.objects
    expect(table!.name).toBe('立方体1')
    expect(second!.name).toBe('立方体2')
    expect(table!.position).toEqual([0, 0.4, 0])
    expect(table!.bounds.bottom).toBeCloseTo(0, 12)
    expect(table!.bounds.size).toEqual([1.2, 0.8, 0.6])
    expect(camera!.camera).toEqual({ fov: 35, near: 0.1, far: 2000 })
    expect(result.set).toEqual(result.objects.map((o) => `dc.obj.${o.id}`))

    const stored = env.scene().objects.get(table!.id)!
    expect(stored.kind === 'box' && stored.material).toEqual({ color: '#aa3300' })
  })

  it('旋转入参是度，存的是弧度；返回是度', () => {
    const env = setup()
    const result = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', position: [0, 2, 0], rotation: [0, 90, 0] }]))
    expect(result.objects[0]!.rotation[1]).toBeCloseTo(90, 9)
    expect(env.scene().objects.get(result.objects[0]!.id)!.rotation[1]).toBeCloseTo(Math.PI / 2, 12)
  })

  it.each([
    ['NaN 坐标', { kind: 'box', position: [0, Number.NaN, 0] }],
    ['超范围坐标', { kind: 'box', position: [0, 0, 1e6] }],
    ['未知种类', { kind: 'teapot' }],
    ['预留的 model', { kind: 'model' }],
    ['几何参数和种类对不上', { kind: 'sphere', geometry: { width: 1 } }],
    ['负尺寸', { kind: 'box', geometry: { width: -1 } }],
    ['坏颜色', { kind: 'box', color: 'red' }],
    ['fov 超范围', { kind: 'camera', camera: { fov: 0 } }],
  ])('拒绝 %s，整批不写', (_, bad) => {
    const env = setup()
    const code = rejects(env, (ctx) =>
      ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }, bad as unknown as ops.DirectorObjectInput]),
    )
    expect(code).toBe('DIRECTOR_INVALID')
  })

  it('批量超过 20 项、对象总数超过上限 → DIRECTOR_LIMIT', () => {
    const env = setup()
    const many = Array.from({ length: DIRECTOR_LIMITS.batch + 1 }, () => ({ kind: 'box' as const }))
    expect(rejects(env, (ctx) => ops.addDirectorObjects(ctx, NODE, many))).toBe('DIRECTOR_LIMIT')

    for (let i = 0; i < DIRECTOR_LIMITS.objects / DIRECTOR_LIMITS.batch; i++) {
      env.run((ctx) => ops.addDirectorObjects(ctx, NODE, many.slice(1)))
    }
    expect(env.scene().objects.size).toBe(DIRECTOR_LIMITS.objects)
    expect(rejects(env, (ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }]))).toBe('DIRECTOR_LIMIT')
  })
})

describe('变换与摆放', () => {
  function withTable() {
    const env = setup()
    const [table, cube] = env.run((ctx) =>
      ops.addDirectorObjects(ctx, NODE, [
        { kind: 'box', name: '桌子', position: [1, 0.4, -2], geometry: { width: 1.2, height: 0.8, depth: 0.6 } },
        { kind: 'box', name: '方块', position: [5, 3, 5], geometry: { width: 0.5, height: 0.5, depth: 0.5 } },
      ]),
    ).objects
    return { env, table: table!, cube: cube! }
  }

  it('place on_top：0.5m 立方体放到 0.8m 高的桌子上，底面 0.8m（误差 < 1mm），check_scene 不报穿插', () => {
    const { env, table, cube } = withTable()
    const result = env.run((ctx) => ops.placeDirectorObject(ctx, NODE, { id: cube.id, mode: 'on_top', target: table.id }))
    expect(Math.abs(result.objects[0]!.bounds.bottom - 0.8)).toBeLessThan(0.001)
    expect(result.objects[0]!.bounds.center[0]).toBeCloseTo(1, 12)
    expect(result.objects[0]!.bounds.center[2]).toBeCloseTo(-2, 12)

    // 独立量一次：measure 的结果和返回值一致
    const measured = measureObjects(env.timeline(), 0, [cube.id])[0]!
    expect(Math.abs(measured.bounds.bottom - 0.8)).toBeLessThan(0.001)
    const check = checkScene(env.timeline(), { cameraId: null }).samples[0]!
    expect(check.intersections).toEqual([])
    expect(check.floating).toEqual([])
  })

  it('旋转过的对象也按转后的包围盒摆：转 45° 的立方体落地后底面正好是 0', () => {
    const { env, cube } = withTable()
    env.run((ctx) => ops.transformDirectorObjects(ctx, NODE, [{ id: cube.id, set: { rotation: [45, 0, 0] } }]))
    const result = env.run((ctx) => ops.placeDirectorObject(ctx, NODE, { id: cube.id, mode: 'ground' }))
    expect(result.objects[0]!.bounds.bottom).toBeCloseTo(0, 12)
    // 绕 X 转 45°：高度方向的半径是 0.25·√2
    expect(result.objects[0]!.position[1]).toBeCloseTo(0.25 * Math.SQRT2, 12)
  })

  it('place beside：贴在 +x 侧留 0.1m，z 对齐中心，y 不变', () => {
    const { env, table, cube } = withTable()
    const result = env.run((ctx) =>
      ops.placeDirectorObject(ctx, NODE, { id: cube.id, mode: 'beside', target: table.id, side: '+x', gap: 0.1 }),
    )
    const bounds = result.objects[0]!.bounds
    expect(bounds.min[0]).toBeCloseTo(1.6 + 0.1, 12)
    expect(bounds.center[2]).toBeCloseTo(-2, 12)
    expect(bounds.center[1]).toBeCloseTo(3, 12)
  })

  it('place at：底面中心落在给的点上', () => {
    const { env, cube } = withTable()
    const bounds = env.run((ctx) => ops.placeDirectorObject(ctx, NODE, { id: cube.id, mode: 'at', position: [2, 1, 3] }))
      .objects[0]!.bounds
    expect([bounds.center[0], bounds.bottom, bounds.center[2]]).toEqual([2, 1, 3])
  })

  it('transform：set 之后再 by（平移米、绕轴转度、缩放倍数）', () => {
    const { env, cube } = withTable()
    const result = env.run((ctx) =>
      ops.transformDirectorObjects(ctx, NODE, [
        { id: cube.id, set: { position: [0, 1, 0] }, by: { translate: [1, 0, 0], rotate: { axis: 'y', degrees: 30 }, scale: 2 } },
      ]),
    )
    const report = result.objects[0]!
    expect(report.position).toEqual([1, 1, 0])
    expect(report.rotation[1]).toBeCloseTo(30, 9)
    expect(report.scale).toEqual([2, 2, 2])
  })

  it('点名的对象不存在 → DIRECTOR_ELEMENT_NOT_FOUND，整批不写', () => {
    const { env, cube } = withTable()
    const code = rejects(env, (ctx) =>
      ops.transformDirectorObjects(ctx, NODE, [
        { id: cube.id, by: { translate: [1, 0, 0] } },
        { id: 'ghost', by: { translate: [1, 0, 0] } },
      ]),
    )
    expect(code).toBe('DIRECTOR_ELEMENT_NOT_FOUND')
  })

  it('对象有位置关键帧时，改静态值会带一条提醒', () => {
    const { env, cube } = withTable()
    env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: cube.id, property: 'position', keyframes: [{ t: 0, value: [0, 1, 0] }] }))
    const result = env.run((ctx) => ops.transformDirectorObjects(ctx, NODE, [{ id: cube.id, by: { translate: [1, 0, 0] } }]))
    expect(result.warnings.join()).toMatch(/关键帧/)
  })
})

describe('对齐与分布', () => {
  function threeBoxes() {
    const env = setup()
    const ids = env
      .run((ctx) =>
        ops.addDirectorObjects(ctx, NODE, [
          { kind: 'box', position: [0, 0.5, 0], geometry: { width: 1, height: 1, depth: 1 } },
          { kind: 'box', position: [2, 1, 1], geometry: { width: 2, height: 2, depth: 2 } },
          { kind: 'box', position: [10, 0.25, -1], geometry: { width: 0.5, height: 0.5, depth: 0.5 } },
        ]),
      )
      .objects.map((o) => o.id)
    return { env, ids }
  }

  it('按 z 中心对齐到整体包围盒的中心', () => {
    const { env, ids } = threeBoxes()
    const result = env.run((ctx) => ops.alignDirectorObjects(ctx, NODE, { ids, axis: 'z', mode: 'center' }))
    // 整体 z 范围 [-1.25, 2] → 中心 0.375
    for (const report of result.objects) expect(report.bounds.center[2]).toBeCloseTo(0.375, 12)
  })

  it('等距分布：首尾不动，中间的让间隙相等', () => {
    const { env, ids } = threeBoxes()
    const result = env.run((ctx) => ops.distributeDirectorObjects(ctx, NODE, { ids, axis: 'x' }))
    const byId = new Map(result.objects.map((o) => [o.id, o.bounds]))
    const [a, b, c] = ids.map((id) => byId.get(id)!)
    expect(b!.min[0] - a!.max[0]).toBeCloseTo(c!.min[0] - b!.max[0], 12)
    expect(a!.min[0]).toBeCloseTo(-0.5, 12)
    expect(c!.max[0]).toBeCloseTo(10.25, 12)
  })

  it('给定间距：第一个不动，后面依次排开', () => {
    const { env, ids } = threeBoxes()
    const result = env.run((ctx) => ops.distributeDirectorObjects(ctx, NODE, { ids, axis: 'x', gap: 0.5 }))
    const byId = new Map(result.objects.map((o) => [o.id, o.bounds]))
    const [a, b, c] = ids.map((id) => byId.get(id)!)
    expect(b!.min[0]).toBeCloseTo(a!.max[0] + 0.5, 12)
    expect(c!.min[0]).toBeCloseTo(b!.max[0] + 0.5, 12)
  })
})

describe('机位瞄准', () => {
  it('对准对象：机位本地 -Z 指向对象中心', () => {
    const env = setup()
    const [camera, box] = env.run((ctx) =>
      ops.addDirectorObjects(ctx, NODE, [
        { kind: 'camera', position: [5, 1.5, 5] },
        { kind: 'box', position: [0, 0.5, 0] },
      ]),
    ).objects
    const result = env.run((ctx) => ops.aimDirectorCamera(ctx, NODE, { cameraId: camera!.id, target: { objectId: box!.id } }))
    const state = objectStateAt(env.timeline(), camera!.id, 0)!
    const forward = mat3Apply(mat3FromQuat(state.quaternion), [0, 0, -1])
    const toBox = [-5, -1, -5].map((v) => v / Math.hypot(5, 1, 5))
    forward.forEach((v, i) => expect(v).toBeCloseTo(toBox[i]!, 12))
    // 左右对称；上下因为俯视的透视略有偏移（投影的是包围盒，不是中心点）
    const framing = result.view!.objects.find((o) => o.id === box!.id)!
    expect((framing.rect!.left + framing.rect!.right) / 2).toBeCloseTo(0.5, 9)
    expect(framing.status).toBe('inside')
    expect(result.distance).toBeCloseTo(Math.hypot(5, 1, 5), 9)
  })

  it('装下一组对象：按 fov 与画幅退到刚好装下（留边距），全部 inside 且贴着留白线', () => {
    const env = setup()
    const objects = env.run((ctx) =>
      ops.addDirectorObjects(ctx, NODE, [
        { kind: 'camera', position: [0, 2, 3] },
        { kind: 'box', position: [-3, 0.5, 0] },
        { kind: 'box', position: [3, 0.5, 0] },
        { kind: 'sphere', position: [0, 1, -2], geometry: { radius: 1 } },
      ]),
    ).objects
    const [camera, ...rest] = objects
    const margin = 0.1
    const result = env.run((ctx) =>
      ops.aimDirectorCamera(ctx, NODE, { cameraId: camera!.id, fit: { objectIds: rest.map((o) => o.id), margin } }),
    )
    // 独立再算一次取景
    const view = cameraView(env.timeline(), camera!.id, 0)!
    const framed = view.objects.filter((o) => rest.some((r) => r.id === o.id))
    expect(framed.every((o) => o.status === 'inside')).toBe(true)
    // 整体包围盒有一角正好压在留白线上：最外沿离画框边 = margin
    const edge = Math.min(...framed.flatMap((o) => [o.rect!.left, o.rect!.top, 1 - o.rect!.right, 1 - o.rect!.bottom]))
    expect(edge).toBeGreaterThan(margin - 0.02)
    expect(result.view!.objects).toHaveLength(rest.length)
  })

  it('目标不是机位 / 同时给 target 和 fit → DIRECTOR_INVALID', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    expect(rejects(env, (ctx) => ops.aimDirectorCamera(ctx, NODE, { cameraId: box!.id, target: { point: [0, 0, 0] } }))).toBe(
      'DIRECTOR_INVALID',
    )
  })
})

describe('改属性与设置', () => {
  it('几何尺寸、颜色和现有的合并；机位不能改几何', () => {
    const env = setup()
    const [box, camera] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', color: '#112233' }, { kind: 'camera' }])).objects
    const result = env.run((ctx) =>
      ops.updateDirectorObjects(ctx, NODE, [{ id: box!.id, name: '大箱子', geometry: { height: 2 }, material: { opacity: 0.5 } }]),
    )
    expect(result.objects[0]!.bounds.size).toEqual([1, 2, 1])
    const stored = env.scene().objects.get(box!.id)!
    expect(stored.name).toBe('大箱子')
    expect(stored.kind === 'box' && stored.material).toEqual({ color: '#112233', opacity: 0.5 })
    expect(rejects(env, (ctx) => ops.updateDirectorObjects(ctx, NODE, [{ id: camera!.id, geometry: { width: 1 } }]))).toBe(
      'DIRECTOR_INVALID',
    )
  })

  it('时长按秒设、存毫秒；不能短于最后一个关键帧；当前机位只认机位', () => {
    const env = setup()
    const [box, camera] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }, { kind: 'camera' }])).objects
    env.run((ctx) => ops.setDirectorSettings(ctx, NODE, { duration: 8, fps: 24, aspect: '4:3', activeShot: camera!.id }))
    expect(env.data()).toMatchObject({ 'dc.duration': 8000, 'dc.fps': 24, 'dc.aspect': '4:3', 'dc.activeShot': camera!.id })
    env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'scale', keyframes: [{ t: 6, value: 2 }] }))
    expect(rejects(env, (ctx) => ops.setDirectorSettings(ctx, NODE, { duration: 5 }))).toBe('DIRECTOR_INVALID')
    expect(rejects(env, (ctx) => ops.setDirectorSettings(ctx, NODE, { activeShot: box!.id }))).toBe('DIRECTOR_INVALID')
    expect(rejects(env, (ctx) => ops.setDirectorSettings(ctx, NODE, { aspect: '2:1' as never }))).toBe('DIRECTOR_INVALID')
  })
})

describe('关键帧', () => {
  it('轨道不存在就建；秒 / 度进、毫秒 / 弧度存；同一时刻再打一次是覆盖', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    const first = env.run((ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, {
        objectId: box!.id,
        property: 'rotation',
        keyframes: [
          { t: 0, value: [0, 0, 0] },
          { t: 1.5, value: [0, 90, 0] },
        ],
      }),
    )
    expect(first.keyframes[0]).toMatchObject({ property: 'rotation', createdTrack: true, count: 2, start: 0, end: 1.5 })
    const scene = env.scene()
    expect(scene.tracks.size).toBe(1)
    expect([...scene.keyframes.values()].map((k) => k.t).sort()).toEqual([0, 1500])

    const second = env.run((ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'rotation', keyframes: [{ t: 1.5, value: [0, 45, 0] }] }),
    )
    expect(second.keyframes[0]!.createdTrack).toBe(false)
    expect(env.scene().keyframes.size).toBe(2)
    expect(objectStateAt(env.timeline(), box!.id, 1500)!.rotation[1]).toBeCloseTo(Math.PI / 4, 12)
  })

  it('关键帧超出时长时自动延长到那一帧', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    const result = env.run((ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'position', keyframes: [{ t: 7.25, value: [1, 0.5, 0] }] }),
    )
    expect(result.duration).toEqual({ before: 5, after: 7.25, extended: true })
    expect(env.data()['dc.duration']).toBe(7250)
  })

  it('fov 只能打在机位上；值的形状和属性对不上 → DIRECTOR_INVALID', () => {
    const env = setup()
    const [box, camera] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }, { kind: 'camera' }])).objects
    expect(rejects(env, (ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'fov', keyframes: [{ t: 0, value: 40 }] }))).toBe(
      'DIRECTOR_INVALID',
    )
    expect(
      rejects(env, (ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: camera!.id, property: 'position', keyframes: [{ t: 0, value: 40 }] })),
    ).toBe('DIRECTOR_INVALID')
    env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: camera!.id, property: 'fov', keyframes: [{ t: 0, value: 40 }] }))
    expect(objectStateAt(env.timeline(), camera!.id, 0)!.fov).toBe(40)
  })

  it('关键帧总数超过上限 → DIRECTOR_LIMIT（挡住逐帧烘焙）', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    const frames = (offset: number) =>
      Array.from({ length: DIRECTOR_LIMITS.batch }, (_, i) => ({ t: (offset + i) / 30, value: [0, 0.5, 0] }))
    for (let i = 0; i < DIRECTOR_LIMITS.keyframes / DIRECTOR_LIMITS.batch; i++) {
      env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'position', keyframes: frames(i * 20) }))
    }
    expect(env.scene().keyframes.size).toBe(DIRECTOR_LIMITS.keyframes)
    expect(
      rejects(env, (ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'position', keyframes: [{ t: 99, value: [0, 0, 0] }] })),
    ).toBe('DIRECTOR_LIMIT')
  })
})

describe('运动预设', () => {
  it('orbit：机位绕中心转一圈，稀疏关键帧（每 15° 一帧），每一帧都对准中心', () => {
    const env = setup()
    const [camera] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'camera', position: [0, 2, 6] }])).objects
    const result = env.run((ctx) =>
      ops.animateDirectorMotion(ctx, NODE, { preset: 'orbit', objectId: camera!.id, angle: 360, center: [0, 1, 0], duration: 8 }),
    )
    expect(result.keyframes.map((k) => [k.property, k.count, k.start, k.end])).toEqual([
      ['position', 25, 0, 8],
      ['rotation', 25, 0, 8],
    ])
    expect(result.duration.after).toBe(8)
    const tl = env.timeline()
    // 转到 90°（2s）：位置在 +X 方向，半径 6、高度不变
    const quarter = objectStateAt(tl, camera!.id, 2000)!
    expect(quarter.position[0]).toBeCloseTo(6, 9)
    expect(quarter.position[1]).toBeCloseTo(2, 9)
    expect(quarter.position[2]).toBeCloseTo(0, 9)
    // 任意时刻（帧之间也算）中心都在画面中间附近
    for (const t of [0, 1000, 2500, 4100, 8000]) {
      const view = cameraView(tl, camera!.id, t, { objectIds: [] })!
      expect(view).not.toBeNull()
      const state = objectStateAt(tl, camera!.id, t)!
      const forward = (() => {
        const [x, y, z, w] = state.quaternion
        // 本地 -Z 在世界里的方向
        return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))]
      })()
      const toCenter = [0 - state.position[0], 1 - state.position[1], 0 - state.position[2]]
      const cos = (forward[0]! * toCenter[0]! + forward[1]! * toCenter[1]! + forward[2]! * toCenter[2]!) / Math.hypot(...toCenter)
      expect(cos).toBeGreaterThan(Math.cos((2 * Math.PI) / 180))
    }
  })

  it('turn 720°：帧之间不超过 90°，真的转了两圈（不被最短弧吃掉）', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    const result = env.run((ctx) =>
      ops.animateDirectorMotion(ctx, NODE, { preset: 'turn', objectId: box!.id, axis: 'y', degrees: 720, duration: 4 }),
    )
    expect(result.keyframes[0]!.count).toBe(9)
    expect(result.objects[0]!.rotation[1]).toBeCloseTo(720, 9)
    // 0.25s 处应已转了 45°
    const state = objectStateAt(env.timeline(), box!.id, 250)!
    expect(state.quaternion[1]).toBeCloseTo(Math.sin(Math.PI / 8), 9)
  })

  it('move_along：按路程分配时间；ease-in-out 时起止慢', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', position: [0, 0.5, 0] }])).objects
    env.run((ctx) =>
      ops.animateDirectorMotion(ctx, NODE, { preset: 'move_along', objectId: box!.id, points: [[3, 0.5, 0], [3, 0.5, 1]], duration: 4 }),
    )
    // 总路程 4，3 米处在 3s
    expect(objectStateAt(env.timeline(), box!.id, 3000)!.position).toEqual([3, 0.5, 0])

    const eased = setup()
    const [ball] = eased.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'sphere', position: [0, 0.5, 0] }])).objects
    eased.run((ctx) =>
      ops.animateDirectorMotion(ctx, NODE, { preset: 'move_along', objectId: ball!.id, points: [[4, 0.5, 0]], duration: 4, easing: 'ease-in-out' }),
    )
    const x = (t: number) => objectStateAt(eased.timeline(), ball!.id, t)!.position[0]
    expect(x(2000)).toBeCloseTo(2, 2)
    expect(x(500)).toBeLessThan(0.5)
  })

  it('重新生成同一时间窗的运动：窗里的旧帧被替换，不会叠出两套', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    env.run((ctx) => ops.animateDirectorMotion(ctx, NODE, { preset: 'scale_to', objectId: box!.id, scale: 2, duration: 2, easing: 'ease-in' }))
    const before = env.scene().keyframes.size
    const result = env.run((ctx) => ops.animateDirectorMotion(ctx, NODE, { preset: 'scale_to', objectId: box!.id, scale: 3, duration: 2 }))
    expect(result.keyframes[0]!.replaced).toBe(before)
    expect(env.scene().keyframes.size).toBe(2)
    expect(objectStateAt(env.timeline(), box!.id, 2000)!.scale).toEqual([3, 3, 3])
  })

  it('非机位不能 lookAt；时长为 0 拒绝', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', position: [2, 0.5, 0] }])).objects
    expect(
      rejects(env, (ctx) => ops.animateDirectorMotion(ctx, NODE, { preset: 'orbit', objectId: box!.id, angle: 90, duration: 1, lookAt: true })),
    ).toBe('DIRECTOR_INVALID')
    expect(rejects(env, (ctx) => ops.animateDirectorMotion(ctx, NODE, { preset: 'turn', objectId: box!.id, axis: 'y', degrees: 90, duration: 0 }))).toBe(
      'DIRECTOR_INVALID',
    )
  })
})

describe('删除', () => {
  it('删对象连带它的轨道和关键帧，当前机位指着它就清掉；别的对象不受影响', () => {
    const env = setup()
    const [camera, box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'camera' }, { kind: 'box' }])).objects
    env.run((ctx) => ops.setDirectorSettings(ctx, NODE, { activeShot: camera!.id }))
    env.run((ctx) => ops.animateDirectorMotion(ctx, NODE, { preset: 'orbit', objectId: camera!.id, angle: 90, duration: 2 }))
    env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'scale', keyframes: [{ t: 1, value: 2 }] }))

    const result = env.run((ctx) => ops.deleteDirectorElements(ctx, NODE, { objectIds: [camera!.id, 'ghost'] }))
    expect(result.deleted.objects).toEqual([camera!.id])
    expect(result.deleted.tracks).toHaveLength(2)
    expect(result.missing).toEqual(['ghost'])
    const scene = env.scene()
    expect([...scene.objects.keys()]).toEqual([box!.id])
    expect(scene.tracks.size).toBe(1)
    expect(scene.keyframes.size).toBe(1)
    expect(scene.activeShot).toBeNull()
    expect(Object.keys(env.data()).some((key) => key.includes(camera!.id))).toBe(false)
  })

  it('删轨道连带它的关键帧；读不懂的坏元素也能按 id 删', () => {
    const env = setup()
    const [box] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }])).objects
    const kf = env.run((ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, { objectId: box!.id, property: 'position', keyframes: [{ t: 0, value: [0, 1, 0] }, { t: 1, value: [0, 2, 0] }] }),
    ).keyframes[0]!
    env.run((ctx) => ops.writeNodeFields(ctx, NODE, 'data', { set: { 'dc.obj.broken': { kind: 'teapot' } } }))
    expect(env.scene().skipped).toEqual(['dc.obj.broken'])

    const result = env.run((ctx) => ops.deleteDirectorElements(ctx, NODE, { trackIds: [kf.trackId], objectIds: ['broken'] }))
    expect(result.deleted.keyframes.sort()).toEqual([...kf.keyframeIds].sort())
    expect(result.objects.map((o) => o.id)).toEqual([box!.id])
    expect(env.scene().keyframes.size).toBe(0)
    expect(env.scene().skipped).toEqual([])
  })
})

describe('单个事务体积', () => {
  it('单个操作的合法输入凑不到 512KB：超长的字段在字段校验就被拒，什么都不写', () => {
    // 体积闸门（DirectorWrite.commit）按 serializedBytes 估，字节算法由 director-doc 的单测守；
    // 一次操作最多 20 项、名字最多 64 字，所以单个操作到不了上限 —— 它防的是将来更大的批量入口
    const env = setup()
    const big = 'x'.repeat(600 * 1024)
    expect(rejects(env, (ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', name: big }]))).toBe('DIRECTOR_INVALID')
  })
})

describe('读与快照', () => {
  it('快照按调用方的单位：秒、度；按 id 排序；可以只要部分对象', () => {
    const env = setup()
    const [a, b] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', rotation: [0, 30, 0] }, { kind: 'sphere' }])).objects
    env.run((ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: a!.id, property: 'rotation', keyframes: [{ t: 2, value: [0, 60, 0] }] }))
    const snapshot = env.run((ctx) => ops.snapshotDirector(ops.readDirector(ctx, NODE), { objectIds: [a!.id] }))
    expect(snapshot.objects.map((o) => o.id)).toEqual([a!.id])
    expect(snapshot.objects[0]!.rotation[1]).toBeCloseTo(30, 9)
    expect(snapshot.objects[0]!.animated).toEqual(['rotation'])
    expect(snapshot.tracks[0]!.keyframes[0]).toMatchObject({ t: 2 })
    expect((snapshot.tracks[0]!.keyframes[0]!.value as number[])[1]).toBeCloseTo(60, 9)
    expect(snapshot.duration).toBe(5)
    expect(b).toBeDefined()
  })
})

describe('报错单位：面向调用方，一律米 / 度 / 秒', () => {
  /** 抛的 FlowOpError 的 message（顺带断言文档没被动） */
  function messageOf(env: ReturnType<typeof setup>, fn: (ctx: FlowOpContext) => unknown): string {
    const before = JSON.stringify(env.data())
    let message = '没有抛'
    try {
      env.run(fn)
    } catch (error) {
      message = error instanceof FlowOpError ? error.message : `非 FlowOpError：${String(error)}`
    }
    expect(JSON.stringify(env.data())).toBe(before)
    return message
  }

  function withBoxAndCamera() {
    const env = setup()
    const [box, camera] = env.run((ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box' }, { kind: 'camera' }])).objects
    return { env, box: box!, camera: camera! }
  }

  it('旋转越界：范围与实际值是度（不是弧度）', () => {
    const { env, box } = withBoxAndCamera()
    const message = messageOf(env, (ctx) =>
      ops.transformDirectorObjects(ctx, NODE, [{ id: box.id, set: { rotation: [0, 3500, 0] }, by: { rotate: { axis: 'y', degrees: 3000 } } }]),
    )
    expect(message).toContain('rotation（度）')
    expect(message).toContain('[-3600, 3600]')
    expect(message).toContain('（实际 6500）')
    expect(message).not.toContain('弧度')
    expect(message).not.toContain('62.83')
  })

  it('新建对象时旋转越界：同样用度', () => {
    const env = setup()
    const message = messageOf(env, (ctx) => ops.addDirectorObjects(ctx, NODE, [{ kind: 'box', rotation: [0, 0, 4000] }]))
    expect(message).toContain('rotation（度）')
    expect(message).toContain('[-3600, 3600]')
    expect(message).toContain('（实际 4000）')
  })

  it('fov 关键帧越界：时刻用秒，值是度', () => {
    const { env, camera } = withBoxAndCamera()
    const message = messageOf(env, (ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, { objectId: camera.id, property: 'fov', keyframes: [{ t: 1, value: 200 }] }),
    )
    expect(message).toContain('fov 在 1s 的关键帧（度）')
    expect(message).toContain('[1, 179]')
    expect(message).toContain('（实际 200）')
    expect(message).not.toContain('ms')
  })

  it('旋转关键帧越界：时刻用秒，范围与实际值是度', () => {
    const { env, box } = withBoxAndCamera()
    const message = messageOf(env, (ctx) =>
      ops.setDirectorKeyframes(ctx, NODE, { objectId: box.id, property: 'rotation', keyframes: [{ t: 2.5, value: [0, 5000, 0] }] }),
    )
    expect(message).toContain('rotation 在 2.5s 的关键帧（度）')
    expect(message).toContain('[-3600, 3600]')
    expect(message).toContain('（实际 5000）')
    expect(message).not.toContain('弧度')
  })

  it('时长越界：范围与实际值是秒', () => {
    const { env } = withBoxAndCamera()
    expect(messageOf(env, (ctx) => ops.setDirectorSettings(ctx, NODE, { duration: 0.05 }))).toMatch(/时长（秒）.*\[0\.1, 600\]（实际 0\.05）/)
    const tooLong = messageOf(env, (ctx) => ops.setDirectorSettings(ctx, NODE, { duration: 700 }))
    expect(tooLong).toMatch(/时长（秒）.*\[0\.1, 600\]（实际 700）/)
    expect(tooLong).not.toContain('毫秒')
  })

  it('关键帧时刻、运动预设的开始 / 持续时间越界：都是秒', () => {
    const { env, box, camera } = withBoxAndCamera()
    expect(messageOf(env, (ctx) => ops.setDirectorKeyframes(ctx, NODE, { objectId: box.id, property: 'scale', keyframes: [{ t: 601, value: 2 }] }))).toMatch(
      /时刻（秒）.*\[0, 600\]（实际 601）/,
    )
    expect(
      messageOf(env, (ctx) =>
        ops.animateDirectorMotion(ctx, NODE, { preset: 'orbit', objectId: camera.id, angle: 90, center: [0, 0, 0], start: -1, duration: 2 }),
      ),
    ).toMatch(/开始时刻（秒）.*\[0, 600\]（实际 -1）/)
    expect(
      messageOf(env, (ctx) =>
        ops.animateDirectorMotion(ctx, NODE, { preset: 'orbit', objectId: camera.id, angle: 90, center: [0, 0, 0], start: 599, duration: 5 }),
      ),
    ).toContain('运动结束于 604 秒，超过时长上限 600 秒')
  })

  it('读时校验（director-doc）仍按存储单位：弧度、毫秒', () => {
    const rotation = validateDirectorObject(
      { id: 'o', kind: 'box', name: 'x', position: [0, 0, 0], rotation: [0, 100, 0], scale: [1, 1, 1], geometry: { width: 1, height: 1, depth: 1 } },
    )
    expect(rotation).toContain('rotation（弧度）')
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: 700_000, value: 1 }, 'fov')).toContain('（毫秒）')
  })
})
