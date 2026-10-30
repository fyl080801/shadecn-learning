import { StringEnum, Type } from '@mariozechner/pi-ai'
import * as Y from 'yjs'
import {
  DIRECTOR_ASPECTS,
  DIRECTOR_INTERPOLATIONS,
  DIRECTOR_LIGHT_TYPES,
  DIRECTOR_LIMITS,
  DIRECTOR_OBJECT_KINDS,
  DIRECTOR_TRACK_PROPERTIES,
  directorKeyframeKey,
  directorObjectKey,
  directorTrackKey,
  msToSeconds,
  secondsToMs,
  type DirectorScene,
} from '@shadecn/shared/director-doc'
import {
  boundsDistance,
  cameraView,
  checkScene,
  compileDirectorTimeline,
  measureObjects,
  type DirectorBounds,
  type DirectorCameraView,
  type DirectorTimeline,
} from '@shadecn/shared/director-eval'
import { nodeGroupMap } from '@shadecn/shared/flow-doc'
import * as ops from '@shadecn/shared/flow-ops'
import { FlowOpError, type FlowOpContext } from '@shadecn/shared/flow-ops'
import { TOOL_LIMITS, type CanvasTool, type CanvasToolDetails } from '../../tools.ts'
import type { SkillContext } from '../registry.ts'

/**
 * 导演台技能 `director` 的工具（docs/07 §7.3.1 写、§7.3.2 量）。和画布工具同一套规矩：
 *
 * 1. **写只走 `@shadecn/shared/flow-ops` 的导演台操作**，一次调用一个 `canvas.write` 事务；编辑器调的是同一份实现。
 *    这里不碰 Y.Map、不算几何 —— 相对位置、包围盒、关键帧都由 ops 算，工具只管参数、预算和给模型看的结果。
 * 2. **量只走 `@shadecn/shared/director-eval`**（`canvas.read`，不写）：前端播放和这里的测量是同一份插值，
 *    量出来的就是人播放到那一刻看到的。
 * 3. **面向模型的单位是米、度、秒**。ops 的入参出参本来就是这套单位；eval 的时间参数是毫秒，在这里换。
 * 4. **每个工具都带 `nodeId`**：点名画布上任意一个导演台节点都行 —— 没有会话范围（docs/20 §3.10.9），
 *    改哪个导演台由 agent 按用户的提及和画布内容决定；不存在 / 不是导演台由 ops 报错。
 * 5. 参数 schema 严格（枚举、范围、数组 ≤ {@link DIRECTOR_LIMITS}.batch）：网关按同一份 schema 再校验一次，
 *    ops 按 director-doc 再校验一次；有一项不合格整个拒绝、文档不变。
 * 6. `details.elementIds` 是 `<nodeId>/<data 键>`（docs/20 §3.4.1，例如 `n_1/dc.obj.obj_x`）；读 / 量的工具为空。
 */

// —— 限额与 schema 片段 ——

const L = DIRECTOR_LIMITS

/** 节点 / 导演台元素 id 的格式（和画布工具、提及格式同一个字符集；导演台的 id 由 `createId` 生成，落在这里面） */
const ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'
const ID_REGEX = new RegExp(ID_PATTERN)

/** 旋转角的绝对值上限，度（= director-doc 的 20π 弧度） */
const MAX_DEGREES = 3600
/** 时刻 / 时长的上限，秒 */
const MAX_SECONDS = msToSeconds(L.durationMs)
/** 给模型看的数值保留几位小数：0.1mm / 0.0001°，去掉浮点尾巴又不丢精度（验收要求 1mm） */
const DECIMALS = 1e4

const NodeId = Type.String({ pattern: ID_PATTERN, description: '导演台节点的 id（read_canvas / get_node 里 type 为 director 的节点）' })
const ElementId = (description: string) => Type.String({ pattern: ID_PATTERN, description })
const IdList = (description: string, options: { minItems?: number; maxItems?: number } = {}) =>
  Type.Array(ElementId('对象 id'), { minItems: options.minItems ?? 1, maxItems: options.maxItems ?? L.batch, description })

const Vec3 = (description: string, min: number, max: number) =>
  Type.Array(Type.Number({ minimum: min, maximum: max }), { minItems: 3, maxItems: 3, description })
const Position = (description: string) => Vec3(`${description}，[x, y, z] 米`, -L.position, L.position)
const Rotation = (description: string) => Vec3(`${description}，欧拉角 [x, y, z] 度（XYZ 顺序）`, -MAX_DEGREES, MAX_DEGREES)
const Scale = (description: string) =>
  Type.Union(
    [Type.Number({ minimum: L.scale.min, maximum: L.scale.max }), Vec3('[x, y, z] 三个轴的倍数', L.scale.min, L.scale.max)],
    { description: `${description}：一个数（等比）或 [x, y, z]，${L.scale.min}–${L.scale.max}` },
  )
const Meters = (description: string) => Type.Number({ minimum: -L.position, maximum: L.position, description })
const Size = (description: string) => Type.Number({ minimum: L.size.min, maximum: L.size.max, description })
const Seconds = (description: string) => Type.Number({ minimum: 0, maximum: MAX_SECONDS, description })
const Color = (description: string) => Type.String({ pattern: '^#[0-9a-fA-F]{6}$', description: `${description}，#rrggbb` })
const Axis = (description: string) => StringEnum(['x', 'y', 'z'] as const, { description })
const Space = StringEnum(['world', 'local'] as const, { description: '绕世界轴还是对象自己的本地轴（默认 world）' })
const Name = Type.String({ minLength: 1, maxLength: L.name, description: '对象名（给人看，也写进报告）' })

const Geometry = Type.Object(
  {
    width: Type.Optional(Size('宽（X），米：box / plane')),
    height: Type.Optional(Size('高（Y），米：box / cone / cylinder')),
    depth: Type.Optional(Size('深（Z），米：box / plane')),
    radius: Type.Optional(Size('半径，米：sphere / cone / cylinder')),
  },
  {
    additionalProperties: false,
    description: '几何尺寸（米）：box width/height/depth，sphere radius，cone / cylinder radius/height，plane width/depth（没有厚度）',
  },
)
const Material = Type.Object(
  {
    color: Type.Optional(Color('颜色')),
    opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: '不透明度 0–1' })),
    roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: '粗糙度 0–1' })),
    metalness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: '金属度 0–1' })),
  },
  { additionalProperties: false, description: '几何体的材质（只对 box / sphere / cone / cylinder / plane）' },
)
const Camera = Type.Object(
  {
    fov: Type.Optional(Type.Number({ minimum: L.fov.min, maximum: L.fov.max, description: '竖直视场角，度' })),
    near: Type.Optional(Type.Number({ minimum: L.near.min, maximum: L.near.max, description: '近裁剪面，米' })),
    far: Type.Optional(Type.Number({ minimum: L.near.min, maximum: L.far.max, description: '远裁剪面，米' })),
  },
  { additionalProperties: false, description: '机位参数（只对 camera）' },
)
const Light = Type.Object(
  {
    type: Type.Optional(StringEnum(DIRECTOR_LIGHT_TYPES, { description: '灯光类型' })),
    intensity: Type.Optional(Type.Number({ minimum: L.intensity.min, maximum: L.intensity.max, description: '强度' })),
    color: Type.Optional(Color('灯光颜色')),
  },
  { additionalProperties: false, description: '灯光参数（只对 light）' },
)

