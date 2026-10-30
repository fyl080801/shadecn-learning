import { describe, expect, it } from 'vitest'
import { readDirectorScene, type Vec3 } from '../src/director-doc.ts'
import {
  boundsDistance,
  cameraLookAt,
  cameraView,
  checkScene,
  compileDirectorTimeline,
  eulerFromMat3,
  eulerFromQuat,
  mat3Apply,
  mat3FromEuler,
  measureObjects,
  objectStateAt,
  quatFromEuler,
  quatSlerp,
  rotateEuler,
  type DirectorBounds,
} from '../src/director-eval.ts'

/**
 * 求值与测量：插值（含旋转跨 180°）、包围盒精度、间距、机位取景、场景检查。
 * 这里算出来的就是前端播放时那一帧的定义，所以数要对到小数点后很多位。
 */

const deg = (d: number) => (d * Math.PI) / 180

function timeline(data: Record<string, unknown>) {
  return compileDirectorTimeline(readDirectorScene(data))
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 9) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits))
}

function boundsOf(data: Record<string, unknown>, id: string, t = 0): DirectorBounds {
  return measureObjects(timeline(data), t, [id])[0]!.bounds
}

describe('旋转数学（口径同 three）', () => {
  it('欧拉角 XYZ → 矩阵 → 欧拉角是恒等的', () => {
    const euler: Vec3 = [0.3, -0.7, 1.1]
    expectVec(eulerFromMat3(mat3FromEuler(euler)), euler, 12)
    expectVec(eulerFromQuat(quatFromEuler(euler)), euler, 12)
  })

  it('XYZ 顺序：R = Rx·Ry·Rz（先绕 Z、再 Y、再 X 作用在向量上）', () => {
    // 绕 Z 90° 把 +X 转到 +Y，再绕 X 90° 把 +Y 转到 +Z
    expectVec(mat3Apply(mat3FromEuler([deg(90), 0, deg(90)]), [1, 0, 0]), [0, 0, 1], 12)
  })

  it('相机 lookAt：本地 -Z 指向目标、up 朝 +Y', () => {
    const m = cameraLookAt([0, 0, 5], [0, 0, 0])
    expectVec(mat3Apply(m, [0, 0, -1]), [0, 0, -1], 12)
    const side = cameraLookAt([5, 0, 0], [0, 0, 0])
    expectVec(mat3Apply(side, [0, 0, -1]), [-1, 0, 0], 12)
    expectVec(mat3Apply(side, [0, 1, 0]), [0, 1, 0], 12)
  })

  it('绕轴旋转：能直接加到分量上的就直接加（不丢圈数）', () => {
    expectVec(rotateEuler([0, deg(170), 0], 'y', deg(30)), [0, deg(200), 0], 12)
    // 一般情形走四元数复合，结果和「先原旋转、再绕世界 Y」一致
    const start: Vec3 = [deg(30), deg(20), deg(10)]
    const turned = rotateEuler(start, 'y', deg(45), 'world')
    const v: Vec3 = [0.2, 0.5, 0.9]
    const expected = mat3Apply(mat3FromEuler([0, deg(45), 0]), mat3Apply(mat3FromEuler(start), v))
    expectVec(mat3Apply(mat3FromEuler(turned), v), expected, 12)
  })

  it('球面插值走最短弧', () => {
    const a = quatFromEuler([0, deg(170), 0])
    const b = quatFromEuler([0, deg(-170), 0])
    const mid = quatSlerp(a, b, 0.5)
    // 中点是 180°（从 170° 往大的方向走 10°），不是 0°
    expectVec(mat3Apply(mat3FromEuler(eulerFromQuat(mid)), [0, 0, 1]), [0, 0, -1], 9)
  })
})

