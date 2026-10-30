import {
  aspectRatioOf,
  isDirectorShape,
  isVec3,
  trackPropertyAllowed,
  type DirectorKeyframeValue,
  type DirectorInterpolation,
  type DirectorObject,
  type DirectorObjectKind,
  type DirectorScene,
  type DirectorTrack,
  type DirectorTrackProperty,
  type Vec3,
} from './director-doc.ts'

/**
 * 导演台的求值与测量（docs/07 §7.3.2）—— **「人看到的那一帧」的唯一定义**：
 * 服务端的测量工具、前端的播放、渲染服务都从这里算某一时刻每个对象在哪、多大、机位里看到什么。
 *
 * 不依赖 three（shared 不碰 DOM、也不想为几个公式背一个大包），数学自己写，但**口径和 three 逐项一致**：
 * 欧拉角 XYZ → 四元数 / 矩阵、四元数球面插值、相机 `lookAt`（朝本地 -Z、up = +Y）都照 three 的实现抄。
 * 时间一律毫秒、角度一律弧度（存储单位，docs/07 §7.2）；面向模型的米 / 度 / 秒在 `director-ops.ts` 换。
 *
 * ## 插值
 *
 * - 一个对象的一个属性 = 一条轨道（同一对象同一属性有多条 —— 两个客户端同时建 —— 时，关键帧合并，
 *   插值方式取 id 最小的那条，结果确定）。没有轨道的属性取对象的静态值（`dc.obj.*` 里存的）。
 * - 关键帧按 `(t, id)` 排序；t 在首帧之前取首帧、在末帧之后取末帧（夹到首尾）。
 * - `linear` 线性；`step` 取前一帧，到下一帧的时刻才跳；`smooth` 每一段做 smoothstep 缓动（`u²(3−2u)`）。
 *   注意 `smooth` 和 three 的 `InterpolateSmooth`（三次样条）**不是一回事** —— 前端播放要按本模块逐帧求值，
 *   不能拿 three 的 `AnimationMixer` 自己插。
 * - 旋转按欧拉角存，插值时转成四元数做球面插值（最短弧）：跨 ±180° 不会反向绕一大圈。
 *   代价是**相邻两帧之间的转角必须小于 180°**（超过就走另一边的短弧）；运动预设生成的帧都守这一条。
 *
 * ## 测量
 *
 * - 世界包围盒（AABB）是**旋转、缩放后的几何体本身**的紧包围盒（按支撑函数算，不是把本地包围盒转一下再包一次）：
 *   立方体、球、圆锥、圆柱、平面都精确。距离、穿插、落地这些判断用的是 AABB，所以对旋转过的、非立方体的对象偏保守，
 *   结果里 `precision` 如实标出来。机位和灯光没有体积，按一个点。
 * - 机位取景按包围盒的 8 个角投影（被近裁剪面切到的边求交点），**不算遮挡**，结果里注明是近似。
 */

export type Quat = [number, number, number, number]
/** 3×3 矩阵，行主序：`[m11, m12, m13, m21, …, m33]` */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

// —— 向量 ——

export function vecAdd(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
export function vecSub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
export function vecScale(a: Readonly<Vec3>, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}
export function vecDot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
export function vecCross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
export function vecLength(a: Readonly<Vec3>): number {
  return Math.sqrt(vecDot(a, a))
}
export function vecNormalize(a: Readonly<Vec3>): Vec3 {
  const length = vecLength(a)
  return length > 0 ? vecScale(a, 1 / length) : [0, 0, 0]
}
export function vecLerp(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// —— 旋转（逐项照 three 的 Euler / Quaternion / Matrix4）——

/** 欧拉角 XYZ（弧度）→ 四元数 `[x, y, z, w]`（three `Quaternion.setFromEuler`，order XYZ） */
export function quatFromEuler(euler: Readonly<Vec3>): Quat {
  const c1 = Math.cos(euler[0] / 2)
  const c2 = Math.cos(euler[1] / 2)
  const c3 = Math.cos(euler[2] / 2)
  const s1 = Math.sin(euler[0] / 2)
  const s2 = Math.sin(euler[1] / 2)
  const s3 = Math.sin(euler[2] / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

/** 四元数 → 旋转矩阵（three `Matrix4.compose` 的旋转部分） */
export function mat3FromQuat(q: Readonly<Quat>): Mat3 {
  const [x, y, z, w] = q
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [1 - (yy + zz), xy - wz, xz + wy, xy + wz, 1 - (xx + zz), yz - wx, xz - wy, yz + wx, 1 - (xx + yy)]
}

/** 旋转矩阵 → 四元数（three `Quaternion.setFromRotationMatrix`） */
export function quatFromMat3(m: Readonly<Mat3>): Quat {
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m
  const trace = m11 + m22 + m33
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]
}

/** 旋转矩阵 → 欧拉角 XYZ（three `Euler.setFromRotationMatrix`，order XYZ） */
export function eulerFromMat3(m: Readonly<Mat3>): Vec3 {
  const [m11, m12, m13, , m22, m23, , m32, m33] = m
  const y = Math.asin(Math.min(1, Math.max(-1, m13)))
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), y, Math.atan2(-m12, m11)]
  return [Math.atan2(m32, m22), y, 0]
}

export function eulerFromQuat(q: Readonly<Quat>): Vec3 {
  return eulerFromMat3(mat3FromQuat(q))
}

export function mat3FromEuler(euler: Readonly<Vec3>): Mat3 {
  return mat3FromQuat(quatFromEuler(euler))
}

/** 四元数乘法 `a * b`（先转 b 再转 a） */
export function quatMultiply(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function quatFromAxisAngle(axis: Readonly<Vec3>, angle: number): Quat {
  const n = vecNormalize(axis)
  const s = Math.sin(angle / 2)
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)]
}

