import { describe, expect, it } from 'vitest'
import {
  aspectRatioOf,
  DEFAULT_DIRECTOR_DURATION_MS,
  DEFAULT_DIRECTOR_FPS,
  degToRad,
  directorElementCounts,
  encodeDirectorObject,
  msToSeconds,
  parseDirectorObject,
  radToDeg,
  readDirectorScene,
  secondsToMs,
  serializedBytes,
  validateDirectorKeyframe,
  validateDirectorObject,
  validateDirectorTrack,
  type DirectorObject,
} from '../src/director-doc.ts'

/**
 * 导演台的数据契约：读时宽松（别的客户端写的东西读不懂就跳过，从不抛），写入严格（不可信输入按范围拒）。
 */

function box(extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'box',
    name: '桌子',
    position: [0, 0.4, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    geometry: { width: 1.2, height: 0.8, depth: 0.6 },
    ...extra,
  }
}

describe('读场景：读不懂的元素跳过，不抛', () => {
  it('好的元素照读，坏的记进 skipped，未知 / 预留的种类也跳过', () => {
    const scene = readDirectorScene({
      label: '不是导演台的字段',
      'dc.obj.a': box(),
      'dc.obj.nan': box({ position: [0, Number.NaN, 0] }),
      'dc.obj.short': box({ position: [0, 1] }),
      'dc.obj.model': { kind: 'model', name: '人', assetUrl: 'x.glb' },
      'dc.obj.alien': { kind: 'teapot' },
      'dc.obj.badgeo': box({ geometry: { width: -1 } }),
      'dc.obj.str': '整块字符串',
      'dc.track.t1': { objectId: 'a', property: 'position', interp: 'linear' },
      'dc.track.t2': { objectId: 'a', property: 'color', interp: 'linear' },
      'dc.kf.k1': { trackId: 't1', t: 1000, value: [0, 1, 0] },
      'dc.kf.k2': { trackId: 't1', t: -5, value: [0, 1, 0] },
      'dc.kf.k3': { trackId: 't1', t: 10, value: 'abc' },
    })

    expect([...scene.objects.keys()]).toEqual(['a'])
    expect([...scene.tracks.keys()]).toEqual(['t1'])
    expect([...scene.keyframes.keys()]).toEqual(['k1'])
    expect(scene.skipped.sort()).toEqual(
      [
        'dc.obj.nan',
        'dc.obj.short',
        'dc.obj.model',
        'dc.obj.alien',
        'dc.obj.badgeo',
        'dc.obj.str',
        'dc.track.t2',
        'dc.kf.k2',
        'dc.kf.k3',
      ].sort(),
    )
  })

  it('缺了的可选部分补默认值：旋转、缩放、几何尺寸、机位参数', () => {
    const scene = readDirectorScene({
      'dc.obj.s': { kind: 'sphere', name: '球', position: [1, 2, 3] },
      'dc.obj.c': { kind: 'camera', name: '机位1', position: [0, 1.6, 6], camera: { fov: 35 } },
    })
    const sphere = scene.objects.get('s')!
    expect(sphere.rotation).toEqual([0, 0, 0])
    expect(sphere.scale).toEqual([1, 1, 1])
    expect(sphere.kind === 'sphere' && sphere.geometry).toEqual({ radius: 0.5 })
    const camera = scene.objects.get('c')!
    expect(camera.kind === 'camera' && camera.camera).toEqual({ fov: 35, near: 0.1, far: 2000 })
  })

  it('标量键缺失或坏了用默认值：时长 5000ms、30fps、16:9', () => {
    expect(readDirectorScene({})).toMatchObject({
      duration: DEFAULT_DIRECTOR_DURATION_MS,
      fps: DEFAULT_DIRECTOR_FPS,
      aspect: '16:9',
      activeShot: null,
    })
    expect(readDirectorScene({ 'dc.duration': 'long', 'dc.fps': -1, 'dc.aspect': '2:1' })).toMatchObject({
      duration: 5000,
      fps: 30,
      aspect: '16:9',
    })
    expect(readDirectorScene({ 'dc.duration': 8000, 'dc.aspect': '9:16', 'dc.activeShot': 'cam' })).toMatchObject({
      duration: 8000,
      aspect: '9:16',
      activeShot: 'cam',
    })
  })

  it('id 只在键上：键里带点也原样取回', () => {
    const scene = readDirectorScene({ 'dc.obj.obj_1.v2': box() })
    expect(scene.objects.get('obj_1.v2')?.id).toBe('obj_1.v2')
    expect(encodeDirectorObject(scene.objects.get('obj_1.v2')!)).not.toHaveProperty('id')
  })

  it('上限按键数算，读不懂的元素也占名额', () => {
    expect(directorElementCounts({ 'dc.obj.a': box(), 'dc.obj.b': 'bad', 'dc.kf.x': {}, 'dc.duration': 1 })).toEqual({
      objects: 2,
      tracks: 0,
      keyframes: 1,
    })
  })
})

