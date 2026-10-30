import { collectionKey, collectionKeys, readCollection } from './flow-collection.ts'

/**
 * 导演台节点的数据在 `data` 里长什么样（docs/07 §7.2）—— 键、类型、读时 / 写入校验、上限、单位。
 *
 * 场景和时间轴都按「平铺分键」（`flow-collection.ts`，docs/13 §3.7.1）摊在导演台节点的 `data` 上：
 *
 * ```
 * dc.duration     number  时长，毫秒（默认 5000）
 * dc.fps          number  帧率（默认 30）
 * dc.aspect       string  画幅（'21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | 'auto'，默认 '16:9'）
 * dc.activeShot   string  当前机位的对象 id（没有就不存这个键）
 * dc.obj.<id>     DirectorObjectValue    对象
 * dc.track.<id>   DirectorTrackValue     轨道
 * dc.kf.<id>      DirectorKeyframeValue  关键帧
 * ```
 *
 * 值都是普通 JSON；**id 只在键上，不在值里**（`dc.obj.<id>` 的 `<id>` 就是对象 id），免得两处对不上。
 *
 * ## 坐标与几何约定（和 three.js 一致，前端投影直接照搬）
 *
 * - 右手系，Y 朝上，地面是 y = 0。单位米。
 * - `position` 是对象**几何中心**的世界坐标；`rotation` 是欧拉角，**弧度**，顺序 XYZ（three 的默认 `Euler.order`）；
 *   `scale` 是三个轴的缩放倍数。没有嵌套（`parentId` 预留不支持），所以这三项就是世界变换。
 * - 几何体都以几何中心为原点、高沿本地 Y 轴：
 *   - `box { width, height, depth }` = `BoxGeometry(width, height, depth)`（X / Y / Z）；
 *   - `sphere { radius }` = `SphereGeometry(radius)`；
 *   - `cone { radius, height }` = `ConeGeometry(radius, height)`：底面在 y = -height/2，尖在 y = +height/2；
 *   - `cylinder { radius, height }` = `CylinderGeometry(radius, radius, height)`；
 *   - `plane { width, depth }`：**水平铺在本地 XZ 面上、法线朝 +Y、没有厚度** —— 前端要用
 *     `PlaneGeometry(width, depth).rotateX(-Math.PI / 2)`（three 的 PlaneGeometry 原本立在 XY 面上）。
 * - 机位 `camera { fov, near, far }` = `PerspectiveCamera(fov, aspect, near, far)`：`fov` 是**竖直**视场角，
 *   **度**（和 three 一样，fov 不换弧度），朝本地 -Z 看、本地 +Y 朝上；画幅取 `dc.aspect`。
 * - 灯光 `light { type, intensity, color }`；机位和灯光都没有体积，测量时按一个点算。
 *
 * ## 读和写是两套校验
 *
 * - **读**（{@link readDirectorScene}）：数据来自 Y.Doc，可能是别的客户端、别的版本写的 —— 读不懂的元素
 *   **跳过**（记进 `skipped`），缺了的可选部分补默认值，**从不抛**；只要求类型对、数是有限数。
 * - **写**（`validate*`）：输入不可信（模型的参数、脚本的产出），按范围严格校验；返回错误原因，`null` 表示通过。
 *   导演台的写操作（`director-ops.ts`）在写第一笔之前把要写的每个值都过一遍。
 */

// —— 键 ——

export const DIRECTOR_NODE_TYPE = 'director'

export const DC_OBJECT_PREFIX = 'dc.obj'
export const DC_TRACK_PREFIX = 'dc.track'
export const DC_KEYFRAME_PREFIX = 'dc.kf'
export const DC_DURATION_KEY = 'dc.duration'
export const DC_FPS_KEY = 'dc.fps'
export const DC_ASPECT_KEY = 'dc.aspect'
export const DC_ACTIVE_SHOT_KEY = 'dc.activeShot'

/** `createId()` 的前缀（只为看数据时认得出，读的地方不解析它） */
export const DC_OBJECT_ID_PREFIX = 'obj'
export const DC_TRACK_ID_PREFIX = 'trk'
export const DC_KEYFRAME_ID_PREFIX = 'kf'

export function directorObjectKey(id: string): string {
  return collectionKey(DC_OBJECT_PREFIX, id)
}
export function directorTrackKey(id: string): string {
  return collectionKey(DC_TRACK_PREFIX, id)
}
export function directorKeyframeKey(id: string): string {
  return collectionKey(DC_KEYFRAME_PREFIX, id)
}