// —— 参数 ——

const getSceneParams = Type.Object(
  {
    nodeId: NodeId,
    objectIds: Type.Optional(
      IdList('只读这些对象（和它们的轨道、关键帧）；不给读全部', { maxItems: L.objects }),
    ),
    includeKeyframes: Type.Optional(Type.Boolean({ description: '要不要列出每条轨道的关键帧（默认 true；只关心对象时传 false 省篇幅）' })),
  },
  { additionalProperties: false },
)

const addObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    objects: Type.Array(
      Type.Object(
        {
          kind: StringEnum(DIRECTOR_OBJECT_KINDS, { description: '种类：box 立方体、sphere 球、cone 圆锥、cylinder 圆柱、plane 水平平面、camera 机位、light 灯光' }),
          name: Type.Optional(Name),
          position: Type.Optional(
            Position('几何中心的位置；不给时几何体放在原点并落地（底面 y = 0），机位 [0, 1.6, 6]，灯光 [3, 5, 3]'),
          ),
          rotation: Type.Optional(Rotation('朝向')),
          scale: Type.Optional(Scale('缩放')),
          geometry: Type.Optional(Geometry),
          color: Type.Optional(Color('颜色简写：几何体写进材质颜色，灯光写进灯光颜色')),
          material: Type.Optional(Material),
          camera: Type.Optional(Camera),
          light: Type.Optional(Light),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: L.batch, description: `要新建的对象，一次最多 ${L.batch} 个` },
    ),
  },
  { additionalProperties: false },
)

const transformObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    transforms: Type.Array(
      Type.Object(
        {
          id: ElementId('对象 id'),
          set: Type.Optional(
            Type.Object(
              { position: Type.Optional(Position('新位置')), rotation: Type.Optional(Rotation('新朝向')), scale: Type.Optional(Scale('新缩放')) },
              { additionalProperties: false, description: '绝对值' },
            ),
          ),
          by: Type.Optional(
            Type.Object(
              {
                translate: Type.Optional(Position('平移量')),
                rotate: Type.Optional(
                  Type.Object(
                    {
                      axis: Axis('绕哪个轴'),
                      degrees: Type.Number({ minimum: -MAX_DEGREES, maximum: MAX_DEGREES, description: '转多少度（右手定则，正 = 逆时针看向轴的负方向）' }),
                      space: Type.Optional(Space),
                    },
                    { additionalProperties: false },
                  ),
                ),
                scale: Type.Optional(Scale('缩放乘以这个倍数')),
              },
              { additionalProperties: false, description: '相对当前静态值，在 set 之后应用' },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: L.batch, description: `每个对象的变换（set 和 by 至少给一个），一次最多 ${L.batch} 个` },
    ),
  },
  { additionalProperties: false },
)

const SIDES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const
const PLACE_MODES = ['ground', 'on_top', 'beside', 'at'] as const

const placeObjectParams = Type.Object(
  {
    nodeId: NodeId,
    id: ElementId('要摆放的对象 id'),
    mode: StringEnum(PLACE_MODES, {
      description:
        'ground = 落到地面（底面 y = 0，水平位置不变）；on_top = 放到 target 顶上；beside = 贴在 target 的 side 一侧、留 gap 米；at = 放到 position（机位 / 灯光只能用 at）',
    }),
    target: Type.Optional(ElementId('参照对象 id（on_top / beside 必填）')),
    center: Type.Optional(Type.Boolean({ description: 'on_top：水平中心是否对齐 target（默认 true）' })),
    side: Type.Optional(StringEnum(SIDES, { description: 'beside：贴在 target 的哪一侧（+x / -x / +y / -y / +z / -z）' })),
    gap: Type.Optional(Meters('beside：中间留多少米（默认 0）')),
    position: Type.Optional(Position('at：目标坐标')),
    anchor: Type.Optional(StringEnum(['bottom', 'center'] as const, { description: 'at：bottom（默认）= 底面中心落在 position，center = 包围盒中心落在 position' })),
  },
  { additionalProperties: false },
)

const alignObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    ids: IdList(`要对齐的对象（给了 to 至少 1 个，否则至少 2 个；最多 ${L.batch} 个）`),
    axis: Axis('沿哪个轴对齐'),
    mode: StringEnum(['min', 'center', 'max'] as const, { description: '按包围盒的最小面、中心、最大面对齐' }),
    to: Type.Optional(ElementId('对齐到这个对象（它不动）；不给就对齐到这批对象整体的包围盒')),
  },
  { additionalProperties: false },
)

const distributeObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    ids: IdList(`要排开的对象（给了 gap 至少 2 个，否则至少 3 个；最多 ${L.batch} 个）`, { minItems: 2 }),
    axis: Axis('沿哪个轴排开（顺序按当前中心在这个轴上的位置）'),
    gap: Type.Optional(Meters('相邻包围盒之间留多少米：给了就第一个不动、后面依次排开；不给就首尾不动、中间等距')),
  },
  { additionalProperties: false },
)

const aimCameraParams = Type.Object(
  {
    nodeId: NodeId,
    cameraId: ElementId('机位（camera）的 id'),
    targetObjectId: Type.Optional(ElementId('对准这个对象的包围盒中心（只转不动）')),
    targetPoint: Type.Optional(Position('对准这个坐标（只转不动）')),
    fitObjectIds: Type.Optional(IdList('装下这些对象：对准它们整体的中心，并沿现在的方向前后挪到刚好装下的距离')),
    margin: Type.Optional(Type.Number({ minimum: 0, maximum: 0.45, description: 'fit：画面每一边留白占画面宽 / 高的比例（默认 0.05）' })),
    direction: Type.Optional(Vec3('fit：从目标指向机位的方向 [x, y, z]（不给沿机位现在的方向）', -L.position, L.position)),
  },
  { additionalProperties: false },
)

const updateObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    updates: Type.Array(
      Type.Object(
        {
          id: ElementId('对象 id'),
          name: Type.Optional(Name),
          color: Type.Optional(Color('颜色简写：几何体改材质颜色，灯光改灯光颜色')),
          material: Type.Optional(Material),
          geometry: Type.Optional(Geometry),
          camera: Type.Optional(Camera),
          light: Type.Optional(Light),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: L.batch, description: `要改的对象（只改给出的字段，和现有的合并），一次最多 ${L.batch} 个` },
    ),
  },
  { additionalProperties: false },
)

const settingsParams = Type.Object(
  {
    nodeId: NodeId,
    duration: Type.Optional(
      Type.Number({ minimum: msToSeconds(L.minDurationMs), maximum: MAX_SECONDS, description: '时长，秒（不能短于最后一个关键帧）' }),
    ),
    fps: Type.Optional(Type.Integer({ minimum: L.fps.min, maximum: L.fps.max, description: '帧率' })),
    aspect: Type.Optional(StringEnum(DIRECTOR_ASPECTS, { description: '画幅（auto 测量时按 16:9）' })),
    activeShot: Type.Optional(Type.Union([ElementId('机位 id'), Type.Null()], { description: '当前机位（camera 的 id）；null 清掉' })),
  },
  { additionalProperties: false },
)