/** 球面插值，走最短弧（three `Quaternion.slerp`） */
export function quatSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  if (t <= 0) return [...a]
  if (t >= 1) return [...b]
  let [bx, by, bz, bw] = b
  let cosHalf = a[3] * bw + a[0] * bx + a[1] * by + a[2] * bz
  if (cosHalf < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cosHalf = -cosHalf
  }
  if (cosHalf >= 1) return [...a]
  const sqrSin = 1 - cosHalf * cosHalf
  if (sqrSin <= Number.EPSILON) {
    const s = 1 - t
    const q: Quat = [s * a[0] + t * bx, s * a[1] + t * by, s * a[2] + t * bz, s * a[3] + t * bw]
    const length = Math.hypot(...q)
    return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
  }
  const sinHalf = Math.sqrt(sqrSin)
  const halfTheta = Math.atan2(sinHalf, cosHalf)
  const ra = Math.sin((1 - t) * halfTheta) / sinHalf
  const rb = Math.sin(t * halfTheta) / sinHalf
  return [a[0] * ra + bx * rb, a[1] * ra + by * rb, a[2] * ra + bz * rb, a[3] * ra + bw * rb]
}

/** 矩阵乘向量 */
export function mat3Apply(m: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

/** 转置乘向量（旋转矩阵的逆） */
export function mat3ApplyTransposed(m: Readonly<Mat3>, v: Readonly<Vec3>): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ]
}

/**
 * 相机从 `eye` 看向 `target` 的朝向（three 相机的 `lookAt`：本地 -Z 指向目标、up = +Y；
 * 正上 / 正下看时的退化处理也照 three：把视线挪一点点）。返回旋转矩阵（列 = 相机的 x / y / z 轴）。
 */
export function cameraLookAt(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3> = [0, 1, 0]): Mat3 {
  let z = vecSub(eye, target)
  if (vecDot(z, z) === 0) z = [z[0], z[1], 1]
  z = vecNormalize(z)
  let x = vecCross(up, z)
  if (vecDot(x, x) === 0) {
    if (Math.abs(up[2]) === 1) z = [z[0] + 0.0001, z[1], z[2]]
    else z = [z[0], z[1], z[2] + 0.0001]
    z = vecNormalize(z)
    x = vecCross(up, z)
  }
  x = vecNormalize(x)
  const y = vecCross(z, x)
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]
}

export type DirectorAxis = 'x' | 'y' | 'z'
export type DirectorRotationSpace = 'world' | 'local'

const AXIS_VECTORS: Record<DirectorAxis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }

export function axisVector(axis: DirectorAxis): Vec3 {
  return [...AXIS_VECTORS[axis]]
}

/**
 * 在欧拉角 XYZ 上绕某个轴转 `angle` 弧度，返回新的欧拉角。
 *
 * R = Rx·Ry·Rz，所以能直接加到某一个分量上的情形就直接加（结果好读，也不丢圈数）：
 * 世界 X → 加 x；本地 Z → 加 z；世界 Y 且 x = 0、本地 Y 且 z = 0 → 加 y。
 * 其余情形按四元数复合（世界：q' = q轴·q；本地：q' = q·q轴）再拆回欧拉角。
 */
