import { nodeGroupMap } from './flow-doc.ts'
import { FlowOpError, requireNodeMap, writeNodeFields, type FlowOpContext } from './flow-ops-core.ts'
import {
  aspectRatioOf,
  DC_ACTIVE_SHOT_KEY,
  DC_ASPECT_KEY,
  DC_DURATION_KEY,
  DC_FPS_KEY,
  DC_KEYFRAME_ID_PREFIX,
  DC_KEYFRAME_PREFIX,
  DC_OBJECT_ID_PREFIX,
  DC_OBJECT_PREFIX,
  DC_TRACK_ID_PREFIX,
  DC_TRACK_PREFIX,
  DEFAULT_DIRECTOR_CAMERA,
  DEFAULT_DIRECTOR_LIGHT,
  defaultGeometry,
  degToRad,
  DIRECTOR_ASPECTS,
  DIRECTOR_INTERPOLATIONS,
  DIRECTOR_KIND_LABELS,
  DIRECTOR_LIGHT_TYPES,
  DIRECTOR_LIMITS,
  DIRECTOR_NODE_TYPE,
  DIRECTOR_OBJECT_KINDS,
  DIRECTOR_TRACK_PROPERTIES,
  directorElementCounts,
  directorKeyframeKey,
  directorObjectKey,
  directorTrackKey,
  encodeDirectorKeyframe,
  encodeDirectorObject,
  encodeDirectorTrack,
  GEOMETRY_FIELDS,
  isDirectorAspect,
  isDirectorShape,
  msToSeconds,
  radToDeg,
  readDirectorScene,
  secondsToMs,
  serializedBytes,
  trackPropertyAllowed,
  validateDirectorDuration,
  validateDirectorFps,
  validateDirectorKeyframe,
  validateDirectorObject,
  validateDirectorTrack,
  vec3RadToDeg,
  type DirectorAspect,
  type DirectorCamera,
  type DirectorInterpolation,
  type DirectorKeyframe,
  type DirectorKeyframeValue,
  type DirectorLight,
  type DirectorMaterial,
  type DirectorObject,
  type DirectorObjectKind,
  type DirectorScene,
  type DirectorTrack,
  type DirectorTrackProperty,
  type Vec3,
} from './director-doc.ts'
import {
  animatedProperties,
  boundsCorners,
  cameraLookAt,
  cameraView,
  canonicalTrack,
  compileDirectorTimeline,
  eulerFromMat3,
  framingDistance,
  mat3FromQuat,
  objectBounds,
  objectStateAt,
  quatFromEuler,
  rotateEuler,
  tracksOf,
  unionBounds,
  vecAdd,
  vecLength,
  vecLerp,
  vecNormalize,
  vecScale,
  vecSub,
  type DirectorAxis,
  type DirectorBounds,
  type DirectorCameraView,
  type DirectorObjectState,
  type DirectorRotationSpace,
  type DirectorTimeline,
} from './director-eval.ts'
import { createId } from './id.ts'

/**
 * 导演台的原子操作（docs/07 §7.3.1）—— 编辑器和 agent 写导演台的**同一份实现**，和 `flow-ops.ts` 一个形状：
 *
 * - `op(ctx, nodeId, input) → result`，在调用方的事务里跑，自己不 `transact`；
 * - **先校验、后动手**：所有参数、上限、要写的每个值都查完才写第一笔（Yjs 事务不回滚）；不满足抛 `FlowOpError`，
 *   抛出时文档一个字节没动。节点不存在 `NODE_NOT_FOUND`，不是导演台 `NOT_A_DIRECTOR`，点名的元素不存在
 *   `DIRECTOR_ELEMENT_NOT_FOUND`，参数不合法 `DIRECTOR_INVALID`，超上限 `DIRECTOR_LIMIT`；
 * - 一个操作的所有写和删是**一次** `writeNodeFields(ctx, nodeId, 'data', { set, remove })`。
 *
 * ## 单位
 *
 * **入参和返回值面向调用方：米、度、秒**（模型和人都用这一套）；存储一律按 docs/07 §7.2：弧度、毫秒
 * （fov 存的也是度，和 three 一致）。换算只在这个文件里发生。
 *
 * ## 批量与目标不存在
 *
 * 批量参数（新建、变换、改属性、关键帧）每次最多 {@link DIRECTOR_LIMITS}.batch 项，**有一项不合格整个拒绝**，
 * 点名的对象不存在也是整个拒绝（模型要重新读，不能猜）。删除例外：不存在的跳过、在结果里列出 —— 删除是幂等的，
 * 协同时别人可能先删了。
 *
 * ## 返回
 *
 * 每个写操作返回 {@link DirectorWriteResult}：写了 / 删了哪些键、写入后受影响对象的世界包围盒（某一时刻，见 `at`）、
 * 关键帧摘要、时长有没有被延长、提醒（比如「这个属性有关键帧，改静态值播放时看不到」）。
 *
 * ## 静态值和关键帧
 *
 * `dc.obj.*` 里存的位置 / 旋转 / 缩放是**静态值**：没有轨道的属性每一时刻都取它，有轨道的属性播放时被轨道覆盖。
 * 变换、摆放、对齐写的都是静态值，计算按**时刻 0** 的状态（和测量的缺省时刻一致）；对象在那个属性上有关键帧时，
 * 结果里带一条提醒。
 */

// —— 入参类型（米、度、秒）——

/** 三个数 `[x, y, z]`（JSON 来的数组也行，运行时校验长度和有限性） */
export type Vec3Input = readonly number[]

export interface DirectorObjectInput {
  kind: DirectorObjectKind
  /** 不给按种类起名：「立方体1」「机位2」… */
  name?: string
  /**
   * 几何中心，米。不给：几何体放在原点**并落地**（底面 y = 0），机位 `[0, 1.6, 6]`，灯光 `[3, 5, 3]`
   */
  position?: Vec3Input
  /** 欧拉角 XYZ，度 */
  rotation?: Vec3Input
  /** 三个轴的缩放，或一个数（等比） */
  scale?: Vec3Input | number
  /** 几何尺寸，米：box `width/height/depth`、sphere `radius`、cone / cylinder `radius/height`、plane `width/depth` */
  geometry?: Readonly<Record<string, number>>
  /** 颜色 `#rrggbb` 的简写：几何体写进 `material.color`，灯光写进 `light.color` */
  color?: string
  material?: DirectorMaterial
  /** 机位参数（fov 度） */
  camera?: Partial<DirectorCamera>
  light?: Partial<DirectorLight>
  /** 新对象的 id；不给就现发一个（`createId('obj')`） */
  id?: string
}

export interface DirectorRotateInput {
  axis: DirectorAxis
  degrees: number
  /** 绕世界轴还是本地轴转（默认 world） */
  space?: DirectorRotationSpace
}

export interface DirectorTransformInput {
  id: string
  /** 绝对值：位置（米）、旋转（度）、缩放 */
  set?: { position?: Vec3Input; rotation?: Vec3Input; scale?: Vec3Input | number }
  /** 相对当前值（在 `set` 之后应用）：平移若干米、绕某轴转若干度、缩放乘若干倍 */
  by?: { translate?: Vec3Input; rotate?: DirectorRotateInput; scale?: Vec3Input | number }
}

export type DirectorSide = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/** 约束式摆放：都按时刻 0 的世界包围盒算，只平移，不改旋转 / 缩放 */
export type DirectorPlacement =
  /** 落到地面：底面 y = 0，水平位置不变 */
  | { id: string; mode: 'ground' }
  /** 放到 target 顶上：底面 = target 的顶面；`center`（默认 true）时水平中心对齐 target 的包围盒中心 */
  | { id: string; mode: 'on_top'; target: string; center?: boolean }
  /**
   * 贴在 target 的某一侧，中间留 `gap` 米（默认 0）。另外两个轴：水平的那个对齐 target 的中心，
   * 竖直的保持不变（贴 ±y 时两个水平轴都对齐中心）
   */
  | { id: string; mode: 'beside'; target: string; side: DirectorSide; gap?: number }
  /** 放到某个坐标：`anchor` 为 bottom（默认）时是底面中心落在这一点，center 时是包围盒中心 */
  | { id: string; mode: 'at'; position: Vec3Input; anchor?: 'bottom' | 'center' }

export interface DirectorAlignInput {
  ids: readonly string[]
  axis: DirectorAxis
  /** 按包围盒的最小面、中心、最大面对齐 */
  mode: 'min' | 'center' | 'max'
  /** 对齐到这个对象（不动它）；不给就对齐到这批对象整体的包围盒 */
  to?: string
}