// —— 默认值与上限 ——

export const DEFAULT_DIRECTOR_DURATION_MS = 5000
export const DEFAULT_DIRECTOR_FPS = 30
export const DEFAULT_DIRECTOR_ASPECT: DirectorAspect = '16:9'

/**
 * 上限（暂定，docs/07 §7.2；编辑器和 agent 同一份）。对象 / 轨道 / 关键帧数按 `data` 上的**键数**算
 * （读不懂、被跳过的元素照样占地方）。
 */
export const DIRECTOR_LIMITS = {
  objects: 200,
  tracks: 400,
  keyframes: 2000,
  /** 单个操作写进 `data` 的值，JSON 序列化后的 UTF-8 字节数（单条协同消息上限 1MB） */
  transactionBytes: 512 * 1024,
  /** 批量参数每次最多几项（docs/07 §7.3.1） */
  batch: 20,
  /** 一次运动预设（`animateDirectorMotion`）每条轨道最多生成几帧 —— 关键帧必须稀疏 */
  motionKeyframes: 49,
  /** 时长上限，毫秒（10 分钟） */
  durationMs: 600_000,
  /** 时长下限，毫秒 */
  minDurationMs: 100,
  fps: { min: 1, max: 120 },
  /** 坐标绝对值上限，米 */
  position: 1000,
  /** 欧拉角绝对值上限，弧度（= 3600°，留够多圈旋转的余量） */
  rotation: 20 * Math.PI,
  /** 缩放倍数的范围（不许为 0 或负 —— 镜像会让「底面」「顶面」的语义反过来） */
  scale: { min: 0.001, max: 1000 },
  /** 几何尺寸（半径 / 宽高深）的范围，米 */
  size: { min: 0.001, max: 1000 },
  /** 竖直视场角，度 */
  fov: { min: 1, max: 179 },
  near: { min: 0.001, max: 100 },
  far: { max: 100_000 },
  intensity: { min: 0, max: 1000 },
  name: 64,
} as const

// —— 类型 ——

export type Vec3 = [number, number, number]

export const DIRECTOR_OBJECT_KINDS = ['box', 'sphere', 'cone', 'cylinder', 'plane', 'camera', 'light'] as const
export type DirectorObjectKind = (typeof DIRECTOR_OBJECT_KINDS)[number]

/** 有几何体（能量尺寸、参与穿插 / 落地检查）的种类 */
export const DIRECTOR_SHAPE_KINDS = ['box', 'sphere', 'cone', 'cylinder', 'plane'] as const
export type DirectorShapeKind = (typeof DIRECTOR_SHAPE_KINDS)[number]

/** 种类的中文名（默认对象名用：「立方体1」） */
export const DIRECTOR_KIND_LABELS: Record<DirectorObjectKind, string> = {
  box: '立方体',
  sphere: '球体',
  cone: '圆锥',
  cylinder: '圆柱',
  plane: '平面',
  camera: '机位',
  light: '灯光',
}

export const DIRECTOR_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'auto'] as const
export type DirectorAspect = (typeof DIRECTOR_ASPECTS)[number]

export const DIRECTOR_TRACK_PROPERTIES = ['position', 'rotation', 'scale', 'fov'] as const
export type DirectorTrackProperty = (typeof DIRECTOR_TRACK_PROPERTIES)[number]

export const DIRECTOR_INTERPOLATIONS = ['linear', 'step', 'smooth'] as const
export type DirectorInterpolation = (typeof DIRECTOR_INTERPOLATIONS)[number]

export const DIRECTOR_LIGHT_TYPES = ['ambient', 'directional', 'point', 'spot'] as const
export type DirectorLightType = (typeof DIRECTOR_LIGHT_TYPES)[number]

export interface BoxGeometry {
  width: number
  height: number
  depth: number
}
export interface SphereGeometry {
  radius: number
}
/** 圆锥 / 圆柱 */
export interface RadialGeometry {
  radius: number
  height: number
}
/** 水平平面（XZ 面，见文件头的约定） */
export interface PlaneGeometry {
  width: number
  depth: number
}

/** 表面材质。都可选 —— 没给的由渲染端（`useDirectorShapeMaterial`）定 */
export interface DirectorMaterial {
  /** `#rrggbb` */
  color?: string
  /** 0–1 */
  opacity?: number
  /** 0–1 */
  roughness?: number
  /** 0–1 */
  metalness?: number
}