export function rotateEuler(
  euler: Readonly<Vec3>,
  axis: DirectorAxis,
  angle: number,
  space: DirectorRotationSpace = 'world',
): Vec3 {
  const [x, y, z] = euler
  if (space === 'world' && axis === 'x') return [x + angle, y, z]
  if (space === 'local' && axis === 'z') return [x, y, z + angle]
  if (axis === 'y' && ((space === 'world' && x === 0) || (space === 'local' && z === 0))) return [x, y + angle, z]
  const q = quatFromEuler(euler)
  const r = quatFromAxisAngle(AXIS_VECTORS[axis], angle)
  return eulerFromQuat(space === 'world' ? quatMultiply(r, q) : quatMultiply(q, r))
}

// —— 时间轴 ——

/** 缓动：`smooth` 段内的 smoothstep */
export function smoothstep(u: number): number {
  return u * u * (3 - 2 * u)
}

interface Channel {
  /** 插值方式取 id 最小的那条轨道 */
  interp: DirectorInterpolation
  /** 合并进来的轨道 id（升序；第一条就是规范轨道） */
  trackIds: string[]
  times: number[]
  values: DirectorKeyframeValue[]
  /** rotation 通道预先转好的四元数 */
  quats: Quat[]
}

/** 一个对象在某一时刻的状态（存储单位：米、弧度、度） */
export interface DirectorObjectState {
  id: string
  kind: DirectorObjectKind
  position: Vec3
  /** 欧拉角 XYZ，弧度 */
  rotation: Vec3
  quaternion: Quat
  scale: Vec3
  /** 机位的竖直视场角，度；别的种类没有 */
  fov?: number
}

/** 编译好的时间轴：关键帧按通道排好序，逐帧求值不用每次重排 */
export interface DirectorTimeline {
  scene: DirectorScene
  /** objectId → property → 通道 */
  channels: Map<string, Map<DirectorTrackProperty, Channel>>
  /** 最后一个关键帧的时刻（毫秒）；没有关键帧为 0 */
  lastKeyframe: number
}

function valueFits(property: DirectorTrackProperty, value: DirectorKeyframeValue): boolean {
  return property === 'fov' ? typeof value === 'number' : isVec3(value)
}

/**
 * 某个对象某个属性的**规范轨道**：id 最小的那条（同一对象同一属性有多条时，写入都落到它上面）。
 * 对象不存在、属性和种类对不上时也照样找（调用方自己判）。
 */
export function canonicalTrack(
  scene: DirectorScene,
  objectId: string,
  property: DirectorTrackProperty,
): DirectorTrack | null {
  let best: DirectorTrack | null = null
  for (const track of scene.tracks.values()) {
    if (track.objectId !== objectId || track.property !== property) continue
    if (!best || track.id < best.id) best = track
  }
  return best
}

/** 某个对象某个属性上的所有轨道（同属性多条时全返回，按 id 升序） */
export function tracksOf(scene: DirectorScene, objectId: string, property?: DirectorTrackProperty): DirectorTrack[] {
  return [...scene.tracks.values()]
    .filter((track) => track.objectId === objectId && (property === undefined || track.property === property))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 编译时间轴。忽略：指向不存在对象的轨道、属性和对象种类对不上的轨道（fov 打在非机位上）、
 * 指向不存在轨道的关键帧、值的形状和属性对不上的关键帧。
 */
export function compileDirectorTimeline(scene: DirectorScene): DirectorTimeline {
  const channels = new Map<string, Map<DirectorTrackProperty, Channel>>()
  const channelOfTrack = new Map<string, Channel>()
  const sortedTracks = [...scene.tracks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const track of sortedTracks) {
    const object = scene.objects.get(track.objectId)
    if (!object || !trackPropertyAllowed(object.kind, track.property)) continue
    let byProperty = channels.get(track.objectId)
    if (!byProperty) channels.set(track.objectId, (byProperty = new Map()))
    let channel = byProperty.get(track.property)
    if (!channel) {
      channel = { interp: track.interp, trackIds: [], times: [], values: [], quats: [] }
      byProperty.set(track.property, channel)
    }
    channel.trackIds.push(track.id)
    channelOfTrack.set(track.id, channel)
  }

  const pending = new Map<Channel, { t: number; id: string; value: DirectorKeyframeValue }[]>()
  for (const keyframe of scene.keyframes.values()) {
    const channel = channelOfTrack.get(keyframe.trackId)
    const track = scene.tracks.get(keyframe.trackId)
    if (!channel || !track || !valueFits(track.property, keyframe.value)) continue
    let list = pending.get(channel)
    if (!list) pending.set(channel, (list = []))
    list.push({ t: keyframe.t, id: keyframe.id, value: keyframe.value })
  }

  let lastKeyframe = 0
  for (const [objectId, byProperty] of channels) {
    for (const [property, channel] of byProperty) {
      const list = (pending.get(channel) ?? []).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      if (list.length === 0) {
        byProperty.delete(property)
        continue
      }
      for (const item of list) {
        channel.times.push(item.t)
        channel.values.push(item.value)
        if (property === 'rotation') channel.quats.push(quatFromEuler(item.value as Vec3))
        lastKeyframe = Math.max(lastKeyframe, item.t)
      }
    }
    if (byProperty.size === 0) channels.delete(objectId)
  }
  return { scene, channels, lastKeyframe }
}

/** 找段：最后一个 `times[i] <= t` 的 i（t 在首帧之前返回 -1） */
function segmentIndex(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] ?? Infinity) <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