const KeyframeValue = Type.Union([Type.Number(), Type.Array(Type.Number(), { minItems: 3, maxItems: 3 })], {
  description: 'position：[x, y, z] 米；rotation：欧拉角 [x, y, z] 度；scale：一个数或 [x, y, z] 倍；fov：度',
})

const setKeyframesParams = Type.Object(
  {
    nodeId: NodeId,
    objectId: ElementId('对象 id'),
    property: StringEnum(DIRECTOR_TRACK_PROPERTIES, { description: '属性：position / rotation / scale，fov 只有机位有' }),
    interp: Type.Optional(StringEnum(DIRECTOR_INTERPOLATIONS, { description: '这条轨道的插值：linear（默认）、step、smooth（每段 smoothstep）' })),
    keyframes: Type.Array(
      Type.Object({ t: Seconds('时刻，秒'), value: KeyframeValue }, { additionalProperties: false }),
      { minItems: 1, maxItems: L.batch, description: `要写的关键帧（同一时刻已有帧就覆盖），一次最多 ${L.batch} 个；只打关键时刻` },
    ),
  },
  { additionalProperties: false },
)

const MOTION_PRESETS = ['orbit', 'move_along', 'turn', 'scale_to'] as const
/** 每种预设能给哪些专属字段，第一个数组是必填的 */
const MOTION_FIELDS: Record<(typeof MOTION_PRESETS)[number], { required: readonly string[]; optional: readonly string[] }> = {
  orbit: { required: ['angle'], optional: ['center', 'centerObjectId', 'radius', 'startAngle', 'height', 'lookAt'] },
  move_along: { required: ['points'], optional: [] },
  turn: { required: ['axis', 'degrees'], optional: ['space'] },
  scale_to: { required: ['scale'], optional: [] },
}
const MOTION_SPECIFIC = [...new Set(Object.values(MOTION_FIELDS).flatMap((fields) => [...fields.required, ...fields.optional]))]

const animateMotionParams = Type.Object(
  {
    nodeId: NodeId,
    objectId: ElementId('对象 id'),
    preset: StringEnum(MOTION_PRESETS, {
      description:
        'orbit = 绕中心转（angle 度，从上往下看逆时针为正）；move_along = 依次经过 points；turn = 绕 axis 转 degrees 度（可超过 360）；scale_to = 缩放到 scale',
    }),
    start: Type.Optional(Seconds('开始时刻，秒（默认 0）')),
    duration: Type.Number({ minimum: 0.001, maximum: MAX_SECONDS, description: '持续多久，秒' }),
    easing: Type.Optional(StringEnum(['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const, { description: '缓动（默认 linear）' })),
    angle: Type.Optional(Type.Number({ minimum: -MAX_DEGREES, maximum: MAX_DEGREES, description: 'orbit：转多少度' })),
    center: Type.Optional(Position('orbit：绕哪个点转（和 centerObjectId 二选一，都不给是原点）')),
    centerObjectId: Type.Optional(ElementId('orbit：绕这个对象的包围盒中心转')),
    radius: Type.Optional(Type.Number({ minimum: 0.001, maximum: L.position, description: 'orbit：半径，米（不给从当前位置推出）' })),
    startAngle: Type.Optional(Type.Number({ minimum: -MAX_DEGREES, maximum: MAX_DEGREES, description: 'orbit：起始角度，度，0 在中心的 +Z 方向（不给从当前位置推出）' })),
    height: Type.Optional(Meters('orbit：高度 y，米（不给保持当前高度）')),
    lookAt: Type.Optional(Type.Boolean({ description: 'orbit：每一帧都对准中心（机位默认 true，只能用在机位上）' })),
    points: Type.Optional(
      Type.Array(Vec3('途经点 [x, y, z] 米', -L.position, L.position), {
        minItems: 1,
        maxItems: L.batch,
        description: `move_along：从当前位置依次经过的点，最多 ${L.batch} 个`,
      }),
    ),
    axis: Type.Optional(Axis('turn：绕哪个轴')),
    degrees: Type.Optional(Type.Number({ minimum: -MAX_DEGREES, maximum: MAX_DEGREES, description: 'turn：转多少度' })),
    space: Type.Optional(Space),
    scale: Type.Optional(Scale('scale_to：目标缩放')),
  },
  { additionalProperties: false },
)

const deleteParams = Type.Object(
  {
    nodeId: NodeId,
    objectIds: Type.Optional(IdList('要删的对象（连带它的轨道和关键帧）')),
    trackIds: Type.Optional(IdList('要删的轨道（连带它的关键帧）')),
    keyframeIds: Type.Optional(IdList('要删的关键帧')),
  },
  { additionalProperties: false },
)

const At = Type.Optional(Seconds('时刻，秒（默认 0）'))

const measureObjectsParams = Type.Object(
  {
    nodeId: NodeId,
    objectIds: Type.Optional(IdList('要量的对象；不给量全部', { maxItems: L.objects })),
    t: At,
  },
  { additionalProperties: false },
)

const measureDistanceParams = Type.Object(
  { nodeId: NodeId, a: ElementId('对象 A 的 id'), b: ElementId('对象 B 的 id'), t: At },
  { additionalProperties: false },
)

const checkSceneParams = Type.Object(
  {
    nodeId: NodeId,
    times: Type.Optional(
      Type.Array(Seconds('采样时刻，秒'), { minItems: 1, maxItems: L.batch, description: `在这些时刻检查（默认只查 0 秒），最多 ${L.batch} 个` }),
    ),
    tolerance: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: '容差，米（默认 0.001）：重叠 / 离地不超过它不算问题' })),
    cameraId: Type.Optional(Type.Union([ElementId('机位 id'), Type.Null()], { description: '检查哪个机位的画面；不给用当前机位，null 不查画面' })),
  },
  { additionalProperties: false },
)

const cameraViewParams = Type.Object(
  {
    nodeId: NodeId,
    cameraId: ElementId('机位（camera）的 id'),
    t: At,
    objectIds: Type.Optional(IdList('只看这些对象；不给看全部', { maxItems: L.objects })),
  },
  { additionalProperties: false },
)

/** 写导演台的工具 */
export const DIRECTOR_WRITE_TOOL_NAMES = [
  'add_objects',
  'transform_objects',
  'place_object',
  'align_objects',
  'distribute_objects',
  'aim_camera',
  'update_objects',
  'set_director_settings',
  'set_keyframes',
  'animate_motion',
  'delete_director_elements',
] as const

/** 只读的导演台工具（`canvas.read`，`flow:read`） */
export const DIRECTOR_READ_TOOL_NAMES = ['get_director_scene', 'measure_objects', 'measure_distance', 'check_scene', 'camera_view'] as const

// —— 小工具 ——

function result(value: unknown, details: CanvasToolDetails) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details }
}