export interface DirectorDistributeInput {
  ids: readonly string[]
  axis: DirectorAxis
  /**
   * 相邻两个包围盒之间留多少米。给了：第一个不动、后面依次排开（至少 2 个）；
   * 不给：首尾不动、中间的等间距（至少 3 个）。顺序按当前中心在这个轴上的位置。
   */
  gap?: number
}

export interface DirectorAimInput {
  cameraId: string
  /** 对准某个对象（包围盒中心）或某个坐标，只转不动 */
  target?: { objectId: string } | { point: Vec3Input }
  /**
   * 装下这些对象：对准它们整体包围盒的中心，沿现在的方向（或 `direction`：从目标指向机位）前后挪到刚好装下的距离。
   * `margin` 是画面每一边留白占画面宽 / 高的比例（0–0.45，默认 0.05）
   */
  fit?: { objectIds: readonly string[]; margin?: number; direction?: Vec3Input }
}

export interface DirectorObjectPatch {
  id: string
  name?: string
  /** 颜色简写：几何体改 `material.color`，灯光改 `light.color` */
  color?: string
  /** 和现有的合并 */
  material?: DirectorMaterial
  /** 和现有的合并，米 */
  geometry?: Readonly<Record<string, number>>
  /** 和现有的合并，fov 度 */
  camera?: Partial<DirectorCamera>
  light?: Partial<DirectorLight>
}

export interface DirectorSettingsInput {
  /** 时长，秒；不能短于已有的最后一个关键帧 */
  duration?: number
  fps?: number
  aspect?: DirectorAspect
  /** 当前机位；null 清掉 */
  activeShot?: string | null
}

export interface DirectorKeyframesInput {
  objectId: string
  property: DirectorTrackProperty
  /** 轨道的插值方式：轨道不存在时用它建（默认 linear），存在时改成它 */
  interp?: DirectorInterpolation
  /** 时刻（秒）和值：position 米、rotation 欧拉角度数、scale 倍数（可以是一个数）、fov 度。同一时刻已有帧就覆盖 */
  keyframes: readonly { t: number; value: Vec3Input | number }[]
}

export type DirectorEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
export const DIRECTOR_EASINGS: readonly DirectorEasing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

interface MotionTiming {
  objectId: string
  /** 开始时刻，秒（默认 0） */
  start?: number
  /** 持续多久，秒 */
  duration: number
  /** 默认 linear */
  easing?: DirectorEasing
}

/**
 * 运动预设：生成**稀疏**关键帧（每条轨道最多 {@link DIRECTOR_LIMITS}.motionKeyframes 帧），起点取对象在 `start`
 * 时刻的状态；`[start, start + duration]` 里这条轨道原有的帧被替换。缓动烘进帧的时刻里（帧之间线性）。
 */
export type DirectorMotionInput =
  /**
   * 绕中心转：在水平面上，角度 0 在中心的 +Z 方向，正角度 = 从上往下看逆时针（绕 +Y 的右手方向）。
   * 中心给坐标（`center`）或对象（`centerObjectId`，取包围盒中心），都不给就是原点。
   * `radius` / `startAngle`（度）/ `height`（y）不给就从对象当前位置推出来。
   * `lookAt`（机位默认 true，只能用在机位上）：每一帧都对准中心。
   */
  | (MotionTiming & {
      preset: 'orbit'
      angle: number
      center?: Vec3Input
      centerObjectId?: string
      radius?: number
      startAngle?: number
      height?: number
      lookAt?: boolean
    })
  /** 从当前位置依次经过这些点（米），按路程分配时间 */
  | (MotionTiming & { preset: 'move_along'; points: readonly Vec3Input[] })
  /** 绕某个轴转若干度（可以超过 360°） */
  | (MotionTiming & { preset: 'turn'; axis: DirectorAxis; degrees: number; space?: DirectorRotationSpace })
  /** 缩放到目标倍数 */
  | (MotionTiming & { preset: 'scale_to'; scale: Vec3Input | number })

export interface DirectorDeleteInput {
  /** 删对象，连带它的轨道和关键帧 */
  objectIds?: readonly string[]
  /** 删轨道，连带它的关键帧 */
  trackIds?: readonly string[]
  keyframeIds?: readonly string[]
}

// —— 返回（米、度、秒）——

export interface DirectorBoundsReport {
  min: Vec3
  max: Vec3
  size: Vec3
  center: Vec3
  bottom: number
  precision: DirectorBounds['precision']
}

export interface DirectorObjectReport {
  id: string
  /** `dc.obj.<id>` */
  key: string
  kind: DirectorObjectKind
  name: string
  /** 在 `at` 时刻的状态：位置米、旋转欧拉角度数、缩放 */
  position: Vec3
  rotation: Vec3
  scale: Vec3
  /** 在 `at` 时刻的世界包围盒 */
  bounds: DirectorBoundsReport
  /** 有关键帧的属性（这些属性的静态值在播放时被轨道覆盖） */
  animated: DirectorTrackProperty[]
  /** 机位：fov（度，`at` 时刻的）、near、far */
  camera?: DirectorCamera
}

export interface DirectorKeyframeReport {
  trackId: string
  objectId: string
  property: DirectorTrackProperty
  /** 这次新建了这条轨道 */
  createdTrack: boolean
  /** 这次写了几帧（新建 + 覆盖） */
  count: number
  /** 这次替换掉的原有帧数（运动预设清掉窗口里的旧帧） */
  replaced: number
  /** 写入的帧的起止时刻，秒 */
  start: number
  end: number
  /** 写入的帧 id */
  keyframeIds: string[]
}

export interface DirectorWriteResult {
  nodeId: string
  /** 写入的 `data` 键 */
  set: string[]
  /** 删掉的 `data` 键 */
  removed: string[]
  /** 受影响对象写入后的状态（在 `at` 时刻） */
  objects: DirectorObjectReport[]
  /** 报告里的状态取的时刻，秒 */
  at: number
  /** 关键帧类操作的摘要 */
  keyframes: DirectorKeyframeReport[]
  /** 时长，秒；关键帧超出时自动延长 */
  duration: { before: number; after: number; extended: boolean }
  warnings: string[]
}

export interface DirectorAimResult extends DirectorWriteResult {
  /** 机位到对准点的距离，米 */
  distance: number
  /** 写入后机位在 `at` 时刻的取景（只含 fit 的那批对象；没 fit 是全部） */
  view: DirectorCameraView | null
}

export interface DirectorDeleteResult extends DirectorWriteResult {
  deleted: { objects: string[]; tracks: string[]; keyframes: string[] }
  /** 点名了但本来就不在的 id */
  missing: string[]
}

// —— 校验工具 ——

function invalid(message: string): never {
  throw new FlowOpError('DIRECTOR_INVALID', message)
}

function notFound(message: string): never {
  throw new FlowOpError('DIRECTOR_ELEMENT_NOT_FOUND', message)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function num(value: unknown, what: string, min = -Infinity, max = Infinity): number {
  if (!isFiniteNumber(value)) invalid(`${what} 必须是有限数`)
  if (value < min || value > max) invalid(`${what} 超出范围 [${min}, ${max}]（实际 ${value}）`)
  return value
}

function vec3(value: unknown, what: string, min = -Infinity, max = Infinity): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) invalid(`${what} 必须是三个数 [x, y, z]`)
  return [num(value[0], `${what}[0]`, min, max), num(value[1], `${what}[1]`, min, max), num(value[2], `${what}[2]`, min, max)]
}

function scaleInput(value: unknown, what: string): Vec3 {
  if (isFiniteNumber(value)) return [value, value, value]
  return vec3(value, what)
}

function oneOf<T extends string>(value: unknown, list: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    invalid(`${what} 不认识：${String(value)}（可选 ${list.join(' / ')}）`)
  }
  return value as T
}

function idString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${what} 必须是非空字符串`)
  return value
}

function batch<T>(items: unknown, what: string, min = 1): readonly T[] {
  if (!Array.isArray(items)) invalid(`${what} 必须是数组`)
  if (items.length < min) invalid(`${what} 至少要 ${min} 项`)
  if (items.length > DIRECTOR_LIMITS.batch) {
    throw new FlowOpError('DIRECTOR_LIMIT', `${what} 一次最多 ${DIRECTOR_LIMITS.batch} 项（实际 ${items.length}），分几次做`)
  }
  return items as readonly T[]
}

function uniqueIds(ids: readonly string[], what: string): string[] {
  const out = ids.map((id) => idString(id, what))
  if (new Set(out).size !== out.length) invalid(`${what} 里有重复的 id`)
  return out
}

function requireObject(scene: DirectorScene, id: unknown, what = '对象'): DirectorObject {
  const key = idString(id, `${what} id`)
  const object = scene.objects.get(key)
  if (!object) notFound(`${what} ${key} 不存在（先 get_director_scene 重新读）`)
  return object
}

function requireCamera(scene: DirectorScene, id: unknown): Extract<DirectorObject, { kind: 'camera' }> {
  const object = requireObject(scene, id, '机位')
  if (object.kind !== 'camera') invalid(`${object.id} 是 ${object.kind}，不是机位`)
  return object
}

function color(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) invalid(`${what} 必须是 #rrggbb 形式的颜色`)
  return value
}