interface Sample {
  index: number
  next: number
  /** 段内进度（已按插值方式缓动）；0 表示正好落在 index 那一帧 */
  u: number
}

function sampleChannel(channel: Channel, t: number): Sample {
  const last = channel.times.length - 1
  const index = segmentIndex(channel.times, t)
  if (index < 0) return { index: 0, next: 0, u: 0 }
  if (index >= last) return { index: last, next: last, u: 0 }
  const t0 = channel.times[index] ?? 0
  const t1 = channel.times[index + 1] ?? t0
  if (channel.interp === 'step' || t1 <= t0) return { index, next: index, u: 0 }
  const linear = (t - t0) / (t1 - t0)
  return { index, next: index + 1, u: channel.interp === 'smooth' ? smoothstep(linear) : linear }
}

function sampleVec3(channel: Channel, t: number): Vec3 {
  const { index, next, u } = sampleChannel(channel, t)
  const a = channel.values[index] as Vec3
  if (u === 0) return [a[0], a[1], a[2]]
  return vecLerp(a, channel.values[next] as Vec3, u)
}

function sampleNumber(channel: Channel, t: number): number {
  const { index, next, u } = sampleChannel(channel, t)
  const a = channel.values[index] as number
  if (u === 0) return a
  return a + ((channel.values[next] as number) - a) * u
}

function sampleRotation(channel: Channel, t: number): { rotation: Vec3; quaternion: Quat } {
  const { index, next, u } = sampleChannel(channel, t)
  const a = channel.values[index] as Vec3
  const qa = channel.quats[index] as Quat
  // 正好落在关键帧上：原样返回存的欧拉角（不经四元数绕一圈，免得 1e-16 的误差和圈数丢失）
  if (u === 0) return { rotation: [a[0], a[1], a[2]], quaternion: [...qa] }
  const quaternion = quatSlerp(qa, channel.quats[next] as Quat, u)
  return { rotation: eulerFromQuat(quaternion), quaternion }
}

/** 对象的静态状态（没有任何轨道时它就是每一时刻的状态） */
export function staticObjectState(object: DirectorObject): DirectorObjectState {
  return {
    id: object.id,
    kind: object.kind,
    position: [...object.position],
    rotation: [...object.rotation],
    quaternion: quatFromEuler(object.rotation),
    scale: [...object.scale],
    ...(object.kind === 'camera' ? { fov: object.camera.fov } : {}),
  }
}

/** 某个对象在时刻 t（毫秒）的状态；对象不存在返回 null */
export function objectStateAt(timeline: DirectorTimeline, objectId: string, t: number): DirectorObjectState | null {
  const object = timeline.scene.objects.get(objectId)
  if (!object) return null
  const state = staticObjectState(object)
  const byProperty = timeline.channels.get(objectId)
  if (!byProperty) return state
  const position = byProperty.get('position')
  if (position) state.position = sampleVec3(position, t)
  const scale = byProperty.get('scale')
  if (scale) state.scale = sampleVec3(scale, t)
  const rotation = byProperty.get('rotation')
  if (rotation) Object.assign(state, sampleRotation(rotation, t))
  const fov = byProperty.get('fov')
  if (fov && object.kind === 'camera') state.fov = sampleNumber(fov, t)
  return state
}

/** 所有对象在时刻 t（毫秒）的状态 */
export function sceneStateAt(timeline: DirectorTimeline, t: number): Map<string, DirectorObjectState> {
  const out = new Map<string, DirectorObjectState>()
  for (const id of timeline.scene.objects.keys()) {
    const state = objectStateAt(timeline, id, t)
    if (state) out.set(id, state)
  }
  return out
}

/** 这个对象哪些属性有关键帧（静态值在播放时会被轨道覆盖） */
export function animatedProperties(timeline: DirectorTimeline, objectId: string): DirectorTrackProperty[] {
  return [...(timeline.channels.get(objectId)?.keys() ?? [])]
}

// —— 包围盒 ——