/** 数值保留 4 位小数（深拷贝）：给模型看的 JSON 短一些，0.30000000000000004 这种尾巴也去掉 */
export function rounded<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? Math.round(value * DECIMALS) / DECIMALS + 0 : value) as T
  if (Array.isArray(value)) return value.map(rounded) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)])) as T
  }
  return value
}

function quote(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return `「${trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed}」`
}

function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !ID_REGEX.test(value)) {
    throw new Error(`${what} 不是合法的 id：${JSON.stringify(String(value).slice(0, 80))}`)
  }
}

/**
 * 跑导演台 ops，把 `FlowOpError` 转成给模型看的错误。ops 抛的时候文档一个字节没动（先校验后动手）。
 * 节点层面的两种错误补一句下一步该做什么；元素不存在的提示（先 get_director_scene）ops 自己带了。
 */
function directorOps<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (!(error instanceof FlowOpError)) throw error
    const hint =
      error.code === 'NODE_NOT_FOUND'
        ? '（可能已被删除），先 read_canvas 确认导演台节点的 id'
        : error.code === 'NOT_A_DIRECTOR'
          ? '：导演台工具只能用在 director 类型的节点上，先 read_canvas 确认 id'
          : ''
    throw new Error(`${error.message}${hint}`, { cause: error })
  }
}

function labelOf(ctx: FlowOpContext, nodeId: string): string {
  const node = ctx.nodes.get(nodeId)
  const label = node instanceof Y.Map ? nodeGroupMap(node as Y.Map<unknown>, 'metadata')?.get('label') : undefined
  return typeof label === 'string' && label ? label : nodeId
}

function elementIdsOf(nodeId: string, keys: readonly string[]): string[] {
  return [...new Set(keys)].map((key) => `${nodeId}/${key}`)
}

/** 点名的对象都得在（量的工具也不猜：不存在就让模型重新读） */
function assertObjectsExist(scene: DirectorScene, ids: readonly string[]): void {
  const missing = ids.filter((id) => !scene.objects.has(id))
  if (missing.length > 0) throw new Error(`这些对象不存在：${missing.join(', ')}；先 get_director_scene 重新读`)
}

function requireCameraIn(scene: DirectorScene, id: string): void {
  const object = scene.objects.get(id)
  if (!object) throw new Error(`机位 ${id} 不存在；先 get_director_scene 重新读`)
  if (object.kind !== 'camera') throw new Error(`${object.name}（${id}）是 ${object.kind}，不是机位`)
}

/** 包围盒给模型看的样子 */
function boundsView(bounds: DirectorBounds) {
  return {
    min: bounds.min,
    max: bounds.max,
    size: bounds.size,
    center: bounds.center,
    bottom: bounds.bottom,
    precision: bounds.precision,
  }
}

/** 写入结果精简成给模型看的 JSON：对象写入后的状态、关键帧摘要、时长、提醒 */
function writeView(res: ops.DirectorWriteResult) {
  return rounded({
    ...(res.objects.length > 0
      ? {
          at: res.at,
          objects: res.objects.map((object) => ({
            id: object.id,
            name: object.name,
            kind: object.kind,
            position: object.position,
            rotation: object.rotation,
            scale: object.scale,
            bounds: object.bounds,
            ...(object.animated.length > 0 ? { animated: object.animated } : {}),
            ...(object.camera ? { camera: object.camera } : {}),
          })),
        }
      : {}),
    ...(res.keyframes.length > 0
      ? {
          keyframes: res.keyframes.map((report) => ({
            trackId: report.trackId,
            objectId: report.objectId,
            property: report.property,
            ...(report.createdTrack ? { createdTrack: true } : {}),
            count: report.count,
            ...(report.replaced > 0 ? { replaced: report.replaced } : {}),
            start: report.start,
            end: report.end,
            keyframeIds: report.keyframeIds,
          })),
        }
      : {}),
    duration: res.duration.after,
    ...(res.duration.extended ? { durationExtended: { from: res.duration.before, to: res.duration.after } } : {}),
    warnings: res.warnings,
  })
}

function viewForModel(view: DirectorCameraView) {
  return rounded({
    cameraId: view.cameraId,
    t: msToSeconds(view.t),
    aspect: view.aspect,
    fov: view.fov,
    position: view.position,
    objects: view.objects.map((object) => ({
      id: object.id,
      name: object.name,
      kind: object.kind,
      status: object.status,
      rect: object.rect,
      coverage: object.coverage,
      visibleFraction: object.visibleFraction,
      distance: object.distance,
    })),
    note: view.note,
  })
}

function countBy<T extends string>(list: readonly { status: T }[], status: T): number {
  return list.filter((item) => item.status === status).length
}

// —— 工具 ——

/**
 * 导演台技能的全部工具。服务端拿真实画布造会执行的，runner 拿 `definitionContext` 造定义（一执行就报错）。
 * `ctx.runState` 是这一轮所有技能共用的那份：`delete_director_elements` 和 `delete_elements` / `ungroup` 花同一份删除预算。
 */