export interface DirectorCamera {
  /** 竖直视场角，度 */
  fov: number
  near: number
  far: number
}

export interface DirectorLight {
  type: DirectorLightType
  intensity: number
  /** `#rrggbb` */
  color: string
}

interface DirectorObjectCommon {
  /** 来自键（`dc.obj.<id>`），不存在值里 */
  id: string
  name: string
  /** 预留：本期不支持嵌套，写入时拒绝；读到了原样保留、计算时忽略 */
  parentId?: string
  /** 几何中心的世界坐标，米 */
  position: Vec3
  /** 欧拉角 XYZ，弧度 */
  rotation: Vec3
  scale: Vec3
}

/** 读出来的一个对象（可选部分已补默认值）。按 `kind` 区分带哪一组参数 */
export type DirectorObject =
  | (DirectorObjectCommon & { kind: 'box'; geometry: BoxGeometry; material?: DirectorMaterial })
  | (DirectorObjectCommon & { kind: 'sphere'; geometry: SphereGeometry; material?: DirectorMaterial })
  | (DirectorObjectCommon & { kind: 'cone'; geometry: RadialGeometry; material?: DirectorMaterial })
  | (DirectorObjectCommon & { kind: 'cylinder'; geometry: RadialGeometry; material?: DirectorMaterial })
  | (DirectorObjectCommon & { kind: 'plane'; geometry: PlaneGeometry; material?: DirectorMaterial })
  | (DirectorObjectCommon & { kind: 'camera'; camera: DirectorCamera })
  | (DirectorObjectCommon & { kind: 'light'; light: DirectorLight })

export type DirectorShapeObject = Extract<DirectorObject, { kind: DirectorShapeKind }>

/** 存进 `dc.obj.<id>` 的值 = 对象去掉 id */
export type DirectorObjectValue = DistributiveOmit<DirectorObject, 'id'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export interface DirectorTrack {
  /** 来自键（`dc.track.<id>`） */
  id: string
  objectId: string
  property: DirectorTrackProperty
  interp: DirectorInterpolation
}
export type DirectorTrackValue = Omit<DirectorTrack, 'id'>

/** 关键帧的值：position / scale 是 `[x, y, z]`，rotation 是欧拉角 `[x, y, z]`（弧度），fov 是一个数（度） */
export type DirectorKeyframeValue = Vec3 | number

export interface DirectorKeyframe {
  /** 来自键（`dc.kf.<id>`） */
  id: string
  trackId: string
  /** 毫秒，整数 */
  t: number
  value: DirectorKeyframeValue
}
export type DirectorKeyframeStored = Omit<DirectorKeyframe, 'id'>

/** 读出来的整个导演台 */
export interface DirectorScene {
  /** 毫秒 */
  duration: number
  fps: number
  aspect: DirectorAspect
  activeShot: string | null
  objects: Map<string, DirectorObject>
  tracks: Map<string, DirectorTrack>
  keyframes: Map<string, DirectorKeyframe>
  /** 读不懂、被跳过的 `dc.*` 键（别的版本写的、坏的） */
  skipped: string[]
}

// —— 单位 ——

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}
export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI
}
/** 秒 → 毫秒（四舍五入成整数：关键帧的 `t` 是毫秒整数） */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000)
}
export function msToSeconds(ms: number): number {
  return ms / 1000
}
export function vec3DegToRad(v: Readonly<Vec3>): Vec3 {
  return [degToRad(v[0]), degToRad(v[1]), degToRad(v[2])]
}
export function vec3RadToDeg(v: Readonly<Vec3>): Vec3 {
  return [radToDeg(v[0]), radToDeg(v[1]), radToDeg(v[2])]
}

/** 画幅 → 宽高比。`auto`（不显示取景框）测量时按 16:9 算 */
export function aspectRatioOf(aspect: DirectorAspect): number {
  if (aspect === 'auto') return 16 / 9
  const [w, h] = aspect.split(':').map(Number)
  return (w ?? 16) / (h ?? 9)
}

// —— 默认值 ——