/**
 * 包围盒的精度：
 * - `exact`：包围盒就是对象本身（没转过、或只转了 90° 整数倍的立方体 / 平面）；
 * - `bounding-box`：包围盒本身是紧的，但对象不是盒子（球、圆锥、圆柱、斜着放的立方体）——
 *   拿它算的间距、穿插偏保守；
 * - `point`：机位、灯光，没有体积。
 */
export type DirectorBoundsPrecision = 'exact' | 'bounding-box' | 'point'

export interface DirectorBounds {
  min: Vec3
  max: Vec3
  size: Vec3
  center: Vec3
  /** 底面高度 = min[1] */
  bottom: number
  precision: DirectorBoundsPrecision
}

function boundsFrom(min: Vec3, max: Vec3, precision: DirectorBoundsPrecision): DirectorBounds {
  return {
    min,
    max,
    size: vecSub(max, min),
    center: vecScale(vecAdd(min, max), 0.5),
    bottom: min[1],
    precision,
  }
}

/** 本地（未缩放）几何体在方向 v 上的支撑函数：max over 形体上的点 p 的 v·p */
function support(object: DirectorObject, v: Readonly<Vec3>): number {
  const radial = Math.hypot(v[0], v[2])
  switch (object.kind) {
    case 'box': {
      const g = object.geometry
      return (Math.abs(v[0]) * g.width + Math.abs(v[1]) * g.height + Math.abs(v[2]) * g.depth) / 2
    }
    case 'sphere':
      return object.geometry.radius * vecLength(v)
    case 'cylinder': {
      const g = object.geometry
      return (Math.abs(v[1]) * g.height) / 2 + g.radius * radial
    }
    case 'cone': {
      // 尖在 +h/2，底面圆在 -h/2（three ConeGeometry）
      const g = object.geometry
      const half = g.height / 2
      return Math.max(v[1] * half, -v[1] * half + g.radius * radial)
    }
    case 'plane': {
      const g = object.geometry
      return (Math.abs(v[0]) * g.width + Math.abs(v[2]) * g.depth) / 2
    }
    case 'camera':
    case 'light':
      return 0
  }
}

const AXIS_ALIGNED_EPSILON = 1e-9

function isAxisAligned(m: Readonly<Mat3>): boolean {
  return m.every((value) => Math.abs(value) < AXIS_ALIGNED_EPSILON || Math.abs(Math.abs(value) - 1) < AXIS_ALIGNED_EPSILON)
}

/**
 * 对象在某个状态下的世界包围盒。L = R·S 把本地形体映到世界；世界轴 i 上的最大值是
 * `position[i] + support(L 的第 i 行)`，最小值是 `position[i] - support(-第 i 行)` —— 对每种几何体都精确。
 */
export function objectBounds(object: DirectorObject, state: Pick<DirectorObjectState, 'position' | 'quaternion' | 'scale'>): DirectorBounds {
  const p = state.position
  if (!isDirectorShape(object)) return boundsFrom([...p], [...p], 'point')
  const r = mat3FromQuat(state.quaternion)
  const s = state.scale
  const min: Vec3 = [0, 0, 0]
  const max: Vec3 = [0, 0, 0]
  const rows: [Vec3, Vec3, Vec3] = [
    [r[0], r[1], r[2]],
    [r[3], r[4], r[5]],
    [r[6], r[7], r[8]],
  ]
  for (const i of [0, 1, 2] as const) {
    const row: Vec3 = [rows[i][0] * s[0], rows[i][1] * s[1], rows[i][2] * s[2]]
    max[i] = p[i] + support(object, row)
    min[i] = p[i] - support(object, vecScale(row, -1))
  }
  const boxLike = object.kind === 'box' || object.kind === 'plane'
  return boundsFrom(min, max, boxLike && isAxisAligned(r) ? 'exact' : 'bounding-box')
}

/** 一组包围盒的并 */
export function unionBounds(list: readonly DirectorBounds[]): DirectorBounds | null {
  const first = list[0]
  if (!first) return null
  const min: Vec3 = [...first.min]
  const max: Vec3 = [...first.max]
  let precision: DirectorBoundsPrecision = first.precision
  for (const item of list.slice(1)) {
    for (const i of [0, 1, 2] as const) {
      min[i] = Math.min(min[i], item.min[i])
      max[i] = Math.max(max[i], item.max[i])
    }
    if (item.precision !== precision) precision = 'bounding-box'
  }
  return boundsFrom(min, max, list.length > 1 ? 'bounding-box' : precision)
}

/** 包围盒的 8 个角 */
export function boundsCorners(bounds: DirectorBounds): Vec3[] {
  const out: Vec3[] = []
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) out.push([x, y, z])
    }
  }
  return out
}

export interface DirectorMeasurement {
  id: string
  name: string
  kind: DirectorObjectKind
  bounds: DirectorBounds
}