describe('关键帧插值', () => {
  const base = {
    'dc.obj.a': { kind: 'box', name: 'a', position: [9, 9, 9] },
    'dc.track.p': { objectId: 'a', property: 'position', interp: 'linear' },
    'dc.kf.k0': { trackId: 'p', t: 1000, value: [0, 0, 0] },
    'dc.kf.k1': { trackId: 'p', t: 3000, value: [10, 0, -4] },
  }

  it('linear：段内线性', () => {
    expectVec(objectStateAt(timeline(base), 'a', 2000)!.position, [5, 0, -2])
    expectVec(objectStateAt(timeline(base), 'a', 2500)!.position, [7.5, 0, -3])
  })

  it('t 超出范围夹到首尾帧', () => {
    expectVec(objectStateAt(timeline(base), 'a', 0)!.position, [0, 0, 0])
    expectVec(objectStateAt(timeline(base), 'a', 99_999)!.position, [10, 0, -4])
  })

  it('step：到下一帧的时刻才跳', () => {
    const data = { ...base, 'dc.track.p': { objectId: 'a', property: 'position', interp: 'step' } }
    expectVec(objectStateAt(timeline(data), 'a', 2999)!.position, [0, 0, 0])
    expectVec(objectStateAt(timeline(data), 'a', 3000)!.position, [10, 0, -4])
  })

  it('smooth：段内 smoothstep（中点不变、四分之一处慢于线性）', () => {
    const data = { ...base, 'dc.track.p': { objectId: 'a', property: 'position', interp: 'smooth' } }
    expectVec(objectStateAt(timeline(data), 'a', 2000)!.position, [5, 0, -2])
    // u = 0.25 → 0.25²·(3 − 0.5) = 0.15625
    expectVec(objectStateAt(timeline(data), 'a', 1500)!.position, [1.5625, 0, -0.625])
  })

  it('没有轨道的属性取静态值', () => {
    const state = objectStateAt(timeline(base), 'a', 2000)!
    expectVec(state.rotation, [0, 0, 0])
    expectVec(state.scale, [1, 1, 1])
  })

  it('旋转跨 180° 不翻转：170° → -170° 的中点是 180°，不是倒着转回 0°', () => {
    const data = {
      'dc.obj.a': { kind: 'box', name: 'a' },
      'dc.track.r': { objectId: 'a', property: 'rotation', interp: 'linear' },
      'dc.kf.k0': { trackId: 'r', t: 0, value: [0, deg(170), 0] },
      'dc.kf.k1': { trackId: 'r', t: 1000, value: [0, deg(-170), 0] },
    }
    const tl = timeline(data)
    // 本地 +Z 在世界里的朝向：yaw θ 时是 (sin θ, 0, cos θ)
    for (const [t, yaw] of [
      [250, 175],
      [500, 180],
      [750, 185],
    ] as const) {
      const m = mat3FromEuler(objectStateAt(tl, 'a', t)!.rotation)
      expectVec(mat3Apply(m, [0, 0, 1]), [Math.sin(deg(yaw)), 0, Math.cos(deg(yaw))], 9)
    }
  })

  it('正好落在关键帧上时原样返回存的欧拉角（不丢圈数）', () => {
    const data = {
      'dc.obj.a': { kind: 'box', name: 'a' },
      'dc.track.r': { objectId: 'a', property: 'rotation', interp: 'linear' },
      'dc.kf.k0': { trackId: 'r', t: 0, value: [0, 0, 0] },
      'dc.kf.k1': { trackId: 'r', t: 1000, value: [0, deg(90), 0] },
      'dc.kf.k2': { trackId: 'r', t: 2000, value: [0, deg(450), 0] },
    }
    expect(objectStateAt(timeline(data), 'a', 2000)!.rotation).toEqual([0, deg(450), 0])
  })

  it('同一对象同一属性有两条轨道（并发建出来的）：关键帧合并，结果确定', () => {
    const data = {
      ...base,
      'dc.track.q': { objectId: 'a', property: 'position', interp: 'step' },
      'dc.kf.k2': { trackId: 'q', t: 2000, value: [0, 8, 0] },
    }
    // 插值取 id 最小的轨道（p：linear），k2 一起参与
    expectVec(objectStateAt(timeline(data), 'a', 1500)!.position, [0, 4, 0])
  })

  it('悬空的轨道 / 关键帧和对不上的值被忽略', () => {
    const data = {
      ...base,
      'dc.track.ghost': { objectId: 'gone', property: 'position', interp: 'linear' },
      'dc.kf.g': { trackId: 'ghost', t: 0, value: [1, 1, 1] },
      'dc.kf.bad': { trackId: 'p', t: 2000, value: 3 },
      'dc.track.fov': { objectId: 'a', property: 'fov', interp: 'linear' },
      'dc.kf.f': { trackId: 'fov', t: 0, value: 30 },
    }
    const state = objectStateAt(timeline(data), 'a', 2000)!
    expectVec(state.position, [5, 0, -2])
    expect(state.fov).toBeUndefined()
  })
})