describe('写入校验：不可信输入按范围拒', () => {
  const good = parseDirectorObject('a', box()) as DirectorObject

  it('合法对象通过', () => {
    expect(validateDirectorObject(good)).toBeNull()
  })

  it.each([
    ['NaN 坐标', { position: [0, Number.NaN, 0] }],
    ['超范围坐标', { position: [5000, 0, 0] }],
    ['缩放为 0', { scale: [1, 0, 1] }],
    ['负缩放', { scale: [-1, 1, 1] }],
    ['空名字', { name: '  ' }],
    ['嵌套', { parentId: 'b' }],
  ])('拒绝：%s', (_, patch) => {
    expect(validateDirectorObject({ ...good, ...patch } as DirectorObject)).toMatch(/.+/)
  })

  it('拒绝未知种类、几何参数名和种类对不上、超范围尺寸', () => {
    expect(validateDirectorObject({ ...good, kind: 'teapot' } as unknown as DirectorObject)).toMatch(/种类/)
    expect(validateDirectorObject({ ...good, geometry: { radius: 1 } } as unknown as DirectorObject)).toMatch(/radius/)
    expect(validateDirectorObject({ ...good, geometry: { width: 1, height: 2000, depth: 1 } } as DirectorObject)).toMatch(
      /height/,
    )
  })

  it('机位的 fov 要在 (1, 179) 度、far 大于 near', () => {
    const camera = parseDirectorObject('c', { kind: 'camera', name: '机位' }) as DirectorObject
    expect(validateDirectorObject(camera)).toBeNull()
    expect(validateDirectorObject({ ...camera, camera: { fov: 190, near: 0.1, far: 10 } } as DirectorObject)).toMatch(/fov/)
    expect(validateDirectorObject({ ...camera, camera: { fov: 50, near: 5, far: 1 } } as DirectorObject)).toMatch(/far/)
  })

  it('fov 轨道只能打在机位上；关键帧时间是非负整数毫秒、值和属性同形', () => {
    const track = { id: 't', objectId: 'a', property: 'fov' as const, interp: 'linear' as const }
    expect(validateDirectorTrack(track, 'box')).toMatch(/机位/)
    expect(validateDirectorTrack(track, 'camera')).toBeNull()
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: 10.5, value: [0, 0, 0] }, 'position')).toMatch(/整数/)
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: -1, value: [0, 0, 0] }, 'position')).toMatch(/范围/)
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: 0, value: 40 }, 'position')).toMatch(/三个数/)
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: 0, value: [0, 0, 0] }, 'fov')).toMatch(/有限数/)
    expect(validateDirectorKeyframe({ id: 'k', trackId: 't', t: 0, value: 40 }, 'fov')).toBeNull()
  })
})

describe('单位与体积', () => {
  it('度↔弧度、秒↔毫秒（毫秒取整）', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 12)
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 12)
    expect(secondsToMs(1.2345)).toBe(1235)
    expect(msToSeconds(2500)).toBe(2.5)
  })

  it('画幅换宽高比，auto 按 16:9', () => {
    expect(aspectRatioOf('4:3')).toBeCloseTo(4 / 3, 12)
    expect(aspectRatioOf('auto')).toBeCloseTo(16 / 9, 12)
  })

  it('序列化体积按 UTF-8 字节算（中文 3 字节）', () => {
    expect(serializedBytes({ a: 'x' })).toBe(1 + 3)
    expect(serializedBytes({ k: '桌' })).toBe(1 + 5)
  })
})