/** 若干对象在时刻 t（毫秒）的世界包围盒；`ids` 不给就是全部。不存在的 id 跳过 */
export function measureObjects(timeline: DirectorTimeline, t: number, ids?: Iterable<string>): DirectorMeasurement[] {
  const out: DirectorMeasurement[] = []
  for (const id of ids ?? timeline.scene.objects.keys()) {
    const object = timeline.scene.objects.get(id)
    const state = objectStateAt(timeline, id, t)
    if (!object || !state) continue
    out.push({ id, name: object.name, kind: object.kind, bounds: objectBounds(object, state) })
  }
  return out
}

export interface DirectorDistance {
  /** 两个包围盒中心之间的距离，米 */
  centerDistance: number
  /** 各轴间隙：正 = 这个轴上分开多远，负 = 这个轴上重叠多深 */
  gaps: Vec3
  /** 包围盒表面间距：分开时是最近两点的距离；三个轴都重叠时为负，绝对值 = 推开所需的最小距离 */
  surfaceDistance: number
  overlapping: boolean
}

export function boundsDistance(a: DirectorBounds, b: DirectorBounds): DirectorDistance {
  const gaps: Vec3 = [0, 0, 0]
  for (const i of [0, 1, 2] as const) gaps[i] = Math.max(a.min[i] - b.max[i], b.min[i] - a.max[i])
  const overlapping = gaps.every((gap) => gap < 0)
  const surfaceDistance = overlapping
    ? Math.max(...gaps)
    : Math.hypot(Math.max(gaps[0], 0), Math.max(gaps[1], 0), Math.max(gaps[2], 0))
  return { centerDistance: vecLength(vecSub(a.center, b.center)), gaps, surfaceDistance, overlapping }
}

// —— 机位取景 ——

/** 取景框里的矩形，取景框坐标 0–1：左上角是 (0, 0)，x 向右、y 向下 */
export interface DirectorFrameRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type DirectorFramingStatus =
  /** 整个在画面里 */
  | 'inside'
  /** 一部分在画面里（被画框或近裁剪面切掉了一部分） */
  | 'partial'
  /** 在机位前方，但在画面外 */
  | 'outside'
  /** 整个在机位背后（或比近裁剪面还近 / 比远裁剪面还远） */
  | 'behind'

export interface DirectorObjectFraming {
  id: string
  name: string
  kind: DirectorObjectKind
  status: DirectorFramingStatus
  /** 画面里能看到的那部分（投影矩形和取景框的交集）；看不到为 null */
  rect: DirectorFrameRect | null
  /** 投影矩形本身（可以超出 0–1）；整个在背后为 null */
  projected: DirectorFrameRect | null
  /** 占取景框面积的比例（0–1） */
  coverage: number
  /** 投影矩形有多大比例在画面里（0–1）；点状对象在画面里为 1 */
  visibleFraction: number
  /** 机位到包围盒中心的距离，米 */
  distance: number
}

export interface DirectorCameraView {
  cameraId: string
  /** 毫秒 */
  t: number
  /** 宽高比 */
  aspect: number
  /** 竖直视场角，度 */
  fov: number
  position: Vec3
  objects: DirectorObjectFraming[]
  /** 恒为 true：按包围盒投影、不算遮挡 */
  approximate: true
  note: string
}

export const CAMERA_VIEW_NOTE =
  '按世界包围盒的 8 个角投影估算，偏保守；不计遮挡（被挡住的对象也算「在画面里」）'

interface CameraFrame {
  position: Vec3
  rotation: Mat3
  tanV: number
  tanH: number
  near: number
  far: number
}

/** 投影一组世界坐标点（凸包的顶点），返回取景框坐标下的外接矩形与深度范围；全在背后返回 null */
function projectHull(frame: CameraFrame, points: readonly Vec3[]): { rect: DirectorFrameRect; clipped: boolean } | null {
  const local = points.map((p) => mat3ApplyTransposed(frame.rotation, vecSub(p, frame.position)))
  // 相机看 -Z：深度 = -z
  const front = (p: Vec3) => -p[2] >= frame.near
  const kept: Vec3[] = local.filter(front)
  const clipped = kept.length < local.length
  if (kept.length === 0) return null
  if (clipped && local.length === 8) {
    // 包围盒的 12 条棱（角的下标按 boundsCorners 的 x/y/z 二进制位排）：跨近裁剪面的棱取交点
    for (let a = 0; a < 8; a++) {
      for (const bit of [1, 2, 4]) {
        const b = a | bit
        if (b === a) continue
        const pa = local[a]!
        const pb = local[b]!
        if (front(pa) === front(pb)) continue
        const za = -pa[2] - frame.near
        const zb = -pb[2] - frame.near
        kept.push(vecLerp(pa, pb, za / (za - zb)))
      }
    }
  }
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const p of kept) {
    const depth = Math.max(-p[2], frame.near)
    const ndcX = p[0] / depth / frame.tanH
    const ndcY = p[1] / depth / frame.tanV
    const u = (ndcX + 1) / 2
    const v = (1 - ndcY) / 2
    left = Math.min(left, u)
    right = Math.max(right, u)
    top = Math.min(top, v)
    bottom = Math.max(bottom, v)
  }
  // 整个比远裁剪面还远：同样看不见
  if (local.every((p) => -p[2] > frame.far)) return null
  return { rect: { left, top, right, bottom }, clipped }
}