// —— 读 ——

interface DirectorHandle {
  data: Record<string, unknown>
  scene: DirectorScene
  timeline: DirectorTimeline
}

function openDirector(ctx: FlowOpContext, nodeId: string): DirectorHandle {
  const node = requireNodeMap(ctx, nodeId)
  if (node.get('type') !== DIRECTOR_NODE_TYPE) {
    throw new FlowOpError('NOT_A_DIRECTOR', `节点 ${nodeId} 不是导演台（是 ${String(node.get('type'))}）`)
  }
  const group = nodeGroupMap(node, 'data')
  const data = group ? (group.toJSON() as Record<string, unknown>) : {}
  const scene = readDirectorScene(data)
  return { data, scene, timeline: compileDirectorTimeline(scene) }
}

/** 读一个导演台节点的场景（存储单位）。不存在抛 `NODE_NOT_FOUND`，不是导演台抛 `NOT_A_DIRECTOR` */
export function readDirector(ctx: FlowOpContext, nodeId: string): DirectorScene {
  return openDirector(ctx, nodeId).scene
}

export interface DirectorSnapshot {
  /** 秒 */
  duration: number
  fps: number
  aspect: DirectorAspect
  activeShot: string | null
  objects: {
    id: string
    kind: DirectorObjectKind
    name: string
    position: Vec3
    /** 度 */
    rotation: Vec3
    scale: Vec3
    geometry?: Record<string, number>
    material?: DirectorMaterial
    camera?: DirectorCamera
    light?: DirectorLight
    /** 有关键帧的属性 */
    animated: DirectorTrackProperty[]
  }[]
  tracks: {
    id: string
    objectId: string
    property: DirectorTrackProperty
    interp: DirectorInterpolation
    /** 按时刻排好；t 秒，rotation 的值是度 */
    keyframes: { id: string; t: number; value: Vec3 | number }[]
  }[]
  /** 读不懂、被跳过的键 */
  skipped: string[]
}

/**
 * 场景换成面向调用方的单位（米、度、秒）、按 id 排好序 —— `get_director_scene` 直接回给模型的形状。
 * `objectIds` 给了就只要这些对象和它们的轨道。
 */
export function snapshotDirector(scene: DirectorScene, options: { objectIds?: Iterable<string> } = {}): DirectorSnapshot {
  const only = options.objectIds ? new Set(options.objectIds) : null
  const timeline = compileDirectorTimeline(scene)
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const objects = [...scene.objects.values()]
    .filter((object) => !only || only.has(object.id))
    .sort(byId)
    .map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name,
      position: [...object.position] as Vec3,
      rotation: vec3RadToDeg(object.rotation),
      scale: [...object.scale] as Vec3,
      ...(isDirectorShape(object) ? { geometry: { ...object.geometry } as Record<string, number> } : {}),
      ...(isDirectorShape(object) && object.material ? { material: { ...object.material } } : {}),
      ...(object.kind === 'camera' ? { camera: { ...object.camera } } : {}),
      ...(object.kind === 'light' ? { light: { ...object.light } } : {}),
      animated: animatedProperties(timeline, object.id),
    }))
  const keyframesOf = new Map<string, DirectorKeyframe[]>()
  for (const keyframe of scene.keyframes.values()) {
    const list = keyframesOf.get(keyframe.trackId) ?? []
    list.push(keyframe)
    keyframesOf.set(keyframe.trackId, list)
  }
  const tracks = [...scene.tracks.values()]
    .filter((track) => !only || only.has(track.objectId))
    .sort(byId)
    .map((track) => ({
      id: track.id,
      objectId: track.objectId,
      property: track.property,
      interp: track.interp,
      keyframes: (keyframesOf.get(track.id) ?? [])
        .sort((a, b) => a.t - b.t || byId(a, b))
        .map((keyframe) => ({ id: keyframe.id, t: msToSeconds(keyframe.t), value: valueOut(track.property, keyframe.value) })),
    }))
  return {
    duration: msToSeconds(scene.duration),
    fps: scene.fps,
    aspect: scene.aspect,
    activeShot: scene.activeShot,
    objects,
    tracks,
    skipped: [...scene.skipped],
  }
}

function valueOut(property: DirectorTrackProperty, value: DirectorKeyframeValue): Vec3 | number {
  if (typeof value === 'number') return value
  return property === 'rotation' ? vec3RadToDeg(value) : [...value]
}

// —— 写：一次操作攒一笔，校验完再落 ——

class DirectorWrite {
  readonly set: Record<string, unknown> = {}
  readonly remove = new Set<string>()
  /** 这次写入的关键帧里最晚的时刻（毫秒） */
  latestKeyframe = -1
  durationOverride: number | null = null

  readonly nodeId: string
  readonly handle: DirectorHandle

  constructor(nodeId: string, handle: DirectorHandle) {
    this.nodeId = nodeId
    this.handle = handle
  }

  putObject(object: DirectorObject): void {
    const error = validateDirectorObject(object, 'caller')
    if (error) invalid(error)
    this.put(directorObjectKey(object.id), encodeDirectorObject(object))
  }

  putTrack(track: DirectorTrack, kind: DirectorObjectKind): void {
    const error = validateDirectorTrack(track, kind)
    if (error) invalid(error)
    this.put(directorTrackKey(track.id), encodeDirectorTrack(track))
  }

  putKeyframe(keyframe: DirectorKeyframe, property: DirectorTrackProperty): void {
    const error = validateDirectorKeyframe(keyframe, property, 'caller')
    if (error) invalid(error)
    this.put(directorKeyframeKey(keyframe.id), encodeDirectorKeyframe(keyframe))
    this.latestKeyframe = Math.max(this.latestKeyframe, keyframe.t)
  }

  put(key: string, value: unknown): void {
    this.remove.delete(key)
    this.set[key] = value
  }

  drop(key: string): void {
    delete this.set[key]
    this.remove.add(key)
  }

  /** 上限、体积、时长延长都查完再一笔写进去 */
  commit(ctx: FlowOpContext): { before: number; after: number } {
    const before = this.handle.scene.duration
    let after = this.durationOverride ?? before
    if (this.latestKeyframe > after) {
      after = this.latestKeyframe
      if (after > DIRECTOR_LIMITS.durationMs) {
        throw new FlowOpError('DIRECTOR_LIMIT', `关键帧时刻超过时长上限 ${msToSeconds(DIRECTOR_LIMITS.durationMs)} 秒`)
      }
    }
    if (after !== before || this.durationOverride !== null) this.put(DC_DURATION_KEY, after)

    const initial = directorElementCounts(this.handle.data)
    const final = { ...initial }
    const prefixes = [
      ['objects', DC_OBJECT_PREFIX],
      ['tracks', DC_TRACK_PREFIX],
      ['keyframes', DC_KEYFRAME_PREFIX],
    ] as const
    for (const key of Object.keys(this.set)) {
      if (key in this.handle.data) continue
      for (const [field, prefix] of prefixes) if (key.startsWith(prefix + '.')) final[field]++
    }
    for (const key of this.remove) {
      if (!(key in this.handle.data)) continue
      for (const [field, prefix] of prefixes) if (key.startsWith(prefix + '.')) final[field]--
    }
    const names = { objects: '对象', tracks: '轨道', keyframes: '关键帧' } as const
    for (const [field] of prefixes) {
      // 已经超了（并发写入叠出来的）时只拦增加，不拦删除
      if (final[field] > DIRECTOR_LIMITS[field] && final[field] > initial[field]) {
        throw new FlowOpError(
          'DIRECTOR_LIMIT',
          `${names[field]}超过上限 ${DIRECTOR_LIMITS[field]}（写入后会有 ${final[field]} 个）` +
            (field === 'keyframes' ? '：关键帧要稀疏，只打关键时刻，不要逐帧烘焙' : ''),
        )
      }
    }
    const bytes = serializedBytes(this.set)
    if (bytes > DIRECTOR_LIMITS.transactionBytes) {
      throw new FlowOpError(
        'DIRECTOR_LIMIT',
        `一次写入 ${Math.ceil(bytes / 1024)}KB，超过上限 ${DIRECTOR_LIMITS.transactionBytes / 1024}KB，分几次做`,
      )
    }
    const remove = [...this.remove].filter((key) => key in this.handle.data)
    writeNodeFields(ctx, this.nodeId, 'data', { set: this.set, remove })
    return { before, after }
  }
}