export function isDirectorObjectKind(value: unknown): value is DirectorObjectKind {
  return typeof value === 'string' && (DIRECTOR_OBJECT_KINDS as readonly string[]).includes(value)
}
export function isDirectorShapeKind(value: unknown): value is DirectorShapeKind {
  return typeof value === 'string' && (DIRECTOR_SHAPE_KINDS as readonly string[]).includes(value)
}
export function isDirectorShape(object: DirectorObject): object is DirectorShapeObject {
  return isDirectorShapeKind(object.kind)
}

export const DEFAULT_DIRECTOR_CAMERA: Readonly<DirectorCamera> = { fov: 50, near: 0.1, far: 2000 }
export const DEFAULT_DIRECTOR_LIGHT: Readonly<DirectorLight> = { type: 'point', intensity: 1, color: '#ffffff' }

/** 各种几何体的默认尺寸 */
export function defaultGeometry(kind: 'box'): BoxGeometry
export function defaultGeometry(kind: 'sphere'): SphereGeometry
export function defaultGeometry(kind: 'cone' | 'cylinder'): RadialGeometry
export function defaultGeometry(kind: 'plane'): PlaneGeometry
export function defaultGeometry(kind: DirectorShapeKind): BoxGeometry | SphereGeometry | RadialGeometry | PlaneGeometry
export function defaultGeometry(kind: DirectorShapeKind): BoxGeometry | SphereGeometry | RadialGeometry | PlaneGeometry {
  switch (kind) {
    case 'box':
      return { width: 1, height: 1, depth: 1 }
    case 'sphere':
      return { radius: 0.5 }
    case 'cone':
    case 'cylinder':
      return { radius: 0.5, height: 1 }
    case 'plane':
      return { width: 10, depth: 10 }
  }
}

/** 某种几何体有哪些尺寸字段 */
export const GEOMETRY_FIELDS: Record<DirectorShapeKind, readonly string[]> = {
  box: ['width', 'height', 'depth'],
  sphere: ['radius'],
  cone: ['radius', 'height'],
  cylinder: ['radius', 'height'],
  plane: ['width', 'depth'],
}

/** 这个属性能不能打在这种对象上（fov 只给机位） */
export function trackPropertyAllowed(kind: DirectorObjectKind, property: DirectorTrackProperty): boolean {
  return property === 'fov' ? kind === 'camera' : true
}

// —— 读（宽松：跳过读不懂的，从不抛）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function readVec3(value: unknown, fallback: Vec3): Vec3 | null {
  if (value === undefined) return [...fallback]
  return isVec3(value) ? [value[0], value[1], value[2]] : null
}

/** 几何参数：缺了用默认值，有但不是正的有限数 → 整个对象读不懂 */
function readGeometry(kind: DirectorShapeKind, value: unknown): Record<string, number> | null {
  const base = defaultGeometry(kind) as unknown as Record<string, number>
  if (value === undefined) return { ...base }
  if (!isRecord(value)) return null
  const out: Record<string, number> = {}
  for (const field of GEOMETRY_FIELDS[kind]) {
    const raw = value[field]
    if (raw === undefined) out[field] = base[field] ?? 1
    else if (isFiniteNumber(raw) && raw > 0) out[field] = raw
    else return null
  }
  return out
}