function rectArea(rect: DirectorFrameRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
}

function clampRect(rect: DirectorFrameRect): DirectorFrameRect | null {
  const out = {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(1, rect.right),
    bottom: Math.min(1, rect.bottom),
  }
  return out.left <= out.right && out.top <= out.bottom ? out : null
}

function cameraFrame(state: DirectorObjectState, camera: { fov: number; near: number; far: number }, aspect: number): CameraFrame {
  const tanV = Math.tan(((state.fov ?? camera.fov) * Math.PI) / 360)
  return {
    position: state.position,
    rotation: mat3FromQuat(state.quaternion),
    tanV,
    tanH: tanV * aspect,
    near: camera.near,
    far: camera.far,
  }
}

/**
 * 某个机位在时刻 t（毫秒）的取景：每个对象（除它自己）是否在画面里、在取景框里的矩形和占比。
 * 机位不存在、或不是机位返回 null。`aspect` 不给按场景的画幅（`auto` 按 16:9）。
 */
export function cameraView(
  timeline: DirectorTimeline,
  cameraId: string,
  t: number,
  options: { aspect?: number; objectIds?: Iterable<string> } = {},
): DirectorCameraView | null {
  const camera = timeline.scene.objects.get(cameraId)
  const state = objectStateAt(timeline, cameraId, t)
  if (!camera || camera.kind !== 'camera' || !state) return null
  const aspect = options.aspect ?? aspectRatioOf(timeline.scene.aspect)
  const frame = cameraFrame(state, camera.camera, aspect)
  const objects: DirectorObjectFraming[] = []
  for (const measurement of measureObjects(timeline, t, options.objectIds)) {
    if (measurement.id === cameraId) continue
    const { bounds } = measurement
    const points = bounds.precision === 'point' ? [bounds.center] : boundsCorners(bounds)
    const distance = vecLength(vecSub(bounds.center, frame.position))
    const projected = projectHull(frame, points)
    const base = { id: measurement.id, name: measurement.name, kind: measurement.kind, distance }
    if (!projected) {
      objects.push({ ...base, status: 'behind', rect: null, projected: null, coverage: 0, visibleFraction: 0 })
      continue
    }
    const rect = clampRect(projected.rect)
    const fullArea = rectArea(projected.rect)
    const visibleArea = rect ? rectArea(rect) : 0
    const fullyInside =
      !projected.clipped &&
      projected.rect.left >= 0 &&
      projected.rect.top >= 0 &&
      projected.rect.right <= 1 &&
      projected.rect.bottom <= 1
    const status: DirectorFramingStatus = !rect ? 'outside' : fullyInside ? 'inside' : 'partial'
    objects.push({
      ...base,
      status,
      rect,
      projected: projected.rect,
      coverage: visibleArea,
      visibleFraction: !rect ? 0 : fullArea > 0 ? visibleArea / fullArea : 1,
    })
  }
  return {
    cameraId,
    t,
    aspect,
    fov: state.fov ?? camera.camera.fov,
    position: [...state.position],
    objects,
    approximate: true,
    note: CAMERA_VIEW_NOTE,
  }
}

/**
 * 机位保持朝向 `rotation`、对准 `center` 时，要退到多远才能把这些点全装进画面（每边留 `margin`，
 * 取景框宽 / 高的比例，0–0.45）。按角点精确求：对每个点，相机坐标系下 |x| ≤ tanH·k·深度、|y| ≤ tanV·k·深度，
 * k = 1 − 2·margin。返回机位到 `center` 的距离（至少保证所有点在近裁剪面之前）。
 */