interface ResultExtras {
  objectIds: Iterable<string>
  atMs?: number
  keyframes?: DirectorKeyframeReport[]
  warnings?: string[]
}

function objectReport(timeline: DirectorTimeline, id: string, atMs: number): DirectorObjectReport | null {
  const object = timeline.scene.objects.get(id)
  const state = objectStateAt(timeline, id, atMs)
  if (!object || !state) return null
  const bounds = objectBounds(object, state)
  return {
    id,
    key: directorObjectKey(id),
    kind: object.kind,
    name: object.name,
    position: state.position,
    rotation: vec3RadToDeg(state.rotation),
    scale: state.scale,
    bounds: {
      min: bounds.min,
      max: bounds.max,
      size: bounds.size,
      center: bounds.center,
      bottom: bounds.bottom,
      precision: bounds.precision,
    },
    animated: animatedProperties(timeline, id),
    ...(object.kind === 'camera' ? { camera: { ...object.camera, fov: state.fov ?? object.camera.fov } } : {}),
  }
}

function finish(ctx: FlowOpContext, write: DirectorWrite, extras: ResultExtras): DirectorWriteResult {
  const duration = write.commit(ctx)
  const after = openDirector(ctx, write.nodeId)
  const atMs = extras.atMs ?? 0
  const objects: DirectorObjectReport[] = []
  for (const id of new Set(extras.objectIds)) {
    const report = objectReport(after.timeline, id, atMs)
    if (report) objects.push(report)
  }
  return {
    nodeId: write.nodeId,
    set: Object.keys(write.set),
    removed: [...write.remove].filter((key) => key in write.handle.data),
    objects,
    at: msToSeconds(atMs),
    keyframes: extras.keyframes ?? [],
    duration: {
      before: msToSeconds(duration.before),
      after: msToSeconds(duration.after),
      extended: duration.after > duration.before && write.durationOverride === null,
    },
    warnings: extras.warnings ?? [],
  }
}

/** 静态值被轨道覆盖的提醒 */
function animatedWarning(timeline: DirectorTimeline, object: DirectorObject, touched: readonly DirectorTrackProperty[]): string | null {
  const hit = animatedProperties(timeline, object.id).filter((property) => touched.includes(property))
  if (hit.length === 0) return null
  return `${object.name}（${object.id}）的 ${hit.join(' / ')} 有关键帧，改的是静态值，播放时被关键帧覆盖；要改动画请用 set_keyframes`
}

function stateAt0(handle: DirectorHandle, object: DirectorObject): DirectorObjectState {
  // 对象一定在（调用方刚 requireObject 过）
  return objectStateAt(handle.timeline, object.id, 0) as DirectorObjectState
}

function boundsAt0(handle: DirectorHandle, object: DirectorObject): DirectorBounds {
  return objectBounds(object, stateAt0(handle, object))
}

/** 只平移静态位置：包围盒整体挪 delta */
function translated(object: DirectorObject, delta: Readonly<Vec3>): DirectorObject {
  return { ...object, position: vecAdd(object.position, delta) }
}

// —— 新建 ——

/** 新建若干对象（图形 / 机位 / 灯光）。返回的 `objects` 里有新 id */
export function addDirectorObjects(
  ctx: FlowOpContext,
  nodeId: string,
  items: readonly DirectorObjectInput[],
): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  const list = batch<DirectorObjectInput>(items, '新建的对象')
  const write = new DirectorWrite(nodeId, handle)
  const ids: string[] = []
  const kindCount = new Map<DirectorObjectKind, number>()
  for (const object of handle.scene.objects.values()) kindCount.set(object.kind, (kindCount.get(object.kind) ?? 0) + 1)

  for (const [index, input] of list.entries()) {
    const what = `第 ${index + 1} 个对象`
    if (typeof input !== 'object' || input === null) invalid(`${what} 必须是对象`)
    const kind = oneOf(input.kind, DIRECTOR_OBJECT_KINDS, `${what} 的种类`)
    const id = input.id === undefined ? createId(DC_OBJECT_ID_PREFIX) : idString(input.id, `${what} 的 id`)
    if (handle.scene.objects.has(id) || directorObjectKey(id) in write.set) invalid(`对象 id ${id} 已被占用`)
    const n = (kindCount.get(kind) ?? 0) + 1
    kindCount.set(kind, n)
    if (input.name !== undefined && typeof input.name !== 'string') invalid(`${what} 的名字必须是字符串`)
    const name = input.name === undefined ? `${DIRECTOR_KIND_LABELS[kind]}${n}` : input.name.trim()
    const rotation = input.rotation === undefined ? ([0, 0, 0] as Vec3) : vec3(input.rotation, `${what} 的 rotation（度）`)
    const scale = input.scale === undefined ? ([1, 1, 1] as Vec3) : scaleInput(input.scale, `${what} 的 scale`)
    const common = { id, name, position: [0, 0, 0] as Vec3, rotation: rotation.map(degToRad) as Vec3, scale }

    let object: DirectorObject
    if (kind === 'camera') {
      object = { ...common, kind, camera: { ...DEFAULT_DIRECTOR_CAMERA, ...cameraPatch(input.camera, what) } }
      object.position = [0, 1.6, 6]
    } else if (kind === 'light') {
      const light: DirectorLight = { ...DEFAULT_DIRECTOR_LIGHT, ...lightPatch(input.light, what) }
      if (input.color !== undefined) light.color = color(input.color, `${what} 的颜色`)
      object = { ...common, kind, light }
      object.position = [3, 5, 3]
    } else {
      const geometry = { ...defaultGeometry(kind), ...geometryPatch(kind, input.geometry, what) }
      const material = materialPatch(input.material, what)
      if (input.color !== undefined) material.color = color(input.color, `${what} 的颜色`)
      object = {
        ...common,
        kind,
        geometry,
        ...(Object.keys(material).length > 0 ? { material } : {}),
      } as DirectorObject
    }
    if (input.position !== undefined) {
      object.position = vec3(input.position, `${what} 的 position`)
    } else if (isDirectorShape(object)) {
      // 不给位置的几何体落地放在原点
      const bounds = objectBounds(object, { position: [0, 0, 0], quaternion: quatFromEuler(object.rotation), scale: object.scale })
      object.position = [0, -bounds.bottom, 0]
    }
    write.putObject(object)
    ids.push(id)
  }
  return finish(ctx, write, { objectIds: ids })
}

function geometryPatch(kind: Exclude<DirectorObjectKind, 'camera' | 'light'>, value: unknown, what: string): Record<string, number> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) invalid(`${what} 的 geometry 必须是对象`)
  const fields = GEOMETRY_FIELDS[kind]
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!fields.includes(key)) invalid(`${what}（${kind}）没有几何参数 ${key}（可用 ${fields.join(' / ')}）`)
    out[key] = num(raw, `${what} 的 ${key}（米）`, DIRECTOR_LIMITS.size.min, DIRECTOR_LIMITS.size.max)
  }
  return out
}

function materialPatch(value: unknown, what: string): DirectorMaterial {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) invalid(`${what} 的 material 必须是对象`)
  const out: DirectorMaterial = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'color') out.color = color(raw, `${what} 的颜色`)
    else if (key === 'opacity' || key === 'roughness' || key === 'metalness') out[key] = num(raw, `${what} 的 ${key}`, 0, 1)
    else invalid(`${what} 的材质没有 ${key} 这一项（可用 color / opacity / roughness / metalness）`)
  }
  return out
}

function cameraPatch(value: unknown, what: string): Partial<DirectorCamera> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) invalid(`${what} 的 camera 必须是对象`)
  const out: Partial<DirectorCamera> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'fov') out.fov = num(raw, `${what} 的 fov（度）`, DIRECTOR_LIMITS.fov.min, DIRECTOR_LIMITS.fov.max)
    else if (key === 'near') out.near = num(raw, `${what} 的 near`, DIRECTOR_LIMITS.near.min, DIRECTOR_LIMITS.near.max)
    else if (key === 'far') out.far = num(raw, `${what} 的 far`, DIRECTOR_LIMITS.near.min, DIRECTOR_LIMITS.far.max)
    else invalid(`${what} 的机位参数没有 ${key}（可用 fov / near / far）`)
  }
  return out
}

function lightPatch(value: unknown, what: string): Partial<DirectorLight> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) invalid(`${what} 的 light 必须是对象`)
  const out: Partial<DirectorLight> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'type') out.type = oneOf(raw, DIRECTOR_LIGHT_TYPES, `${what} 的灯光类型`)
    else if (key === 'intensity') out.intensity = num(raw, `${what} 的灯光强度`, DIRECTOR_LIMITS.intensity.min, DIRECTOR_LIMITS.intensity.max)
    else if (key === 'color') out.color = color(raw, `${what} 的灯光颜色`)
    else invalid(`${what} 的灯光参数没有 ${key}（可用 type / intensity / color）`)
  }
  return out
}