describe('世界包围盒', () => {
  it('立方体：没转是精确值', () => {
    const b = boundsOf({ 'dc.obj.a': { kind: 'box', name: 'a', position: [1, 0.4, 0], geometry: { width: 1.2, height: 0.8, depth: 0.6 } } }, 'a')
    expectVec(b.min, [0.4, 0, -0.3], 12)
    expectVec(b.max, [1.6, 0.8, 0.3], 12)
    expect(b.bottom).toBeCloseTo(0, 12)
    expect(b.precision).toBe('exact')
  })

  it('立方体绕 Y 转 45°：包围盒是转后的紧包围盒', () => {
    const b = boundsOf({ 'dc.obj.a': { kind: 'box', name: 'a', rotation: [0, deg(45), 0] } }, 'a')
    const half = Math.SQRT2 / 2
    expectVec(b.min, [-half, -0.5, -half], 12)
    expectVec(b.max, [half, 0.5, half], 12)
    expect(b.precision).toBe('bounding-box')
  })

  it('缩放后的球（椭球）、圆锥（尖在 +Y）、圆柱倒放、水平平面', () => {
    const data = {
      'dc.obj.s': { kind: 'sphere', name: 's', scale: [2, 1, 1], geometry: { radius: 1 } },
      'dc.obj.c': { kind: 'cone', name: 'c', geometry: { radius: 0.5, height: 2 } },
      'dc.obj.y': { kind: 'cylinder', name: 'y', rotation: [0, 0, deg(90)], geometry: { radius: 0.5, height: 2 } },
      'dc.obj.p': { kind: 'plane', name: 'p', geometry: { width: 4, depth: 2 } },
    }
    const s = boundsOf(data, 's')
    expectVec(s.size, [4, 2, 2], 12)
    const c = boundsOf(data, 'c')
    expectVec(c.min, [-0.5, -1, -0.5], 12)
    expectVec(c.max, [0.5, 1, 0.5], 12)
    const y = boundsOf(data, 'y')
    expectVec(y.size, [2, 1, 1], 12)
    const p = boundsOf(data, 'p')
    expectVec(p.size, [4, 0, 2], 12)
  })

  it('倒过来的圆锥（绕 X 转 180°）：包围盒不变，尖朝下', () => {
    const b = boundsOf({ 'dc.obj.c': { kind: 'cone', name: 'c', rotation: [Math.PI, 0, 0], geometry: { radius: 0.5, height: 2 } } }, 'c')
    expectVec(b.min, [-0.5, -1, -0.5], 9)
    expectVec(b.max, [0.5, 1, 0.5], 9)
  })

  it('斜着的圆锥：精确按尖和底面圆算，不是本地盒子转一下', () => {
    // 绕 Z 转 90°：尖指向 -X，底面圆在 x = +h/2 处、半径铺在 Y / Z 上
    const b = boundsOf({ 'dc.obj.c': { kind: 'cone', name: 'c', rotation: [0, 0, deg(90)], geometry: { radius: 0.5, height: 2 } } }, 'c')
    expectVec(b.min, [-1, -0.5, -0.5], 9)
    expectVec(b.max, [1, 0.5, 0.5], 9)
  })

  it('机位和灯光按点算', () => {
    const b = boundsOf({ 'dc.obj.l': { kind: 'light', name: 'l', position: [1, 2, 3] } }, 'l')
    expect(b.precision).toBe('point')
    expectVec(b.size, [0, 0, 0])
  })
})

describe('间距', () => {
  const a: DirectorBounds = { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5], bottom: 0, precision: 'exact' }
  const shift = (dx: number, dy = 0): DirectorBounds => ({
    min: [dx, dy, 0],
    max: [1 + dx, 1 + dy, 1],
    size: [1, 1, 1],
    center: [0.5 + dx, 0.5 + dy, 0.5],
    bottom: dy,
    precision: 'exact',
  })

  it('分开时：各轴间隙与表面间距为正', () => {
    const d = boundsDistance(a, shift(3))
    expect(d.centerDistance).toBeCloseTo(3, 12)
    expectVec(d.gaps, [2, -1, -1])
    expect(d.surfaceDistance).toBeCloseTo(2, 12)
    expect(d.overlapping).toBe(false)
  })

  it('斜着分开时取最近两点距离', () => {
    expect(boundsDistance(a, shift(4, 5)).surfaceDistance).toBeCloseTo(5, 12)
  })

  it('重叠时表面间距为负，绝对值 = 推开所需的最小距离', () => {
    const d = boundsDistance(a, shift(0.7))
    expect(d.overlapping).toBe(true)
    expect(d.surfaceDistance).toBeCloseTo(-0.3, 12)
  })
})