/** 材质只取认得、合法的字段；一个都没有就当没有 */
function readMaterial(value: unknown): DirectorMaterial | undefined {
  if (!isRecord(value)) return undefined
  const out: DirectorMaterial = {}
  if (typeof value.color === 'string' && COLOR_PATTERN.test(value.color)) out.color = value.color
  for (const field of ['opacity', 'roughness', 'metalness'] as const) {
    const raw = value[field]
    if (isFiniteNumber(raw) && raw >= 0 && raw <= 1) out[field] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readCamera(value: unknown): DirectorCamera | null {
  if (value === undefined) return { ...DEFAULT_DIRECTOR_CAMERA }
  if (!isRecord(value)) return null
  const fov = value.fov ?? DEFAULT_DIRECTOR_CAMERA.fov
  const near = value.near ?? DEFAULT_DIRECTOR_CAMERA.near
  const far = value.far ?? DEFAULT_DIRECTOR_CAMERA.far
  if (!isFiniteNumber(fov) || fov <= 0 || fov >= 180) return null
  if (!isFiniteNumber(near) || near <= 0 || !isFiniteNumber(far) || far <= near) return null
  return { fov, near, far }
}

function readLight(value: unknown): DirectorLight | null {
  if (value === undefined) return { ...DEFAULT_DIRECTOR_LIGHT }
  if (!isRecord(value)) return null
  const type = value.type ?? DEFAULT_DIRECTOR_LIGHT.type
  const intensity = value.intensity ?? DEFAULT_DIRECTOR_LIGHT.intensity
  const color = value.color ?? DEFAULT_DIRECTOR_LIGHT.color
  if (typeof type !== 'string' || !(DIRECTOR_LIGHT_TYPES as readonly string[]).includes(type)) return null
  if (!isFiniteNumber(intensity) || intensity < 0) return null
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) return null
  return { type: type as DirectorLightType, intensity, color }
}

/**
 * 读一个对象的值。读不懂（未知 / 预留的 kind、坐标不是三个有限数、几何参数坏了）返回 null。
 * 缺了的可选部分补默认值：rotation `[0,0,0]`、scale `[1,1,1]`、几何体 / 机位 / 灯光的默认参数。
 */
export function parseDirectorObject(id: string, value: unknown): DirectorObject | null {
  if (!isRecord(value) || !isDirectorObjectKind(value.kind)) return null
  const position = readVec3(value.position, [0, 0, 0])
  const rotation = readVec3(value.rotation, [0, 0, 0])
  const scale = readVec3(value.scale, [1, 1, 1])
  if (!position || !rotation || !scale) return null
  const common: DirectorObjectCommon = {
    id,
    name: typeof value.name === 'string' ? value.name : '',
    position,
    rotation,
    scale,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
  }
  const kind = value.kind
  if (kind === 'camera') {
    const camera = readCamera(value.camera)
    return camera ? { ...common, kind, camera } : null
  }
  if (kind === 'light') {
    const light = readLight(value.light)
    return light ? { ...common, kind, light } : null
  }
  const geometry = readGeometry(kind, value.geometry)
  if (!geometry) return null
  const material = readMaterial(value.material)
  return { ...common, kind, geometry, ...(material ? { material } : {}) } as unknown as DirectorObject
}

export function parseDirectorTrack(id: string, value: unknown): DirectorTrack | null {
  if (!isRecord(value)) return null
  const { objectId, property } = value
  const interp = value.interp ?? 'linear'
  if (typeof objectId !== 'string' || !objectId) return null
  if (typeof property !== 'string' || !(DIRECTOR_TRACK_PROPERTIES as readonly string[]).includes(property)) return null
  if (typeof interp !== 'string' || !(DIRECTOR_INTERPOLATIONS as readonly string[]).includes(interp)) return null
  return {
    id,
    objectId,
    property: property as DirectorTrackProperty,
    interp: interp as DirectorInterpolation,
  }
}

/** 关键帧的值只看形状（三个有限数或一个有限数）；和轨道属性对不对得上由求值时判 */
export function parseDirectorKeyframe(id: string, value: unknown): DirectorKeyframe | null {
  if (!isRecord(value)) return null
  const { trackId, t } = value
  if (typeof trackId !== 'string' || !trackId) return null
  if (!isFiniteNumber(t) || t < 0) return null
  const raw = value.value
  let parsed: DirectorKeyframeValue
  if (isFiniteNumber(raw)) parsed = raw
  else if (isVec3(raw)) parsed = [raw[0], raw[1], raw[2]]
  else return null
  return { id, trackId, t: Math.round(t), value: parsed }
}

/**
 * 把导演台节点的 `data`（`fromYNode(...).data`，或投影里的 `data`）读成场景。
 *
 * 从不抛：读不懂的元素跳过并记进 `skipped`；标量键坏了用默认值。不检查引用（轨道指向的对象可能被别人删了），
 * 悬空的轨道 / 关键帧照样在结果里，求值（`director-eval`）时忽略。
 */
export function readDirectorScene(data: Readonly<Record<string, unknown>>): DirectorScene {
  const skipped: string[] = []
  const objects = new Map<string, DirectorObject>()
  for (const [id, value] of readCollection(data, DC_OBJECT_PREFIX)) {
    const object = parseDirectorObject(id, value)
    if (object) objects.set(id, object)
    else skipped.push(directorObjectKey(id))
  }
  const tracks = new Map<string, DirectorTrack>()
  for (const [id, value] of readCollection(data, DC_TRACK_PREFIX)) {
    const track = parseDirectorTrack(id, value)
    if (track) tracks.set(id, track)
    else skipped.push(directorTrackKey(id))
  }
  const keyframes = new Map<string, DirectorKeyframe>()
  for (const [id, value] of readCollection(data, DC_KEYFRAME_PREFIX)) {
    const keyframe = parseDirectorKeyframe(id, value)
    if (keyframe) keyframes.set(id, keyframe)
    else skipped.push(directorKeyframeKey(id))
  }

  const rawDuration = data[DC_DURATION_KEY]
  const rawFps = data[DC_FPS_KEY]
  const rawAspect = data[DC_ASPECT_KEY]
  const rawShot = data[DC_ACTIVE_SHOT_KEY]
  return {
    duration: isFiniteNumber(rawDuration) && rawDuration > 0 ? rawDuration : DEFAULT_DIRECTOR_DURATION_MS,
    fps: isFiniteNumber(rawFps) && rawFps > 0 ? rawFps : DEFAULT_DIRECTOR_FPS,
    aspect:
      typeof rawAspect === 'string' && (DIRECTOR_ASPECTS as readonly string[]).includes(rawAspect)
        ? (rawAspect as DirectorAspect)
        : DEFAULT_DIRECTOR_ASPECT,
    activeShot: typeof rawShot === 'string' && rawShot ? rawShot : null,
    objects,
    tracks,
    keyframes,
    skipped,
  }
}

/** `data` 上各类元素的键数（含读不懂的）—— 上限按它算 */
export function directorElementCounts(data: Readonly<Record<string, unknown>>): {
  objects: number
  tracks: number
  keyframes: number
} {
  return {
    objects: collectionKeys(data, DC_OBJECT_PREFIX).length,
    tracks: collectionKeys(data, DC_TRACK_PREFIX).length,
    keyframes: collectionKeys(data, DC_KEYFRAME_PREFIX).length,
  }
}

// —— 写（严格：不可信输入，按范围校验；返回原因，null = 通过）——

/**
 * 报错里数值用什么单位说。`storage`（默认）：存储单位（弧度、毫秒）—— 读时校验、直接面向存储的调用；
 * `caller`：面向调用方（度、秒）—— ops 把入参换算成存储单位再校验时用，报错里的范围和实际值换回度 / 秒。
 */
export type DirectorErrorUnits = 'storage' | 'caller'

/** 去掉换算带出的浮点尾巴（20π 弧度 → 3600 而不是 3600.0000000000005） */
function tidy(value: number): number {
  return Number(value.toFixed(6))
}

interface NumberUnit {
  /** 范围与实际值展示前的换算 */
  show: (value: number) => number
}

const SHOW_RAW: NumberUnit = { show: (v) => v }
const SHOW_DEG: NumberUnit = { show: (v) => tidy(radToDeg(v)) }
const SHOW_SEC: NumberUnit = { show: (v) => tidy(msToSeconds(v)) }

function checkNumber(value: unknown, what: string, min: number, max: number, unit: NumberUnit = SHOW_RAW): string | null {
  if (!isFiniteNumber(value)) return `${what} 必须是有限数`
  if (value < min || value > max) {
    return `${what} 超出范围 [${unit.show(min)}, ${unit.show(max)}]（实际 ${unit.show(value)}）`
  }
  return null
}

function checkVec3(value: unknown, what: string, min: number, max: number, unit: NumberUnit = SHOW_RAW): string | null {
  if (!Array.isArray(value) || value.length !== 3) return `${what} 必须是三个数 [x, y, z]`
  for (const [index, item] of value.entries()) {
    const error = checkNumber(item, `${what}[${index}]`, min, max, unit)
    if (error) return error
  }
  return null
}

function checkColor(value: unknown, what: string): string | null {
  return typeof value === 'string' && COLOR_PATTERN.test(value) ? null : `${what} 必须是 #rrggbb 形式的颜色`
}

/** 校验一个将要写入的对象（存储单位：米、弧度、度）；`units: 'caller'` 时报错里的旋转用度 */
export function validateDirectorObject(object: DirectorObject, units: DirectorErrorUnits = 'storage'): string | null {
  const label = `对象 ${object.id || '(新)'}`
  if (!isDirectorObjectKind(object.kind)) return `${label} 的种类 ${String(object.kind)} 不认识（可选 ${DIRECTOR_OBJECT_KINDS.join(' / ')}）`
  if (typeof object.name !== 'string' || !object.name.trim()) return `${label} 的名字不能为空`
  if (object.name.length > DIRECTOR_LIMITS.name) return `${label} 的名字超过 ${DIRECTOR_LIMITS.name} 个字符`
  if (object.parentId !== undefined) return `${label}：本期不支持对象嵌套（parentId）`
  const L = DIRECTOR_LIMITS
  const errors = [
    checkVec3(object.position, `${label} 的 position`, -L.position, L.position),
    units === 'caller'
      ? checkVec3(object.rotation, `${label} 的 rotation（度）`, -L.rotation, L.rotation, SHOW_DEG)
      : checkVec3(object.rotation, `${label} 的 rotation（弧度）`, -L.rotation, L.rotation),
    checkVec3(object.scale, `${label} 的 scale`, L.scale.min, L.scale.max),
  ]
  if (object.kind === 'camera') {
    const camera = object.camera as unknown
    if (!isRecord(camera)) return `${label} 缺少机位参数`
    errors.push(
      checkNumber(camera.fov, `${label} 的 fov（度）`, L.fov.min, L.fov.max),
      checkNumber(camera.near, `${label} 的 near`, L.near.min, L.near.max),
      checkNumber(camera.far, `${label} 的 far`, L.near.min, L.far.max),
    )
    if (isFiniteNumber(camera.near) && isFiniteNumber(camera.far) && camera.far <= camera.near) {
      errors.push(`${label} 的 far 必须大于 near`)
    }
  } else if (object.kind === 'light') {
    const light = object.light as unknown
    if (!isRecord(light)) return `${label} 缺少灯光参数`
    if (typeof light.type !== 'string' || !(DIRECTOR_LIGHT_TYPES as readonly string[]).includes(light.type)) {
      errors.push(`${label} 的灯光类型不认识（可选 ${DIRECTOR_LIGHT_TYPES.join(' / ')}）`)
    }
    errors.push(
      checkNumber(light.intensity, `${label} 的灯光强度`, L.intensity.min, L.intensity.max),
      checkColor(light.color, `${label} 的灯光颜色`),
    )
  } else {
    const geometry = object.geometry as unknown
    if (!isRecord(geometry)) return `${label} 缺少几何参数`
    const fields = GEOMETRY_FIELDS[object.kind]
    for (const key of Object.keys(geometry)) {
      if (!fields.includes(key)) errors.push(`${label}（${object.kind}）没有几何参数 ${key}（可用 ${fields.join(' / ')}）`)
    }
    for (const field of fields) {
      errors.push(checkNumber(geometry[field], `${label} 的 ${field}（米）`, L.size.min, L.size.max))
    }
    const material = (object as { material?: unknown }).material
    if (material !== undefined) {
      if (!isRecord(material)) return `${label} 的材质必须是对象`
      for (const key of Object.keys(material)) {
        if (!['color', 'opacity', 'roughness', 'metalness'].includes(key)) {
          errors.push(`${label} 的材质没有 ${key} 这一项（可用 color / opacity / roughness / metalness）`)
        }
      }
      if (material.color !== undefined) errors.push(checkColor(material.color, `${label} 的颜色`))
      for (const field of ['opacity', 'roughness', 'metalness'] as const) {
        if (material[field] !== undefined) errors.push(checkNumber(material[field], `${label} 的 ${field}`, 0, 1))
      }
    }
  }
  return errors.find((error) => error !== null) ?? null
}

/** 校验一条将要写入的轨道；`kind` 是它所属对象的种类 */
export function validateDirectorTrack(track: DirectorTrack, kind: DirectorObjectKind): string | null {
  if (!(DIRECTOR_TRACK_PROPERTIES as readonly string[]).includes(track.property)) {
    return `属性 ${String(track.property)} 不能打关键帧（可选 ${DIRECTOR_TRACK_PROPERTIES.join(' / ')}）`
  }
  if (!trackPropertyAllowed(kind, track.property)) return `fov 只能打在机位上（对象 ${track.objectId} 是 ${kind}）`
  if (!(DIRECTOR_INTERPOLATIONS as readonly string[]).includes(track.interp)) {
    return `插值方式 ${String(track.interp)} 不认识（可选 ${DIRECTOR_INTERPOLATIONS.join(' / ')}）`
  }
  return null
}

/** 校验一个将要写入的关键帧（存储单位：毫秒、弧度、度）；`units: 'caller'` 时报错里的时刻用秒、旋转用度 */
export function validateDirectorKeyframe(
  keyframe: DirectorKeyframe,
  property: DirectorTrackProperty,
  units: DirectorErrorUnits = 'storage',
): string | null {
  const L = DIRECTOR_LIMITS
  const caller = units === 'caller'
  if (!Number.isInteger(keyframe.t)) {
    return caller ? `关键帧时刻必须是有限数（秒）` : `关键帧时间必须是整数毫秒（实际 ${keyframe.t}）`
  }
  const timeError = caller
    ? checkNumber(keyframe.t, '关键帧时刻（秒）', 0, L.durationMs, SHOW_SEC)
    : checkNumber(keyframe.t, '关键帧时间（毫秒）', 0, L.durationMs)
  if (timeError) return timeError
  const at = caller ? `${property} 在 ${tidy(msToSeconds(keyframe.t))}s 的关键帧` : `${property} 在 ${keyframe.t}ms 的关键帧`
  switch (property) {
    case 'position':
      return checkVec3(keyframe.value, at, -L.position, L.position)
    case 'rotation':
      return caller
        ? checkVec3(keyframe.value, `${at}（度）`, -L.rotation, L.rotation, SHOW_DEG)
        : checkVec3(keyframe.value, `${at}（弧度）`, -L.rotation, L.rotation)
    case 'scale':
      return checkVec3(keyframe.value, at, L.scale.min, L.scale.max)
    case 'fov':
      return checkNumber(keyframe.value, `${at}（度）`, L.fov.min, L.fov.max)
  }
}

/** 校验时长；`units: 'caller'` 时报错用秒（入参仍是毫秒整数） */
export function validateDirectorDuration(ms: number, units: DirectorErrorUnits = 'storage'): string | null {
  if (units === 'caller') {
    if (!isFiniteNumber(ms)) return '时长（秒） 必须是有限数'
    return checkNumber(ms, '时长（秒）', DIRECTOR_LIMITS.minDurationMs, DIRECTOR_LIMITS.durationMs, SHOW_SEC)
  }
  if (!Number.isInteger(ms)) return `时长必须是整数毫秒（实际 ${ms}）`
  return checkNumber(ms, '时长（毫秒）', DIRECTOR_LIMITS.minDurationMs, DIRECTOR_LIMITS.durationMs)
}

export function validateDirectorFps(fps: number): string | null {
  if (!Number.isInteger(fps)) return `帧率必须是整数（实际 ${fps}）`
  return checkNumber(fps, '帧率', DIRECTOR_LIMITS.fps.min, DIRECTOR_LIMITS.fps.max)
}

export function isDirectorAspect(value: unknown): value is DirectorAspect {
  return typeof value === 'string' && (DIRECTOR_ASPECTS as readonly string[]).includes(value)
}

// —— 编码（写进 data 的值）——

/** 对象 → 存储的值（去掉 id；数组、子对象都是新的，不和调用方共用引用） */
export function encodeDirectorObject(object: DirectorObject): DirectorObjectValue {
  const out: Record<string, unknown> = {
    kind: object.kind,
    name: object.name,
    position: [...object.position],
    rotation: [...object.rotation],
    scale: [...object.scale],
  }
  if (object.kind === 'camera') out.camera = { ...object.camera }
  else if (object.kind === 'light') out.light = { ...object.light }
  else {
    out.geometry = { ...object.geometry }
    if (object.material) out.material = { ...object.material }
  }
  return out as DirectorObjectValue
}

export function encodeDirectorTrack(track: DirectorTrack): DirectorTrackValue {
  return { objectId: track.objectId, property: track.property, interp: track.interp }
}

export function encodeDirectorKeyframe(keyframe: DirectorKeyframe): DirectorKeyframeStored {
  return {
    trackId: keyframe.trackId,
    t: keyframe.t,
    value: typeof keyframe.value === 'number' ? keyframe.value : [...keyframe.value],
  }
}

/**
 * 一批写入值 JSON 序列化后的 UTF-8 字节数（键 + 值）—— 单个事务体积上限（{@link DIRECTOR_LIMITS}.transactionBytes）
 * 按它估。shared 的 lib 只有 ES2020，没有 `TextEncoder`，这里手算。
 */
export function serializedBytes(entries: Readonly<Record<string, unknown>>): number {
  let total = 0
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    total += utf8Length(key) + utf8Length(JSON.stringify(value) ?? '')
  }
  return total
}

function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个码点 4 字节，跳过低位
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}