// —— 变换 ——

/** 改位置 / 旋转 / 缩放：`set` 绝对值，`by` 相对当前（静态）值 */
export function transformDirectorObjects(
  ctx: FlowOpContext,
  nodeId: string,
  items: readonly DirectorTransformInput[],
): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  const list = batch<DirectorTransformInput>(items, '变换')
  uniqueIds(list.map((item) => item?.id), '变换的对象')
  const write = new DirectorWrite(nodeId, handle)
  const warnings: string[] = []
  for (const [index, input] of list.entries()) {
    const what = `第 ${index + 1} 项变换`
    const object = requireObject(handle.scene, input.id)
    if (input.set === undefined && input.by === undefined) invalid(`${what} 没有给 set 或 by`)
    let position: Vec3 = [...object.position]
    let rotation: Vec3 = [...object.rotation]
    let scale: Vec3 = [...object.scale]
    const touched: DirectorTrackProperty[] = []
    if (input.set !== undefined) {
      if (typeof input.set !== 'object' || input.set === null) invalid(`${what} 的 set 必须是对象`)
      if (input.set.position !== undefined) position = vec3(input.set.position, `${what} 的 position`)
      if (input.set.rotation !== undefined) rotation = vec3(input.set.rotation, `${what} 的 rotation（度）`).map(degToRad) as Vec3
      if (input.set.scale !== undefined) scale = scaleInput(input.set.scale, `${what} 的 scale`)
      if (input.set.position !== undefined) touched.push('position')
      if (input.set.rotation !== undefined) touched.push('rotation')
      if (input.set.scale !== undefined) touched.push('scale')
    }
    if (input.by !== undefined) {
      if (typeof input.by !== 'object' || input.by === null) invalid(`${what} 的 by 必须是对象`)
      const { translate, rotate, scale: factor } = input.by
      if (translate !== undefined) {
        position = vecAdd(position, vec3(translate, `${what} 的 translate（米）`))
        touched.push('position')
      }
      if (rotate !== undefined) {
        if (typeof rotate !== 'object' || rotate === null) invalid(`${what} 的 rotate 必须是对象`)
        const axis = oneOf(rotate.axis, ['x', 'y', 'z'] as const, `${what} 的旋转轴`)
        const degrees = num(rotate.degrees, `${what} 的旋转角度（度）`, -3600, 3600)
        const space = rotate.space === undefined ? 'world' : oneOf(rotate.space, ['world', 'local'] as const, `${what} 的旋转空间`)
        rotation = rotateEuler(rotation, axis, degToRad(degrees), space)
        touched.push('rotation')
      }
      if (factor !== undefined) {
        const f = scaleInput(factor, `${what} 的缩放倍数`)
        scale = [scale[0] * f[0], scale[1] * f[1], scale[2] * f[2]]
        touched.push('scale')
      }
    }
    write.putObject({ ...object, position, rotation, scale })
    const warning = animatedWarning(handle.timeline, object, touched)
    if (warning) warnings.push(warning)
  }
  return finish(ctx, write, { objectIds: list.map((item) => item.id), warnings })
}

// —— 约束式摆放 ——

const SIDES: Record<DirectorSide, { axis: 0 | 1 | 2; sign: 1 | -1 }> = {
  '+x': { axis: 0, sign: 1 },
  '-x': { axis: 0, sign: -1 },
  '+y': { axis: 1, sign: 1 },
  '-y': { axis: 1, sign: -1 },
  '+z': { axis: 2, sign: 1 },
  '-z': { axis: 2, sign: -1 },
}

/** 约束式摆放：按世界包围盒算出平移量，只改静态位置 */
export function placeDirectorObject(ctx: FlowOpContext, nodeId: string, placement: DirectorPlacement): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof placement !== 'object' || placement === null) invalid('摆放参数必须是对象')
  const object = requireObject(handle.scene, placement.id)
  const mode = oneOf(placement.mode, ['ground', 'on_top', 'beside', 'at'] as const, '摆放方式')
  const own = boundsAt0(handle, object)
  if (own.precision === 'point' && mode !== 'at') invalid(`${object.name} 是${DIRECTOR_KIND_LABELS[object.kind]}，没有体积，只能用 at 放到坐标`)
  const delta: Vec3 = [0, 0, 0]

  const targetOf = (id: unknown): DirectorBounds => {
    const target = requireObject(handle.scene, id, '参照对象')
    if (target.id === object.id) invalid('参照对象不能是它自己')
    const bounds = boundsAt0(handle, target)
    if (bounds.precision === 'point') invalid(`参照对象 ${target.name} 没有体积（${target.kind}）`)
    return bounds
  }

  if (placement.mode === 'ground') {
    delta[1] = -own.bottom
  } else if (placement.mode === 'on_top') {
    const target = targetOf(placement.target)
    delta[1] = target.max[1] - own.min[1]
    if (placement.center !== false) {
      delta[0] = target.center[0] - own.center[0]
      delta[2] = target.center[2] - own.center[2]
    }
  } else if (placement.mode === 'beside') {
    const target = targetOf(placement.target)
    const side = SIDES[oneOf(placement.side, Object.keys(SIDES) as DirectorSide[], '贴哪一侧')]
    const gap = placement.gap === undefined ? 0 : num(placement.gap, '间距（米）', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
    const a = side.axis
    delta[a] = side.sign > 0 ? target.max[a] + gap - own.min[a] : target.min[a] - gap - own.max[a]
    for (const other of [0, 2] as const) {
      if (other !== a) delta[other] = target.center[other] - own.center[other]
    }
  } else {
    const point = vec3(placement.position, '目标坐标', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
    const anchor = placement.anchor === undefined ? 'bottom' : oneOf(placement.anchor, ['bottom', 'center'] as const, '锚点')
    const from: Vec3 = anchor === 'bottom' ? [own.center[0], own.bottom, own.center[2]] : own.center
    delta[0] = point[0] - from[0]
    delta[1] = point[1] - from[1]
    delta[2] = point[2] - from[2]
  }

  const write = new DirectorWrite(nodeId, handle)
  write.putObject(translated(object, delta))
  const warning = animatedWarning(handle.timeline, object, ['position'])
  return finish(ctx, write, { objectIds: [object.id], warnings: warning ? [warning] : [] })
}

// —— 对齐 / 等距分布 ——

const AXES: Record<DirectorAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 }

function solids(handle: DirectorHandle, ids: readonly string[], what: string): { object: DirectorObject; bounds: DirectorBounds }[] {
  return uniqueIds(ids, what).map((id) => {
    const object = requireObject(handle.scene, id)
    return { object, bounds: boundsAt0(handle, object) }
  })
}

/** 按某轴对齐（包围盒的最小面 / 中心 / 最大面） */
export function alignDirectorObjects(ctx: FlowOpContext, nodeId: string, input: DirectorAlignInput): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('对齐参数必须是对象')
  const axis = AXES[oneOf(input.axis, ['x', 'y', 'z'] as const, '对齐轴')]
  const mode = oneOf(input.mode, ['min', 'center', 'max'] as const, '对齐方式')
  const members = solids(handle, batch<string>(input.ids, '对齐的对象', input.to === undefined ? 2 : 1), '对齐的对象')
  const pick = (bounds: DirectorBounds) => (mode === 'min' ? bounds.min[axis] : mode === 'max' ? bounds.max[axis] : bounds.center[axis])
  let reference: number
  if (input.to !== undefined) {
    const to = requireObject(handle.scene, input.to, '参照对象')
    if (members.some((m) => m.object.id === to.id)) invalid('参照对象不能同时在要对齐的对象里')
    reference = pick(boundsAt0(handle, to))
  } else {
    reference = pick(unionBounds(members.map((m) => m.bounds)) as DirectorBounds)
  }
  const write = new DirectorWrite(nodeId, handle)
  const warnings: string[] = []
  for (const { object, bounds } of members) {
    const delta: Vec3 = [0, 0, 0]
    delta[axis] = reference - pick(bounds)
    write.putObject(translated(object, delta))
    const warning = animatedWarning(handle.timeline, object, ['position'])
    if (warning) warnings.push(warning)
  }
  return finish(ctx, write, { objectIds: members.map((m) => m.object.id), warnings })
}