describe('机位取景', () => {
  const scene = {
    'dc.aspect': '1:1',
    // fov 90°、1:1：画面正好是 |x| ≤ 深度、|y| ≤ 深度
    'dc.obj.cam': { kind: 'camera', name: '机位', position: [0, 0, 10], camera: { fov: 90, near: 0.1, far: 100 } },
    'dc.obj.mid': { kind: 'box', name: '正中', position: [0, 0, 0], geometry: { width: 2, height: 2, depth: 2 } },
    'dc.obj.edge': { kind: 'box', name: '压边', position: [10, 0, 0], geometry: { width: 2, height: 2, depth: 2 } },
    'dc.obj.far': { kind: 'box', name: '画外', position: [40, 0, 0], geometry: { width: 2, height: 2, depth: 2 } },
    'dc.obj.back': { kind: 'box', name: '背后', position: [0, 0, 20], geometry: { width: 2, height: 2, depth: 2 } },
  }

  it('每个对象的状态、取景框矩形（0–1）和占比；注明是近似', () => {
    const view = cameraView(timeline(scene), 'cam', 0)!
    const byId = Object.fromEntries(view.objects.map((o) => [o.id, o]))
    expect(view.approximate).toBe(true)
    expect(view.note).toMatch(/遮挡/)
    expect(view.objects.map((o) => o.id)).not.toContain('cam')

    // 正中的 2m 立方体：最近的面在深度 9，|x| ≤ 1 → ndc ±1/9
    const mid = byId.mid!
    expect(mid.status).toBe('inside')
    expect(mid.rect!.left).toBeCloseTo(0.5 - 1 / 18, 9)
    expect(mid.rect!.right).toBeCloseTo(0.5 + 1 / 18, 9)
    expect(mid.rect!.top).toBeCloseTo(0.5 - 1 / 18, 9)
    expect(mid.coverage).toBeCloseTo((1 / 9) ** 2, 9)
    expect(mid.visibleFraction).toBe(1)

    expect(byId.edge!.status).toBe('partial')
    expect(byId.edge!.visibleFraction).toBeGreaterThan(0)
    expect(byId.edge!.visibleFraction).toBeLessThan(1)
    expect(byId.far!.status).toBe('outside')
    expect(byId.back!.status).toBe('behind')
  })

  it('跨过近裁剪面的对象按棱的交点投影，不会因为背后的角翻到画面另一边', () => {
    const data = {
      ...scene,
      'dc.obj.cross': { kind: 'box', name: '穿过机位', position: [0, 0, 10], geometry: { width: 1, height: 1, depth: 4 } },
    }
    const cross = cameraView(timeline(data), 'cam', 0)!.objects.find((o) => o.id === 'cross')!
    expect(cross.status).toBe('partial')
    expect(cross.rect).toEqual({ left: 0, top: 0, right: 1, bottom: 1 })
  })

  it('不是机位返回 null', () => {
    expect(cameraView(timeline(scene), 'mid', 0)).toBeNull()
  })
})

describe('场景检查', () => {
  const table = { kind: 'box', name: '桌', position: [0, 0.4, 0], geometry: { width: 1.2, height: 0.8, depth: 0.6 } }

  it('穿插、低于地面、悬空；刚好贴着不算穿插、放在别的对象上不算悬空', () => {
    const result = checkScene(
      timeline({
        'dc.obj.table': table,
        'dc.obj.cup': { kind: 'box', name: '杯', position: [0, 0.85, 0], geometry: { width: 0.1, height: 0.1, depth: 0.1 } },
        'dc.obj.sunk': { kind: 'box', name: '陷进去', position: [0.5, 0.75, 0], geometry: { width: 0.2, height: 0.2, depth: 0.2 } },
        'dc.obj.under': { kind: 'sphere', name: '埋了', position: [5, 0.2, 0], geometry: { radius: 0.5 } },
        'dc.obj.fly': { kind: 'box', name: '飞着', position: [-5, 3, 0] },
        'dc.obj.cam': { kind: 'camera', name: '机位', position: [0, 10, 0] },
      }),
      { cameraId: null },
    )
    const [sample] = result.samples
    expect(sample!.intersections).toEqual([{ a: 'table', b: 'sunk', depth: expect.closeTo(0.15, 9) }])
    expect(sample!.belowGround.map((x) => x.id)).toEqual(['under'])
    expect(sample!.floating.map((x) => x.id)).toEqual(['fly'])
    expect(result.notes[0]).toMatch(/包围盒/)
  })

  it('按若干采样时刻查，用的是插值后的状态', () => {
    const result = checkScene(
      timeline({
        'dc.obj.table': table,
        'dc.obj.ball': { kind: 'sphere', name: '球', geometry: { radius: 0.1 } },
        'dc.track.p': { objectId: 'ball', property: 'position', interp: 'linear' },
        'dc.kf.a': { trackId: 'p', t: 0, value: [3, 0.1, 0] },
        'dc.kf.b': { trackId: 'p', t: 1000, value: [0, 0.4, 0] },
      }),
      { times: [0, 1000], cameraId: null },
    )
    expect(result.samples.map((s) => s.intersections.length)).toEqual([0, 1])
  })

  it('默认查当前机位的画面', () => {
    const result = checkScene(
      timeline({
        'dc.activeShot': 'cam',
        'dc.obj.cam': { kind: 'camera', name: '机位', position: [0, 1, 10] },
        'dc.obj.a': { kind: 'box', name: 'a', position: [0, 0.5, 0] },
        'dc.obj.b': { kind: 'box', name: 'b', position: [0, 0.5, 30] },
      }),
    )
    expect(result.cameraId).toBe('cam')
    expect(result.samples[0]!.outOfFrame).toEqual([{ id: 'b', status: 'behind' }])
  })
})