export function framingDistance(
  points: readonly Vec3[],
  center: Readonly<Vec3>,
  rotation: Readonly<Mat3>,
  camera: { fov: number; near: number },
  aspect: number,
  margin = 0,
): number {
  const k = 1 - 2 * margin
  const tanV = Math.tan((camera.fov * Math.PI) / 360) * k
  const tanH = tanV * aspect
  let distance = camera.near
  for (const p of points) {
    // 相机在 center + d·z轴（看 -Z）；点在相机坐标系里 = o − (0, 0, d)，深度 = d − o.z
    const o = mat3ApplyTransposed(rotation, vecSub(p, center))
    distance = Math.max(distance, o[2] + Math.abs(o[0]) / tanH, o[2] + Math.abs(o[1]) / tanV, o[2] + camera.near)
  }
  return distance
}

// —— 场景检查 ——

export interface DirectorCheckOptions {
  /** 检查哪些时刻（毫秒）；默认只查 0 */
  times?: readonly number[]
  /** 容差，米（默认 0.001）：重叠不超过它不算穿插，离地 / 离支撑面不超过它不算悬空 */
  tolerance?: number
  /** 查哪个机位的画面；默认当前机位（`dc.activeShot`），`null` 不查 */
  cameraId?: string | null
}

export interface DirectorIntersection {
  a: string
  b: string
  /** 重叠深度（推开所需的最小距离），米 */
  depth: number
}

export interface DirectorCheckSample {
  /** 毫秒 */
  t: number
  intersections: DirectorIntersection[]
  /** 底面低于地面的对象 */
  belowGround: { id: string; bottom: number }[]
  /** 底面离地、底下又没有别的对象托着的对象 */
  floating: { id: string; bottom: number }[]
  /** 不完全在机位画面里的对象（`partial` / `outside` / `behind`） */
  outOfFrame: { id: string; status: Exclude<DirectorFramingStatus, 'inside'> }[]
}

export interface DirectorCheckResult {
  cameraId: string | null
  tolerance: number
  samples: DirectorCheckSample[]
  notes: string[]
}

export const DEFAULT_CHECK_TOLERANCE = 0.001

/**
 * 场景检查：互相穿插、低于地面、悬空、超出机位画面。只看有几何体的对象（机位、灯光不参与）；
 * 全部按包围盒判断（结果里注明）。
 */
export function checkScene(timeline: DirectorTimeline, options: DirectorCheckOptions = {}): DirectorCheckResult {
  const tolerance = options.tolerance ?? DEFAULT_CHECK_TOLERANCE
  const times = options.times && options.times.length > 0 ? options.times : [0]
  const requested = options.cameraId === undefined ? timeline.scene.activeShot : options.cameraId
  const cameraId = requested && timeline.scene.objects.get(requested)?.kind === 'camera' ? requested : null
  const notes = ['穿插、悬空按世界包围盒判断：球、圆锥、圆柱和斜放的对象偏保守（可能多报穿插、少报悬空）']
  if (cameraId) notes.push(`画面检查：${CAMERA_VIEW_NOTE}`)
  else if (requested) notes.push(`机位 ${requested} 不存在，没有检查画面`)

  const samples = times.map((t): DirectorCheckSample => {
    const solids = measureObjects(timeline, t).filter((m) => m.bounds.precision !== 'point')
    const intersections: DirectorIntersection[] = []
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        const a = solids[i]!
        const b = solids[j]!
        const distance = boundsDistance(a.bounds, b.bounds)
        if (distance.gaps.every((gap) => gap < -tolerance)) {
          intersections.push({ a: a.id, b: b.id, depth: -distance.surfaceDistance })
        }
      }
    }
    const belowGround = solids
      .filter((m) => m.bounds.bottom < -tolerance)
      .map((m) => ({ id: m.id, bottom: m.bounds.bottom }))
    const floating = solids
      .filter((m) => {
        if (m.bounds.bottom <= tolerance) return false
        return !solids.some((other) => {
          if (other.id === m.id) return false
          const gaps = boundsDistance(m.bounds, other.bounds).gaps
          // 底面落在对方的高度范围里（含顶面，带容差），且水平投影有重叠
          return (
            gaps[0] < 0 &&
            gaps[2] < 0 &&
            m.bounds.bottom >= other.bounds.min[1] - tolerance &&
            m.bounds.bottom <= other.bounds.max[1] + tolerance
          )
        })
      })
      .map((m) => ({ id: m.id, bottom: m.bounds.bottom }))
    const outOfFrame: DirectorCheckSample['outOfFrame'] = []
    if (cameraId) {
      const view = cameraView(timeline, cameraId, t, { objectIds: solids.map((m) => m.id) })
      for (const framing of view?.objects ?? []) {
        if (framing.status !== 'inside') outOfFrame.push({ id: framing.id, status: framing.status })
      }
    }
    return { t, intersections, belowGround, floating, outOfFrame }
  })
  return { cameraId, tolerance, samples, notes }
}