/** 沿某轴等距排开（包围盒之间的间隙相等） */
export function distributeDirectorObjects(ctx: FlowOpContext, nodeId: string, input: DirectorDistributeInput): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('分布参数必须是对象')
  const axis = AXES[oneOf(input.axis, ['x', 'y', 'z'] as const, '分布轴')]
  const fixedGap = input.gap === undefined ? null : num(input.gap, '间距（米）', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
  const members = solids(handle, batch<string>(input.ids, '分布的对象', fixedGap === null ? 3 : 2), '分布的对象').sort(
    (a, b) => a.bounds.center[axis] - b.bounds.center[axis] || (a.object.id < b.object.id ? -1 : 1),
  )
  const first = members[0]!
  const last = members[members.length - 1]!
  const sizes = members.reduce((sum, m) => sum + m.bounds.size[axis], 0)
  const gap = fixedGap ?? (last.bounds.max[axis] - first.bounds.min[axis] - sizes) / (members.length - 1)
  const warnings: string[] = []
  if (gap < 0) warnings.push(`间距是负的（${gap.toFixed(3)} 米）：这些对象排不开，会互相重叠`)
  const write = new DirectorWrite(nodeId, handle)
  let cursor = first.bounds.min[axis]
  for (const { object, bounds } of members) {
    const delta: Vec3 = [0, 0, 0]
    delta[axis] = cursor - bounds.min[axis]
    cursor += bounds.size[axis] + gap
    write.putObject(translated(object, delta))
    const warning = animatedWarning(handle.timeline, object, ['position'])
    if (warning) warnings.push(warning)
  }
  return finish(ctx, write, { objectIds: members.map((m) => m.object.id), warnings })
}

// —— 机位瞄准 ——

/** 机位对准某个对象 / 坐标（只转），或给一组对象算出刚好装下它们的距离（转 + 挪） */
export function aimDirectorCamera(ctx: FlowOpContext, nodeId: string, input: DirectorAimInput): DirectorAimResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('瞄准参数必须是对象')
  const camera = requireCamera(handle.scene, input.cameraId)
  if ((input.target === undefined) === (input.fit === undefined)) invalid('target 和 fit 必须给且只给一个')
  const state = stateAt0(handle, camera)
  let position: Vec3 = [...camera.position]
  let lookTarget: Vec3
  let viewIds: string[] | undefined
  const warnings: string[] = []

  if (input.target !== undefined) {
    const target = input.target as { objectId?: unknown; point?: unknown }
    if (typeof target !== 'object' || target === null) invalid('target 必须是 { objectId } 或 { point }')
    if (target.objectId !== undefined) {
      const object = requireObject(handle.scene, target.objectId, '目标对象')
      if (object.id === camera.id) invalid('机位不能对准它自己')
      lookTarget = boundsAt0(handle, object).center
    } else {
      lookTarget = vec3(target.point, '目标坐标', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
    }
    if (vecLength(vecSub(lookTarget, position)) < 1e-6) invalid('目标和机位在同一个位置，没法对准')
  } else {
    const fit = input.fit as NonNullable<DirectorAimInput['fit']>
    if (typeof fit !== 'object' || fit === null) invalid('fit 必须是对象')
    const members = solids(handle, batch<string>(fit.objectIds, '要装下的对象'), '要装下的对象')
    if (members.some((m) => m.object.id === camera.id)) invalid('要装下的对象里不能有机位自己')
    const margin = fit.margin === undefined ? 0.05 : num(fit.margin, '留白（margin）', 0, 0.45)
    const union = unionBounds(members.map((m) => m.bounds)) as DirectorBounds
    lookTarget = union.center
    let direction: Vec3
    if (fit.direction !== undefined) {
      direction = vec3(fit.direction, '方向（direction）')
      if (vecLength(direction) < 1e-9) invalid('方向（direction）不能是零向量')
    } else {
      direction = vecSub(state.position, union.center)
      if (vecLength(direction) < 1e-6) {
        // 机位就在中心：沿它现在的朝后方向（本地 +Z）退
        const m = mat3FromQuat(state.quaternion)
        direction = [m[2], m[5], m[8]]
      }
    }
    direction = vecNormalize(direction)
    const rotation = cameraLookAt(vecAdd(union.center, direction), union.center)
    const aspect = aspectRatioOf(handle.scene.aspect)
    const fov = state.fov ?? camera.camera.fov
    const distance = framingDistance(boundsCorners(union), union.center, rotation, { fov, near: camera.camera.near }, aspect, margin)
    position = vecAdd(union.center, vecScale(direction, distance))
    if (distance + vecLength(union.size) / 2 > camera.camera.far) {
      warnings.push(`机位退到 ${distance.toFixed(2)} 米，超出了远裁剪面 ${camera.camera.far} 米，远处会被裁掉`)
    }
    viewIds = members.map((m) => m.object.id)
  }

  const rotation = eulerFromMat3(cameraLookAt(position, lookTarget))
  const write = new DirectorWrite(nodeId, handle)
  write.putObject({ ...camera, position, rotation })
  const warning = animatedWarning(handle.timeline, camera, input.fit !== undefined ? ['position', 'rotation'] : ['rotation'])
  if (warning) warnings.push(warning)
  const result = finish(ctx, write, { objectIds: [camera.id], warnings })
  const after = openDirector(ctx, nodeId)
  return {
    ...result,
    distance: vecLength(vecSub(lookTarget, position)),
    view: cameraView(after.timeline, camera.id, 0, viewIds ? { objectIds: viewIds } : {}),
  }
}

// —— 改属性 ——

/** 改名字、颜色、材质、几何尺寸、机位参数、灯光参数（和现有的合并） */
export function updateDirectorObjects(
  ctx: FlowOpContext,
  nodeId: string,
  items: readonly DirectorObjectPatch[],
): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  const list = batch<DirectorObjectPatch>(items, '要改的对象')
  uniqueIds(list.map((item) => item?.id), '要改的对象')
  const write = new DirectorWrite(nodeId, handle)
  for (const [index, patch] of list.entries()) {
    const what = `第 ${index + 1} 项`
    const object = requireObject(handle.scene, patch.id)
    let next: DirectorObject = { ...object }
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string') invalid(`${what} 的名字必须是字符串`)
      next.name = patch.name.trim()
    }
    if (next.kind === 'camera') {
      if (patch.geometry !== undefined || patch.material !== undefined || patch.light !== undefined || patch.color !== undefined) {
        invalid(`${what}：机位只能改名字和 camera 参数`)
      }
      next = { ...next, camera: { ...next.camera, ...cameraPatch(patch.camera, what) } }
    } else if (next.kind === 'light') {
      if (patch.geometry !== undefined || patch.material !== undefined || patch.camera !== undefined) {
        invalid(`${what}：灯光只能改名字、颜色和 light 参数`)
      }
      const light = { ...next.light, ...lightPatch(patch.light, what) }
      if (patch.color !== undefined) light.color = color(patch.color, `${what} 的颜色`)
      next = { ...next, light }
    } else {
      if (patch.camera !== undefined || patch.light !== undefined) invalid(`${what}：${next.kind} 没有 camera / light 参数`)
      const material = { ...(next.material ?? {}), ...materialPatch(patch.material, what) }
      if (patch.color !== undefined) material.color = color(patch.color, `${what} 的颜色`)
      next = {
        ...next,
        geometry: { ...next.geometry, ...geometryPatch(next.kind, patch.geometry, what) },
        ...(Object.keys(material).length > 0 ? { material } : {}),
      } as DirectorObject
    }
    write.putObject(next)
  }
  return finish(ctx, write, { objectIds: list.map((item) => item.id) })
}

/** 改时长 / 帧率 / 画幅 / 当前机位（`dc.duration` / `dc.fps` / `dc.aspect` / `dc.activeShot`） */
export function setDirectorSettings(ctx: FlowOpContext, nodeId: string, input: DirectorSettingsInput): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('设置参数必须是对象')
  const write = new DirectorWrite(nodeId, handle)
  if (input.duration !== undefined) {
    const ms = secondsToMs(num(input.duration, '时长（秒）'))
    const error = validateDirectorDuration(ms, 'caller')
    if (error) invalid(error)
    const last = handle.timeline.lastKeyframe
    if (ms < last) invalid(`时长不能短于最后一个关键帧（${msToSeconds(last)} 秒）；先删掉后面的关键帧`)
    write.durationOverride = ms
  }
  if (input.fps !== undefined) {
    const error = validateDirectorFps(input.fps)
    if (error) invalid(error)
    write.put(DC_FPS_KEY, input.fps)
  }
  if (input.aspect !== undefined) {
    if (!isDirectorAspect(input.aspect)) invalid(`画幅不认识：${String(input.aspect)}（可选 ${DIRECTOR_ASPECTS.join(' / ')}）`)
    write.put(DC_ASPECT_KEY, input.aspect)
  }
  if (input.activeShot !== undefined) {
    if (input.activeShot === null) write.drop(DC_ACTIVE_SHOT_KEY)
    else write.put(DC_ACTIVE_SHOT_KEY, requireCamera(handle.scene, input.activeShot).id)
  }
  return finish(ctx, write, { objectIds: [] })
}