export function createDirectorTools(ctx: SkillContext): CanvasTool[] {
  const { canvas, runState } = ctx

  /** 每个工具的开头：nodeId 格式合法（存在、是导演台由 ops 判） */
  const guard = (nodeId: string) => {
    assertId(nodeId, 'nodeId')
  }

  /** 读：编好时间轴交给 fn（不写） */
  const readTimeline = <T>(nodeId: string, fn: (timeline: DirectorTimeline, label: string) => T): Promise<T> =>
    canvas.read((doc) =>
      directorOps(() => {
        const opCtx = ops.opContext(doc)
        const scene = ops.readDirector(opCtx, nodeId)
        return fn(compileDirectorTimeline(scene), labelOf(opCtx, nodeId))
      }),
    )

  /** 写：一次调用 = 一个 `canvas.write` 事务，里面只调 ops */
  const write = <T>(fn: (opCtx: FlowOpContext) => T): Promise<T> =>
    canvas.write((doc) => directorOps(() => fn(ops.opContext(doc))))

  /** 写工具的统一收尾 */
  const written = (nodeId: string, res: ops.DirectorWriteResult, summary: string, extra: Record<string, unknown> = {}) =>
    result({ ...writeView(res), ...rounded(extra) }, { summary, elementIds: elementIdsOf(nodeId, [...res.set, ...res.removed]) })

  const getScene: CanvasTool<typeof getSceneParams> = {
    name: 'get_director_scene',
    capability: 'flow:read',
    label: '读取导演台',
    description:
      '读一个导演台的场景：时长 / 帧率 / 画幅 / 当前机位，对象（种类、名字、位置米、旋转度、缩放、几何尺寸、材质、机位 / 灯光参数、哪些属性有关键帧），' +
      '轨道和关键帧（t 秒）。动手之前先读它拿到真实的 id。只关心几个对象时传 objectIds。',
    parameters: getSceneParams,
    executionMode: 'sequential',
    describe: (args) => `读取导演台 ${args.nodeId}`,
    async execute(_id, args) {
      guard(args.nodeId)
      if (args.objectIds) for (const id of args.objectIds) assertId(id, 'objectIds 里的对象')
      const out = await readTimeline(args.nodeId, (timeline, label) => {
        const { scene } = timeline
        if (args.objectIds) assertObjectsExist(scene, args.objectIds)
        const snapshot = ops.snapshotDirector(scene, args.objectIds ? { objectIds: args.objectIds } : {})
        const tracks =
          args.includeKeyframes === false
            ? snapshot.tracks.map(({ keyframes, ...track }) => ({ ...track, keyframeCount: keyframes.length }))
            : snapshot.tracks
        return {
          label,
          view: rounded({
            nodeId: args.nodeId,
            name: label,
            counts: { objects: scene.objects.size, tracks: scene.tracks.size, keyframes: scene.keyframes.size },
            ...snapshot,
            tracks,
            ...(snapshot.skipped.length === 0 ? { skipped: undefined } : {}),
          }),
        }
      })
      const counts = out.view.counts
      return result(out.view, {
        summary: `读取导演台${quote(out.label)}（${counts.objects} 个对象、${counts.tracks} 条轨道、${counts.keyframes} 个关键帧）`,
        elementIds: [],
      })
    },
  }

  const addObjects: CanvasTool<typeof addObjectsParams> = {
    name: 'add_objects',
    capability: 'flow:write',
    label: '新建对象',
    description:
      `在导演台里新建若干对象（几何体 / 机位 / 灯光），一次最多 ${L.batch} 个：种类、名字、几何尺寸（米）、位置、朝向（度）、缩放、颜色。` +
      '返回新对象的 id 和写入后的世界包围盒。摆在别的对象上 / 旁边请随后用 place_object，不要自己算坐标。',
    parameters: addObjectsParams,
    executionMode: 'sequential',
    describe: (args) => `新建 ${args.objects.length} 个对象`,
    async execute(_id, args) {
      guard(args.nodeId)
      const res = await write((opCtx) => ops.addDirectorObjects(opCtx, args.nodeId, args.objects))
      const names = res.objects.map((object) => object.name)
      return written(args.nodeId, res, `新建 ${res.objects.length} 个对象（${names.slice(0, 5).join('、')}${names.length > 5 ? '…' : ''}）`)
    },
  }

  const transformObjects: CanvasTool<typeof transformObjectsParams> = {
    name: 'transform_objects',
    capability: 'flow:write',
    label: '变换对象',
    description:
      `改对象的位置 / 旋转 / 缩放（静态值），一次最多 ${L.batch} 个：set 给绝对值（米、度），by 相对当前值（平移若干米、绕某轴转若干度、缩放乘若干倍），` +
      '两者都给时先 set 再 by。属性有关键帧时改的静态值播放时会被覆盖（结果里有提醒），改动画用 set_keyframes。',
    parameters: transformObjectsParams,
    executionMode: 'sequential',
    describe: (args) => `变换 ${args.transforms.length} 个对象`,
    async execute(_id, args) {
      guard(args.nodeId)
      for (const item of args.transforms) assertId(item.id, '对象 id')
      const res = await write((opCtx) => ops.transformDirectorObjects(opCtx, args.nodeId, args.transforms))
      return written(args.nodeId, res, `变换 ${res.objects.length} 个对象`)
    },
  }

  const placeObject: CanvasTool<typeof placeObjectParams> = {
    name: 'place_object',
    capability: 'flow:write',
    label: '摆放对象',
    description:
      '约束式摆放一个对象，坐标由服务端按包围盒算（只平移，不改旋转 / 缩放，按 0 秒的状态）：ground 落地；on_top 放到 target 顶上（默认水平居中）；' +
      'beside 贴在 target 的某一侧并留 gap 米；at 把底面中心（或包围盒中心）放到某个坐标。返回写入后的包围盒。',
    parameters: placeObjectParams,
    executionMode: 'sequential',
    describe: (args) => `摆放对象 ${args.id}（${args.mode}）`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.id, '对象 id')
      const given = (['target', 'center', 'side', 'gap', 'position', 'anchor'] as const).filter((key) => args[key] !== undefined)
      const allowed: Record<(typeof PLACE_MODES)[number], readonly string[]> = {
        ground: [],
        on_top: ['target', 'center'],
        beside: ['target', 'side', 'gap'],
        at: ['position', 'anchor'],
      }
      const extra = given.filter((key) => !allowed[args.mode].includes(key))
      if (extra.length > 0) throw new Error(`mode=${args.mode} 不用 ${extra.join(' / ')}（可用：${allowed[args.mode].join(' / ') || '无'}）`)
      let placement: ops.DirectorPlacement
      if (args.mode === 'ground') {
        placement = { id: args.id, mode: 'ground' }
      } else if (args.mode === 'on_top') {
        if (args.target === undefined) throw new Error('mode=on_top 必须给 target')
        placement = { id: args.id, mode: 'on_top', target: args.target, ...(args.center !== undefined ? { center: args.center } : {}) }
      } else if (args.mode === 'beside') {
        if (args.target === undefined || args.side === undefined) throw new Error('mode=beside 必须给 target 和 side')
        placement = { id: args.id, mode: 'beside', target: args.target, side: args.side, ...(args.gap !== undefined ? { gap: args.gap } : {}) }
      } else {
        if (args.position === undefined) throw new Error('mode=at 必须给 position')
        placement = { id: args.id, mode: 'at', position: args.position, ...(args.anchor !== undefined ? { anchor: args.anchor } : {}) }
      }
      const { res, summary } = await write((opCtx) => {
        const scene = ops.readDirector(opCtx, args.nodeId)
        const nameOf = (id: string) => quote(scene.objects.get(id)?.name ?? id)
        const res = ops.placeDirectorObject(opCtx, args.nodeId, placement)
        const self = nameOf(args.id)
        const summary =
          placement.mode === 'ground'
            ? `把${self}落到地面`
            : placement.mode === 'on_top'
              ? `把${self}放到${nameOf(placement.target)}顶上`
              : placement.mode === 'beside'
                ? `把${self}贴在${nameOf(placement.target)}的 ${placement.side} 侧`
                : `把${self}放到 [${rounded([...placement.position]).join(', ')}]`
        return { res, summary }
      })
      return written(args.nodeId, res, summary)
    },
  }

  const alignObjects: CanvasTool<typeof alignObjectsParams> = {
    name: 'align_objects',
    capability: 'flow:write',
    label: '对齐对象',
    description:
      '让一批对象沿某个轴按包围盒的最小面 / 中心 / 最大面对齐（只平移，按 0 秒的状态）；给 to 就对齐到那个对象（它不动），' +
      '否则对齐到这批对象整体的包围盒。',
    parameters: alignObjectsParams,
    executionMode: 'sequential',
    describe: (args) => `沿 ${args.axis} 轴对齐 ${args.ids.length} 个对象`,
    async execute(_id, args) {
      guard(args.nodeId)
      for (const id of args.ids) assertId(id, '对象 id')
      const res = await write((opCtx) =>
        ops.alignDirectorObjects(opCtx, args.nodeId, {
          ids: args.ids,
          axis: args.axis,
          mode: args.mode,
          ...(args.to !== undefined ? { to: args.to } : {}),
        }),
      )
      return written(args.nodeId, res, `沿 ${args.axis} 轴对齐 ${res.objects.length} 个对象（${args.mode}）`)
    },
  }

  const distributeObjects: CanvasTool<typeof distributeObjectsParams> = {
    name: 'distribute_objects',
    capability: 'flow:write',
    label: '等距排开',
    description:
      '让一批对象沿某个轴按包围盒等间距排开（只平移，按 0 秒的状态，顺序按当前位置）：给 gap 就第一个不动、后面依次隔 gap 米；' +
      '不给就首尾不动、中间等距。',
    parameters: distributeObjectsParams,
    executionMode: 'sequential',
    describe: (args) => `沿 ${args.axis} 轴排开 ${args.ids.length} 个对象`,
    async execute(_id, args) {
      guard(args.nodeId)
      for (const id of args.ids) assertId(id, '对象 id')
      const res = await write((opCtx) =>
        ops.distributeDirectorObjects(opCtx, args.nodeId, {
          ids: args.ids,
          axis: args.axis,
          ...(args.gap !== undefined ? { gap: args.gap } : {}),
        }),
      )
      return written(args.nodeId, res, `沿 ${args.axis} 轴排开 ${res.objects.length} 个对象`)
    },
  }

  const aimCamera: CanvasTool<typeof aimCameraParams> = {
    name: 'aim_camera',
    capability: 'flow:write',
    label: '调整机位',
    description:
      '调整一个机位（三选一）：targetObjectId / targetPoint 只转不动、对准那个对象的中心或坐标；fitObjectIds 对准这批对象整体的中心，' +
      '并沿现在的方向（或 direction）前后挪到按 fov 和画幅刚好装下它们的距离（margin 留边）。返回机位写入后的状态、到目标的距离和那一刻的取景。',
    parameters: aimCameraParams,
    executionMode: 'sequential',
    describe: (args) => `调整机位 ${args.cameraId}`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.cameraId, 'cameraId')
      const modes = [args.targetObjectId, args.targetPoint, args.fitObjectIds].filter((value) => value !== undefined).length
      if (modes !== 1) throw new Error('targetObjectId、targetPoint、fitObjectIds 必须给且只给一个')
      if (args.fitObjectIds === undefined && (args.margin !== undefined || args.direction !== undefined)) {
        throw new Error('margin / direction 只能和 fitObjectIds 一起用')
      }
      const input: ops.DirectorAimInput =
        args.fitObjectIds !== undefined
          ? {
              cameraId: args.cameraId,
              fit: {
                objectIds: args.fitObjectIds,
                ...(args.margin !== undefined ? { margin: args.margin } : {}),
                ...(args.direction !== undefined ? { direction: args.direction } : {}),
              },
            }
          : {
              cameraId: args.cameraId,
              target: args.targetObjectId !== undefined ? { objectId: args.targetObjectId } : { point: args.targetPoint! },
            }
      const res = await write((opCtx) => ops.aimDirectorCamera(opCtx, args.nodeId, input))
      const name = quote(res.objects[0]?.name ?? args.cameraId)
      const summary =
        args.fitObjectIds !== undefined
          ? `机位${name}装下 ${args.fitObjectIds.length} 个对象（距离 ${rounded(res.distance).toFixed(2)} 米）`
          : `机位${name}对准${args.targetObjectId !== undefined ? ` ${args.targetObjectId}` : '坐标'}`
      return written(args.nodeId, res, summary, {
        distance: res.distance,
        ...(res.view ? { view: viewForModel(res.view) } : {}),
      })
    },
  }

  const updateObjects: CanvasTool<typeof updateObjectsParams> = {
    name: 'update_objects',
    capability: 'flow:write',
    label: '修改对象',
    description:
      `改对象的名字、颜色、材质、几何尺寸（米）、机位参数（fov 度）、灯光参数，一次最多 ${L.batch} 个；只改给出的字段，和现有的合并。` +
      '位置 / 旋转 / 缩放用 transform_objects 或 place_object。改了尺寸之后包围盒会变，看返回的数值、必要时重新 place_object。',
    parameters: updateObjectsParams,
    executionMode: 'sequential',
    describe: (args) => `修改 ${args.updates.length} 个对象`,
    async execute(_id, args) {
      guard(args.nodeId)
      for (const item of args.updates) assertId(item.id, '对象 id')
      const res = await write((opCtx) => ops.updateDirectorObjects(opCtx, args.nodeId, args.updates))
      return written(args.nodeId, res, `修改 ${res.objects.length} 个对象`)
    },
  }

  const setSettings: CanvasTool<typeof settingsParams> = {
    name: 'set_director_settings',
    capability: 'flow:write',
    label: '导演台设置',
    description:
      '改导演台的时长（秒，不能短于最后一个关键帧）、帧率、画幅、当前机位（activeShot：camera 的 id，null 清掉）。只改给出的项。',
    parameters: settingsParams,
    executionMode: 'sequential',
    describe: () => '修改导演台设置',
    async execute(_id, args) {
      guard(args.nodeId)
      if (args.activeShot != null) assertId(args.activeShot, 'activeShot')
      const input: ops.DirectorSettingsInput = {
        ...(args.duration !== undefined ? { duration: args.duration } : {}),
        ...(args.fps !== undefined ? { fps: args.fps } : {}),
        ...(args.aspect !== undefined ? { aspect: args.aspect } : {}),
        ...(args.activeShot !== undefined ? { activeShot: args.activeShot } : {}),
      }
      if (Object.keys(input).length === 0) throw new Error('duration / fps / aspect / activeShot 至少给一个')
      const res = await write((opCtx) => ops.setDirectorSettings(opCtx, args.nodeId, input))
      const parts = [
        ...(input.duration !== undefined ? [`时长 ${input.duration} 秒`] : []),
        ...(input.fps !== undefined ? [`帧率 ${input.fps}`] : []),
        ...(input.aspect !== undefined ? [`画幅 ${input.aspect}`] : []),
        ...(input.activeShot !== undefined ? [input.activeShot === null ? '清掉当前机位' : `当前机位 ${input.activeShot}`] : []),
      ]
      // 时长在结果的 duration 里；其余回显写入后的值
      const echo = {
        ...(input.fps !== undefined ? { fps: input.fps } : {}),
        ...(input.aspect !== undefined ? { aspect: input.aspect } : {}),
        ...(input.activeShot !== undefined ? { activeShot: input.activeShot } : {}),
      }
      return written(args.nodeId, res, `修改导演台设置（${parts.join('、')}）`, { settings: echo })
    },
  }

  const setKeyframes: CanvasTool<typeof setKeyframesParams> = {
    name: 'set_keyframes',
    capability: 'flow:write',
    label: '写关键帧',
    description:
      `在某个对象的某个属性上增改关键帧（显式给时刻秒和值；轨道不存在时一起建；同一时刻已有帧就覆盖），一次最多 ${L.batch} 帧。` +
      '值的单位：position 米、rotation 欧拉角度数、scale 倍数、fov 度。关键帧要稀疏，只打关键时刻；相邻两帧的转角必须小于 180°。' +
      '超出时长会自动延长。返回写入后最后一帧时刻的对象状态。',
    parameters: setKeyframesParams,
    executionMode: 'sequential',
    describe: (args) => `给 ${args.objectId} 的 ${args.property} 写 ${args.keyframes.length} 个关键帧`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.objectId, 'objectId')
      const res = await write((opCtx) =>
        ops.setDirectorKeyframes(opCtx, args.nodeId, {
          objectId: args.objectId,
          property: args.property,
          ...(args.interp !== undefined ? { interp: args.interp } : {}),
          keyframes: args.keyframes,
        }),
      )
      const report = res.keyframes[0]
      const name = quote(res.objects[0]?.name ?? args.objectId)
      return written(args.nodeId, res, `给${name}的 ${args.property} 写 ${report?.count ?? 0} 个关键帧`)
    },
  }

  const animateMotion: CanvasTool<typeof animateMotionParams> = {
    name: 'animate_motion',
    capability: 'flow:write',
    label: '运动预设',
    description:
      '运动预设，由服务端生成稀疏关键帧（起点取对象在 start 时刻的状态，[start, start + duration] 里原有的帧被替换）：' +
      'orbit 绕中心转 angle 度（机位默认一直对准中心）；move_along 依次经过 points；turn 绕某轴转 degrees 度（可以转好几圈）；scale_to 缩放到 scale。' +
      '都带 duration（秒）和 easing。返回生成了几帧、起止时刻、结束时刻的对象状态。',
    parameters: animateMotionParams,
    executionMode: 'sequential',
    describe: (args) => `${args.objectId} 的 ${args.preset} 动画`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.objectId, 'objectId')
      const fields = MOTION_FIELDS[args.preset]
      const record = args as Record<string, unknown>
      const missing = fields.required.filter((key) => record[key] === undefined)
      if (missing.length > 0) throw new Error(`preset=${args.preset} 必须给 ${missing.join(' / ')}`)
      const extra = MOTION_SPECIFIC.filter(
        (key) => record[key] !== undefined && !fields.required.includes(key) && !fields.optional.includes(key),
      )
      if (extra.length > 0) throw new Error(`preset=${args.preset} 不用 ${extra.join(' / ')}`)
      const timing = {
        objectId: args.objectId,
        duration: args.duration,
        ...(args.start !== undefined ? { start: args.start } : {}),
        ...(args.easing !== undefined ? { easing: args.easing } : {}),
      }
      const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]))
      const motion = { ...timing, preset: args.preset, ...pick([...fields.required, ...fields.optional]) } as ops.DirectorMotionInput
      const res = await write((opCtx) => ops.animateDirectorMotion(opCtx, args.nodeId, motion))
      const frames = res.keyframes.reduce((sum, report) => sum + report.count, 0)
      const start = Math.min(...res.keyframes.map((report) => report.start))
      const end = Math.max(...res.keyframes.map((report) => report.end))
      const name = quote(res.objects[0]?.name ?? args.objectId)
      return written(
        args.nodeId,
        res,
        `${name}的 ${args.preset} 动画：生成 ${frames} 个关键帧（${rounded(start)}–${rounded(end)} 秒）`,
      )
    },
  }

  const deleteElements: CanvasTool<typeof deleteParams> = {
    name: 'delete_director_elements',
    capability: 'flow:delete',
    label: '删除导演台元素',
    description:
      '删导演台里的对象（连带它的轨道和关键帧）、轨道（连带它的关键帧）或关键帧。不存在的 id 跳过并在 missing 里列出。' +
      `显式点名的每个对象 / 轨道 / 关键帧计 1 次删除（连带删掉的不算），和画布的删除共用每轮 ${TOOL_LIMITS.deletePerRun} 个的上限，超出整个拒绝。`,
    parameters: deleteParams,
    executionMode: 'sequential',
    describe: (args) =>
      `删除导演台元素（${(args.objectIds?.length ?? 0) + (args.trackIds?.length ?? 0) + (args.keyframeIds?.length ?? 0)} 个）`,
    async execute(_id, args) {
      guard(args.nodeId)
      const objectIds = [...new Set(args.objectIds ?? [])]
      const trackIds = [...new Set(args.trackIds ?? [])]
      const keyframeIds = [...new Set(args.keyframeIds ?? [])]
      for (const id of [...objectIds, ...trackIds, ...keyframeIds]) assertId(id, '要删的元素')
      const named = objectIds.length + trackIds.length + keyframeIds.length
      if (named === 0) throw new Error('objectIds / trackIds / keyframeIds 至少点名一个')
      if (named > L.batch) throw new Error(`一次最多删 ${L.batch} 个（实际 ${named}）`)

      const done = await write((opCtx) => {
        // 先确认是导演台（不存在 / 不是导演台照常报错），再按键数出这次真会删掉的点名元素 —— 预算在动手之前判
        ops.readDirector(opCtx, args.nodeId)
        const node = opCtx.nodes.get(args.nodeId)
        const data = node instanceof Y.Map ? nodeGroupMap(node as Y.Map<unknown>, 'data') : undefined
        const keys = [...objectIds.map(directorObjectKey), ...trackIds.map(directorTrackKey), ...keyframeIds.map(directorKeyframeKey)]
        const charged = keys.filter((key) => data?.has(key) === true).length
        if (runState.deleted + charged > TOOL_LIMITS.deletePerRun) {
          throw new Error(
            `本轮已删除 ${runState.deleted} 个元素，再删 ${charged} 个会超过每轮上限 ${TOOL_LIMITS.deletePerRun}，已拒绝。` +
              '请告诉用户需要删除哪些，由用户自己删。',
          )
        }
        const res = ops.deleteDirectorElements(opCtx, args.nodeId, { objectIds, trackIds, keyframeIds })
        return { res, charged }
      })
      runState.deleted += done.charged
      const { deleted, missing } = done.res
      return written(
        args.nodeId,
        done.res,
        `删除 ${deleted.objects.length} 个对象、${deleted.tracks.length} 条轨道、${deleted.keyframes.length} 个关键帧`,
        { deleted, ...(missing.length > 0 ? { missing } : {}) },
      )
    },
  }

  const measure: CanvasTool<typeof measureObjectsParams> = {
    name: 'measure_objects',
    capability: 'flow:read',
    label: '测量对象',
    description:
      '量若干对象在时刻 t（秒，缺省 0）的世界包围盒：min / max / size（长宽高）/ center / bottom（底面高度），单位米。尺寸和位置以它为准。' +
      'precision：exact = 包围盒就是对象本身；bounding-box = 球、圆锥、圆柱、斜放的对象，包围盒偏保守；point = 机位 / 灯光，没有体积。',
    parameters: measureObjectsParams,
    executionMode: 'sequential',
    describe: (args) => (args.objectIds ? `测量 ${args.objectIds.length} 个对象` : '测量全部对象'),
    async execute(_id, args) {
      guard(args.nodeId)
      if (args.objectIds) for (const id of args.objectIds) assertId(id, '对象 id')
      const t = args.t ?? 0
      const list = await readTimeline(args.nodeId, (timeline) => {
        if (args.objectIds) assertObjectsExist(timeline.scene, args.objectIds)
        return measureObjects(timeline, secondsToMs(t), args.objectIds)
      })
      return result(
        rounded({
          t,
          objects: list.map((item) => ({ id: item.id, name: item.name, kind: item.kind, ...boundsView(item.bounds) })),
        }),
        { summary: `测量 ${list.length} 个对象（${t} 秒）`, elementIds: [] },
      )
    },
  }

  const measureDistance: CanvasTool<typeof measureDistanceParams> = {
    name: 'measure_distance',
    capability: 'flow:read',
    label: '测量距离',
    description:
      '量两个对象在时刻 t（秒，缺省 0）之间的距离（米）：centerDistance 包围盒中心距离；gaps 各轴间隙（正 = 分开多远，负 = 重叠多深）；' +
      'surfaceDistance 包围盒表面间距（重叠时为负）；overlapping 是否穿插。按包围盒算，球 / 圆锥 / 圆柱偏保守。',
    parameters: measureDistanceParams,
    executionMode: 'sequential',
    describe: (args) => `测量 ${args.a} 与 ${args.b} 的距离`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.a, 'a')
      assertId(args.b, 'b')
      if (args.a === args.b) throw new Error('a 和 b 不能是同一个对象')
      const t = args.t ?? 0
      const out = await readTimeline(args.nodeId, (timeline) => {
        assertObjectsExist(timeline.scene, [args.a, args.b])
        const [a, b] = measureObjects(timeline, secondsToMs(t), [args.a, args.b])
        return { a: a!, b: b!, distance: boundsDistance(a!.bounds, b!.bounds) }
      })
      const precision = out.a.bounds.precision === 'exact' && out.b.bounds.precision === 'exact' ? 'exact' : 'bounding-box'
      return result(
        rounded({
          t,
          a: { id: out.a.id, name: out.a.name, precision: out.a.bounds.precision },
          b: { id: out.b.id, name: out.b.name, precision: out.b.bounds.precision },
          ...out.distance,
          precision,
        }),
        {
          summary: `测量${quote(out.a.name)}与${quote(out.b.name)}的距离（${out.distance.overlapping ? '穿插' : `相距 ${rounded(out.distance.surfaceDistance)} 米`}）`,
          elementIds: [],
        },
      )
    },
  }

  const check: CanvasTool<typeof checkSceneParams> = {
    name: 'check_scene',
    capability: 'flow:read',
    label: '检查场景',
    description:
      '在时刻 t 或若干采样时刻（秒）检查场景：intersections 互相穿插（depth 重叠深度米）、belowGround 低于地面、floating 悬空（离地又没被托着）、' +
      'outOfFrame 不完全在机位画面里（默认当前机位，cameraId 指定，null 不查）。只看几何体，按包围盒判断（结果 notes 里注明）。摆完一批就查一次。',
    parameters: checkSceneParams,
    executionMode: 'sequential',
    describe: () => '检查场景',
    async execute(_id, args) {
      guard(args.nodeId)
      if (args.cameraId != null) assertId(args.cameraId, 'cameraId')
      const times = args.times ?? [0]
      const out = await readTimeline(args.nodeId, (timeline) => {
        if (args.cameraId != null) requireCameraIn(timeline.scene, args.cameraId)
        const checked = checkScene(timeline, {
          times: times.map(secondsToMs),
          ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
          ...(args.cameraId !== undefined ? { cameraId: args.cameraId } : {}),
        })
        const names: Record<string, string> = {}
        const note = (id: string) => {
          names[id] = timeline.scene.objects.get(id)?.name ?? id
        }
        for (const sample of checked.samples) {
          for (const hit of sample.intersections) {
            note(hit.a)
            note(hit.b)
          }
          for (const item of [...sample.belowGround, ...sample.floating, ...sample.outOfFrame]) note(item.id)
        }
        return { checked, names }
      })
      const { checked, names } = out
      const samples = checked.samples.map((sample) => ({ ...sample, t: msToSeconds(sample.t) }))
      const total = (pick: (sample: (typeof samples)[number]) => readonly unknown[]) => samples.reduce((sum, sample) => sum + pick(sample).length, 0)
      const counts = {
        intersections: total((sample) => sample.intersections),
        belowGround: total((sample) => sample.belowGround),
        floating: total((sample) => sample.floating),
        outOfFrame: total((sample) => sample.outOfFrame),
      }
      const problems = [
        ...(counts.intersections > 0 ? [`穿插 ${counts.intersections} 处`] : []),
        ...(counts.belowGround > 0 ? [`低于地面 ${counts.belowGround} 个`] : []),
        ...(counts.floating > 0 ? [`悬空 ${counts.floating} 个`] : []),
        ...(counts.outOfFrame > 0 ? [`出画 ${counts.outOfFrame} 个`] : []),
      ]
      return result(
        rounded({
          ok: problems.length === 0,
          cameraId: checked.cameraId,
          tolerance: checked.tolerance,
          samples,
          names,
          notes: checked.notes,
        }),
        {
          summary: `检查场景（${times.length} 个时刻）：${problems.length > 0 ? problems.join('、') : '没有发现问题'}`,
          elementIds: [],
        },
      )
    },
  }

  const view: CanvasTool<typeof cameraViewParams> = {
    name: 'camera_view',
    capability: 'flow:read',
    label: '机位取景',
    description:
      '某个机位在时刻 t（秒，缺省 0）的取景：每个对象 status（inside 整个在画面里 / partial 一部分 / outside 在画外 / behind 在机位背后）、' +
      'rect 在取景框里的位置（0–1，左上 (0,0)，x 向右、y 向下）、coverage 占画面面积的比例、distance 离机位多远（米）。' +
      '按包围盒投影估算，不算遮挡（结果 note 里注明）。',
    parameters: cameraViewParams,
    executionMode: 'sequential',
    describe: (args) => `机位 ${args.cameraId} 的取景`,
    async execute(_id, args) {
      guard(args.nodeId)
      assertId(args.cameraId, 'cameraId')
      if (args.objectIds) for (const id of args.objectIds) assertId(id, '对象 id')
      const t = args.t ?? 0
      const out = await readTimeline(args.nodeId, (timeline) => {
        requireCameraIn(timeline.scene, args.cameraId)
        if (args.objectIds) assertObjectsExist(timeline.scene, args.objectIds)
        const framing = cameraView(timeline, args.cameraId, secondsToMs(t), args.objectIds ? { objectIds: args.objectIds } : {})
        return { framing: framing!, name: timeline.scene.objects.get(args.cameraId)?.name ?? args.cameraId }
      })
      const objects = out.framing.objects
      return result(viewForModel(out.framing), {
        summary:
          `机位${quote(out.name)}取景（${t} 秒）：画面内 ${countBy(objects, 'inside')} 个、部分入画 ${countBy(objects, 'partial')} 个、` +
          `画外 ${countBy(objects, 'outside') + countBy(objects, 'behind')} 个`,
        elementIds: [],
      })
    },
  }

  return [
    getScene,
    addObjects,
    transformObjects,
    placeObject,
    alignObjects,
    distributeObjects,
    aimCamera,
    updateObjects,
    setSettings,
    setKeyframes,
    animateMotion,
    deleteElements,
    measure,
    measureDistance,
    check,
    view,
  ] as unknown as CanvasTool[]
}