// —— 关键帧 ——

function keyframeValueIn(property: DirectorTrackProperty, value: unknown, what: string): DirectorKeyframeValue {
  switch (property) {
    case 'position':
      return vec3(value, `${what}（米）`)
    case 'rotation':
      return vec3(value, `${what}（度）`).map(degToRad) as Vec3
    case 'scale':
      return scaleInput(value, what)
    case 'fov':
      return num(value, `${what}（度）`)
  }
}

/** 某个对象某个属性所在通道上（同属性所有轨道）现有的关键帧，按 ms 索引 */
function channelKeyframes(scene: DirectorScene, objectId: string, property: DirectorTrackProperty): DirectorKeyframe[] {
  const trackIds = new Set(tracksOf(scene, objectId, property).map((track) => track.id))
  return [...scene.keyframes.values()].filter((keyframe) => trackIds.has(keyframe.trackId))
}

interface ChannelWrite {
  object: DirectorObject
  property: DirectorTrackProperty
  /** 毫秒 → 值（存储单位） */
  values: Map<number, DirectorKeyframeValue>
  interp?: DirectorInterpolation
  /** 先清掉这个时间窗里（含两端）原有的帧 */
  clear?: { from: number; to: number }
}

/** 把一个通道的写入摊进 write：规范轨道（没有就建）、同一毫秒已有帧就覆盖、清窗 */
function writeChannel(scene: DirectorScene, write: DirectorWrite, channel: ChannelWrite): DirectorKeyframeReport {
  const { object, property } = channel
  if (!trackPropertyAllowed(object.kind, property)) invalid(`fov 只能打在机位上（${object.name} 是 ${object.kind}）`)
  let track = canonicalTrack(scene, object.id, property)
  const createdTrack = track === null
  if (!track) {
    track = { id: createId(DC_TRACK_ID_PREFIX), objectId: object.id, property, interp: channel.interp ?? 'linear' }
    write.putTrack(track, object.kind)
  } else if (channel.interp !== undefined && channel.interp !== track.interp) {
    track = { ...track, interp: channel.interp }
    write.putTrack(track, object.kind)
  }
  const existing = channelKeyframes(scene, object.id, property)
  let replaced = 0
  if (channel.clear) {
    const { from, to } = channel.clear
    for (const keyframe of existing) {
      if (keyframe.t >= from && keyframe.t <= to) {
        write.drop(directorKeyframeKey(keyframe.id))
        replaced++
      }
    }
  }
  const atMs = new Map<number, DirectorKeyframe>()
  for (const keyframe of existing) {
    if (write.remove.has(directorKeyframeKey(keyframe.id))) continue
    const current = atMs.get(keyframe.t)
    if (!current || keyframe.id < current.id) atMs.set(keyframe.t, keyframe)
  }
  const ids: string[] = []
  const times = [...channel.values.keys()].sort((a, b) => a - b)
  for (const t of times) {
    const value = channel.values.get(t) as DirectorKeyframeValue
    const same = atMs.get(t)
    const keyframe: DirectorKeyframe = same
      ? { ...same, value }
      : { id: createId(DC_KEYFRAME_ID_PREFIX), trackId: track.id, t, value }
    write.putKeyframe(keyframe, property)
    ids.push(keyframe.id)
  }
  return {
    trackId: track.id,
    objectId: object.id,
    property,
    createdTrack,
    count: ids.length,
    replaced,
    start: msToSeconds(times[0] ?? 0),
    end: msToSeconds(times[times.length - 1] ?? 0),
    keyframeIds: ids,
  }
}

/** 在某个对象某个属性上增改关键帧（轨道不存在就一起建）；超出时长自动延长 */
export function setDirectorKeyframes(ctx: FlowOpContext, nodeId: string, input: DirectorKeyframesInput): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('关键帧参数必须是对象')
  const object = requireObject(handle.scene, input.objectId)
  const property = oneOf(input.property, DIRECTOR_TRACK_PROPERTIES, '属性')
  const interp = input.interp === undefined ? undefined : oneOf(input.interp, DIRECTOR_INTERPOLATIONS, '插值方式')
  const list = batch<{ t: number; value: Vec3Input | number }>(input.keyframes, '关键帧')
  const values = new Map<number, DirectorKeyframeValue>()
  for (const [index, keyframe] of list.entries()) {
    const what = `第 ${index + 1} 个关键帧`
    if (typeof keyframe !== 'object' || keyframe === null) invalid(`${what} 必须是 { t, value }`)
    const t = secondsToMs(num(keyframe.t, `${what} 的时刻（秒）`, 0, msToSeconds(DIRECTOR_LIMITS.durationMs)))
    if (values.has(t)) invalid(`${what} 和前面的帧落在同一时刻（${msToSeconds(t)} 秒；时刻精度 0.001 秒）`)
    values.set(t, keyframeValueIn(property, keyframe.value, `${what} 的值`))
  }
  const write = new DirectorWrite(nodeId, handle)
  const report = writeChannel(handle.scene, write, { object, property, values, interp })
  const warnings = rotationJumpWarnings(property, values)
  return finish(ctx, write, { objectIds: [object.id], atMs: secondsToMs(report.end), keyframes: [report], warnings })
}

/** 相邻两帧转角 ≥ 180° 时球面插值会走另一边的短弧 —— 提醒一声 */
function rotationJumpWarnings(property: DirectorTrackProperty, values: Map<number, DirectorKeyframeValue>): string[] {
  if (property !== 'rotation') return []
  const times = [...values.keys()].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 1; i < times.length; i++) {
    const a = values.get(times[i - 1]!) as Vec3
    const b = values.get(times[i]!) as Vec3
    if (Math.max(...vecSub(b, a).map(Math.abs)) >= Math.PI) {
      out.push(`${msToSeconds(times[i - 1]!)}s → ${msToSeconds(times[i]!)}s 之间转了 180° 以上，插值会走最短弧（反方向）；大角度请拆成多帧或用 animate_motion 的 turn`)
    }
  }
  return out
}

// —— 运动预设 ——

/** 缓动的反函数：进度 p（0–1）在第几成时间达到 */
function easeInverse(easing: DirectorEasing, p: number): number {
  switch (easing) {
    case 'linear':
      return p
    case 'ease-in':
      return Math.sqrt(p)
    case 'ease-out':
      return 1 - Math.sqrt(1 - p)
    case 'ease-in-out':
      // smoothstep 的反函数
      return 0.5 - Math.sin(Math.asin(1 - 2 * p) / 3)
  }
}

/** 段数：按每段最大步长切，非线性缓动至少 4 段，帧数不超过上限 */
function segmentCount(span: number, maxStep: number, easing: DirectorEasing): number {
  const wanted = Math.max(Math.ceil(span / maxStep), easing === 'linear' ? 1 : 4, 1)
  return Math.min(wanted, DIRECTOR_LIMITS.motionKeyframes - 1)
}

/** 运动预设：生成稀疏关键帧（orbit / move_along / turn / scale_to） */
export function animateDirectorMotion(ctx: FlowOpContext, nodeId: string, motion: DirectorMotionInput): DirectorWriteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof motion !== 'object' || motion === null) invalid('运动参数必须是对象')
  oneOf(motion.preset, ['orbit', 'move_along', 'turn', 'scale_to'] as const, '运动预设')
  const object = requireObject(handle.scene, motion.objectId)
  const easing = motion.easing === undefined ? 'linear' : oneOf(motion.easing, DIRECTOR_EASINGS, '缓动')
  const maxSeconds = msToSeconds(DIRECTOR_LIMITS.durationMs)
  const startMs = secondsToMs(motion.start === undefined ? 0 : num(motion.start, '开始时刻（秒）', 0, maxSeconds))
  const durationMs = secondsToMs(num(motion.duration, '持续时间（秒）', 0, maxSeconds))
  if (durationMs <= 0) invalid('持续时间必须大于 0')
  const endMs = startMs + durationMs
  if (endMs > DIRECTOR_LIMITS.durationMs) {
    throw new FlowOpError('DIRECTOR_LIMIT', `运动结束于 ${msToSeconds(endMs)} 秒，超过时长上限 ${maxSeconds} 秒`)
  }
  const start = objectStateAt(handle.timeline, object.id, startMs) as DirectorObjectState
  const warnings: string[] = []

  /** 进度 p 的帧落在哪一毫秒（缓动烘进时刻） */
  const timeAt = (p: number) => startMs + Math.round(durationMs * easeInverse(easing, Math.min(1, Math.max(0, p))))
  const channels: { property: DirectorTrackProperty; values: Map<number, DirectorKeyframeValue> }[] = []
  const sample = (property: DirectorTrackProperty, fractions: readonly number[], valueAt: (p: number) => DirectorKeyframeValue) => {
    const values = new Map<number, DirectorKeyframeValue>()
    // 同一毫秒只留最后一个（持续时间极短时相邻帧可能取整到一起）
    for (const p of fractions) values.set(timeAt(p), valueAt(p))
    channels.push({ property, values })
  }
  const uniform = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n)

  if (motion.preset === 'orbit') {
    const angle = degToRad(num(motion.angle, '转角（度）', -3600, 3600))
    if (angle === 0) invalid('转角不能是 0')
    let center: Vec3 = [0, 0, 0]
    if (motion.center !== undefined && motion.centerObjectId !== undefined) invalid('center 和 centerObjectId 只能给一个')
    if (motion.center !== undefined) center = vec3(motion.center, '中心', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
    if (motion.centerObjectId !== undefined) {
      const target = requireObject(handle.scene, motion.centerObjectId, '中心对象')
      if (target.id === object.id) invalid('不能绕自己转')
      center = objectBounds(target, objectStateAt(handle.timeline, target.id, startMs) as DirectorObjectState).center
    }
    const dx = start.position[0] - center[0]
    const dz = start.position[2] - center[2]
    const radius = motion.radius === undefined ? Math.hypot(dx, dz) : num(motion.radius, '半径（米）', 0.001, DIRECTOR_LIMITS.position)
    if (radius < 0.001) invalid('对象就在中心上方，推不出半径：请给 radius')
    const startAngle = motion.startAngle === undefined ? Math.atan2(dx, dz) : degToRad(num(motion.startAngle, '起始角度（度）'))
    const height = motion.height === undefined ? start.position[1] : num(motion.height, '高度（米）', -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position)
    const lookAt = motion.lookAt ?? object.kind === 'camera'
    if (lookAt && object.kind !== 'camera') invalid('lookAt 只能用在机位上')
    const n = segmentCount(Math.abs(angle), degToRad(15), easing)
    if (Math.abs(angle) / n > degToRad(15) + 1e-9) {
      warnings.push(`转角太大，每段 ${radToDeg(Math.abs(angle) / n).toFixed(1)}°（帧数上限 ${DIRECTOR_LIMITS.motionKeyframes}），轨迹是折线、会比圆弧略往里收`)
    }
    const positionAt = (p: number): Vec3 => {
      const theta = startAngle + angle * p
      return [center[0] + radius * Math.sin(theta), height, center[2] + radius * Math.cos(theta)]
    }
    const fractions = uniform(n)
    sample('position', fractions, positionAt)
    if (lookAt) sample('rotation', fractions, (p) => eulerFromMat3(cameraLookAt(positionAt(p), center)))
  } else if (motion.preset === 'move_along') {
    const points = batch<Vec3Input>(motion.points, '途经点').map((point, index) =>
      vec3(point, `第 ${index + 1} 个途经点`, -DIRECTOR_LIMITS.position, DIRECTOR_LIMITS.position),
    )
    const path: Vec3[] = [start.position, ...points]
    const lengths = [0]
    for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1]! + vecLength(vecSub(path[i]!, path[i - 1]!)))
    const total = lengths[lengths.length - 1]!
    if (total < 1e-6) invalid('途经点和当前位置重合，没有路程')
    const fractions = new Set(lengths.map((length) => length / total))
    // 非线性缓动：多切几刀，帧之间线性才贴得住缓动曲线
    if (easing !== 'linear') for (const p of uniform(4)) fractions.add(p)
    const sorted = [...fractions].sort((a, b) => a - b)
    if (sorted.length > DIRECTOR_LIMITS.motionKeyframes) invalid(`途经点太多（最多 ${DIRECTOR_LIMITS.motionKeyframes - 1} 个）`)
    sample('position', sorted, (p) => {
      const at = p * total
      let i = 1
      while (i < lengths.length - 1 && lengths[i]! < at) i++
      const l0 = lengths[i - 1]!
      const l1 = lengths[i]!
      return vecLerp(path[i - 1]!, path[i]!, l1 > l0 ? (at - l0) / (l1 - l0) : 1)
    })
  } else if (motion.preset === 'turn') {
    const axis = oneOf(motion.axis, ['x', 'y', 'z'] as const, '旋转轴')
    const degrees = num(motion.degrees, '转角（度）', -3600, 3600)
    if (degrees === 0) invalid('转角不能是 0')
    const space = motion.space === undefined ? 'world' : oneOf(motion.space, ['world', 'local'] as const, '旋转空间')
    // 相邻两帧不超过 90°：球面插值走最短弧，超过 180° 就反向了
    const n = segmentCount(Math.abs(degrees), 90, easing)
    sample('rotation', uniform(n), (p) => rotateEuler(start.rotation, axis, degToRad(degrees * p), space))
  } else {
    const target = scaleInput(motion.scale, '目标缩放')
    sample('scale', uniform(easing === 'linear' ? 1 : 4), (p) => vecLerp(start.scale, target, p))
  }

  const write = new DirectorWrite(nodeId, handle)
  const reports = channels.map(({ property, values }) =>
    writeChannel(handle.scene, write, { object, property, values, clear: { from: startMs, to: endMs } }),
  )
  for (const track of reports) {
    const interp = canonicalTrack(handle.scene, object.id, track.property)?.interp
    if (interp && interp !== 'linear') {
      warnings.push(`${track.property} 轨道的插值是 ${interp}，生成的帧之间会按 ${interp} 过渡（预设按 linear 设计）`)
    }
  }
  return finish(ctx, write, { objectIds: [object.id], atMs: endMs, keyframes: reports, warnings })
}

// —— 删除 ——

/** 删对象（连带它的轨道和关键帧）、轨道（连带它的关键帧）、关键帧。不存在的跳过，列在 `missing` 里 */
export function deleteDirectorElements(ctx: FlowOpContext, nodeId: string, input: DirectorDeleteInput): DirectorDeleteResult {
  const handle = openDirector(ctx, nodeId)
  if (typeof input !== 'object' || input === null) invalid('删除参数必须是对象')
  const { scene } = handle
  const listOf = (value: unknown, what: string): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value)) invalid(`${what} 必须是数组`)
    return value.map((id) => idString(id, what))
  }
  const objectIds = listOf(input.objectIds, 'objectIds')
  const trackIds = listOf(input.trackIds, 'trackIds')
  const keyframeIds = listOf(input.keyframeIds, 'keyframeIds')
  if (objectIds.length + trackIds.length + keyframeIds.length === 0) invalid('没有点名要删什么')

  const missing: string[] = []
  const objects = new Set<string>()
  const tracks = new Set<string>()
  const keyframes = new Set<string>()
  // 读不懂的元素也能按 id 删（它们照样占上限），所以按键判存在，不只看读出来的 scene
  const has = (key: string) => key in handle.data
  const collect = (ids: readonly string[], keyOf: (id: string) => string, into: Set<string>) => {
    for (const id of ids) {
      if (has(keyOf(id))) into.add(id)
      else missing.push(id)
    }
  }
  collect(objectIds, directorObjectKey, objects)
  collect(trackIds, directorTrackKey, tracks)
  collect(keyframeIds, directorKeyframeKey, keyframes)
  for (const track of scene.tracks.values()) if (objects.has(track.objectId)) tracks.add(track.id)
  for (const keyframe of scene.keyframes.values()) if (tracks.has(keyframe.trackId)) keyframes.add(keyframe.id)

  const write = new DirectorWrite(nodeId, handle)
  for (const id of objects) write.drop(directorObjectKey(id))
  for (const id of tracks) write.drop(directorTrackKey(id))
  for (const id of keyframes) write.drop(directorKeyframeKey(id))
  if (scene.activeShot && objects.has(scene.activeShot)) write.drop(DC_ACTIVE_SHOT_KEY)

  // 受影响但还在的对象（删了它的轨道 / 关键帧）
  const touched = new Set<string>()
  for (const id of tracks) {
    const objectId = scene.tracks.get(id)?.objectId
    if (objectId && !objects.has(objectId)) touched.add(objectId)
  }
  for (const id of keyframes) {
    const objectId = scene.tracks.get(scene.keyframes.get(id)?.trackId ?? '')?.objectId
    if (objectId && !objects.has(objectId)) touched.add(objectId)
  }
  const result = finish(ctx, write, { objectIds: touched })
  return {
    ...result,
    deleted: { objects: [...objects], tracks: [...tracks], keyframes: [...keyframes] },
    missing,
  }
}
