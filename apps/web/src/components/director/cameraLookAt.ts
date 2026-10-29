import { onBeforeUnmount, onMounted } from "vue"
import * as THREE from "three"

import {
  getEvaluated,
  readAuthored,
  setEvaluated,
  writeAuthored
} from "@/components/three-editor/EvaluatedTransform"

import { getObjectCenterWorld } from "./directorObjectCenter"

// 摄像机「注视目标」状态，存放于 camera.userData，随场景序列化一同持久化。
// 面板对它的变更经 SetCameraLookAtCommand 进撤销历史；下方跟随逻辑对
// target 缓存/降级的就地维护属于派生量，不进历史。
//
// **三种模式，答的是「这个机位的朝向由谁说了算」**：
//   · free   ——「手动调整」：谁也不驱动，位置与旋转都归用户，与场景里任何普通图形一样。
//               新建机位的缺省即此（旧数据里的 'manual' 迁移到这里，见 migrateLegacyCameraLookAt）。
//   · point  ——「位置」：镜头锁定注视 target 这一点。位置与注视点合起来才是一套「装置」：
//               挪注视点 = 整套装置平移，挪机位 = 绕注视点转（半径不变），用户能改的朝向
//               只剩绕视线轴的**倾斜**。
//   · object ——「跟随」：注视点是 targetUuid 所指图形的中心，随它移动实时重解析；
//               target 缓存其最近一次的中心世界坐标（由 getObjectCenterWorld 给出：用户设过
//               中心位置就用它，否则按包围盒中心推断）——既供面板显示，也作为目标丢失后
//               回退时的坐标。
//
// **对准是派生量，经求值层落地**（EvaluatedTransform，见 .claude/rules/three-editor.md）：
//   camera.quaternion = R_对准 · R_authored
// 左乘的那一份是本方声明的分量（offset），authored 则是用户自己写的那一份。两种模式因此
// 各得其所：aim 模式下 authored 是**注视角度**（相对「正对着目标」的三轴偏移 = 面板上的
// 「注视角度」、时间轴上「旋转」那一行记的东西），free 模式下本方不声明任何分量、authored
// 即完整朝向。
// **不要**改回直写 camera.quaternion：那样「对准」与「用户摆的角度」共用节点上唯一一份值，
// 注视角度没有地方存，旋转关键帧也会在每次对准时被抹掉。
//
// authored 的**依据随模式变**，故换模式时它与时间轴那条旋转轨道都要换算一次——两件事收在
// cameraLookAtSwitch.ts（住在本文件与 timeline/directorTimeline 上面一层，后者反过来 import
// 本文件）。**不要**在本文件里直接改轨道。
export type CameraLookAtMode = "free" | "point" | "object"

export interface CameraLookAtState {
  mode: CameraLookAtMode
  targetUuid: string | null
  /**
   * 注视点坐标，存在**机位所在的那一层**（父层空间，与 `camera.position` 同一个坐标系）。
   *
   * 这是导演台里"机位装置"的第二条位置轴：镜头站位是一条（`camera.position`），注视点是
   * 另一条。两条轴同空间是**硬要求**，不是顺手对齐的：
   *   ①「注视位置」那条时间轴轨道上可以放**轨迹**片段，而路径点一律存在「它合并进的那条
   *     属性行的取值空间」里（见 directorMotionPath.ts 取舍 3b）——片段的取值钩子
   *     `sampleValue(clip, progress)` 拿不到对象，没有任何机会做坐标换算，故那个空间必须
   *     与关键帧的取值空间逐字相同；
   *   ②面板上「位置」与「注视位置」两个 xyz 字段这才读在同一个坐标系里。
   *
   * 对准数学（`cameraAimQuaternion`）要的是**世界**坐标，故那一侧经 `parentToWorld` 换算，
   * 换算只在本文件里出现，别处一律拿到什么用什么。
   */
  target: { x: number; y: number; z: number }
  /**
   * **跟拍装置**：站位也跟着锚点走（注视对象 / 注视位置两种模式都成立）。
   *
   * 不开跟拍时机位只驱动**朝向**——原地摇头看着锚点，那是「摇镜跟拍」；锚点走远了镜头只是
   * 转过去，不会跟上去。跟拍要的是站位也跟着走、始终保持同一个相对位姿，这一项就是那个开关。
   *
   * 存的是**相对位姿的读数**而不是布尔：开启那一刻把机位当时相对锚点的球坐标记下来，此后由
   * 它驱动。三个读数（Y角度/X角度/距离）同时也是**三条时间轴属性**（见 TIMELINE_PROPERTIES
   * 的 aimAzimuth/aimElevation/aimDistance），关键帧写的就是这里——那正是「角度和距离不需要
   * 锁定，由关键帧限制变化」的落法：想「只推拉别绕」就只给距离打帧，角度一帧不打即恒定。
   */
  follow?: CameraFollowRig | null
}

/**
 * 跟拍装置：机位相对被跟随图形的固定位姿。
 *
 * 三个角度/距离沿用 CameraOrbit 那一套（面板「机位角度」显示的正是它们），差别只在**相对谁**
 * ——由 frame 回答。
 */
/**
 * **跟拍装置**：机位站位相对锚点的那份控制参数。
 *
 * 两种参照**存的东西不一样**，这是本域最容易记错的一处——它们不是同一份数据换个解释方式，
 * 而是两套参数：
 *   · `'world'` **固定方位**——存一份**相对位置**（父层轴向的 xyz 偏移）。锚点怎么转都不影响
 *     它，故机位只跟着锚点**平移**，相当于同步锚点的运动轨迹；
 *   · `'rigid'` **锁定视角**——存**X角度/Y角度/距离**（绕锚点的球坐标），且偏移**随锚点的朝向
 *     一起转**。锚点转身，机位绕到同一侧，那正是「与它一体」。
 *
 * **朝向不在这里**：机位的旋转永远是「对准锚点 · 注视角度」，两种参照都一样，改变的只有站位
 * 怎么算（见 cameraFollowPosition）。早先锁定视角还存过一份「冻结取景」的快照
 * （`orientation`），于是调 X/Y角度 时机位挪了、镜头却保持旧朝向——用户报的「x角度调整斜着
 * 走、y角度调整没变化」正是它。**不要**把那份快照加回来：要「与对象一体」，让偏移随对象转
 * 就够了，朝向照常对准锚点即自然成立。
 */
export type CameraFollowRig = CameraFollowOffsetRig | CameraFollowOrbitRig

/** 固定方位：相对锚点的位置偏移（父层轴向，不随锚点朝向转）。 */
export interface CameraFollowOffsetRig {
  frame: "world"
  /** xyz 偏移（米），与 camera.position 同一层坐标。 */
  offset: number[]
}

/** 锁定视角：绕锚点的球坐标，偏移随锚点朝向一起转。 */
export interface CameraFollowOrbitRig extends CameraOrbit {
  frame: "rigid"
}

export type CameraFollowFrame = "world" | "rigid"

/** 这份装置是不是球坐标那一种（锁定视角）。两种形态的字段不同，读之前先问它。 */
export function isOrbitRig(
  rig: CameraFollowRig | null
): rig is CameraFollowOrbitRig {
  return rig?.frame === "rigid"
}

/** 绕注视点的球坐标：Y角度/X角度（度）+ 距离（米）。 */
export interface CameraOrbit {
  /** Y角度（`azimuth`）：绕世界 +Y 轴，0° 为 +Z 方向——水平方向绕锚点一整圈。 */
  azimuth: number
  /** X角度（`elevation`）：绕世界 X 轴的仰角，+ 为俯视（机位在锚点上方）。 */
  elevation: number
  distance: number
}

/** 求值层里本方分量的来源名（同一域内必须只有这一个字面量，见 EvaluatedSource）。 */
export const CAMERA_AIM_SOURCE = "cameraAim"

const DEFAULT_AIM_DISTANCE = 5
/** 注视点与机位重合时的退化下限：距离为零则方向无从谈起。 */
const MIN_AIM_DISTANCE = 0.01
/**
 * X角度（仰角）的极限：正对天顶时上方向退化，绕注视点转会翻面。
 *
 * 导出是给面板那根滑杆当量程用——两处必须是同一个数，各写一份的话滑杆能拖到的位置会与
 * `cameraOrbitPosition` 实际夹取到的位置对不上（拖到头了读数却还差一点）。
 */
export const MAX_ELEVATION_DEG = 89.9

const _aimQuat = new THREE.Quaternion()
const _rollQuat = new THREE.Quaternion()
const _parentQuat = new THREE.Quaternion()
const _matrix = new THREE.Matrix4()
const _worldPosition = new THREE.Vector3()
const _offset = new THREE.Vector3()
const _point = new THREE.Vector3()
const _authored = new THREE.Vector3()
const _from = new THREE.Vector3()
const _to = new THREE.Vector3()
const _followPoint = new THREE.Vector3()
/** 对准数学专用：注视点换算到世界之后的那一份（见 cameraAimQuaternion）。 */
const _aimPoint = new THREE.Vector3()
const _baseQuat = new THREE.Quaternion()
const _frameQuat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _spherical = new THREE.Spherical()

// 由摄像机当前朝向推导视线上固定距离处的一点，
// 用于在尚未设置注视状态时给面板一个不改变朝向的初始坐标。
//
// 算的是**父层坐标**（局部四元数转出的方向 + 局部位置），与 CameraLookAtState.target 同一层，
// 故它的结果可以直接存进去。早先注释里写的是"世界坐标"，而实现从来是父层——舞台带变换时那份
// 说法就错了，两处不一致正是 target 改存父层要收掉的东西之一。
export function deriveAimPoint(
  camera: any,
  distance = DEFAULT_AIM_DISTANCE
): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .multiplyScalar(Math.max(distance, MIN_AIM_DISTANCE))
    .add(camera.position)
}

export function getCameraLookAt(camera: any): CameraLookAtState | null {
  return camera?.userData?.lookAt ?? null
}

/**
 * 注视状态的快照——命令与拖动快照都要一份不随后续改动漂移的**纯对象**。
 *
 * 逐字段显式构造而不是 `structuredClone`：传入的状态可能是 Vue 的 reactive Proxy（经画布节点
 * 响应式数据流转过来的那些），structuredClone 克隆不了 Proxy 会抛 DataCloneError。
 *
 * 收在这一处而不是各文件各抄一份（此前是四份）：这个结构会长字段——锚点旋转就是刚长出来的
 * 那一项——抄本漏掉一个字段不会报错，只会让那一项在「拖一次机位」或「撤销一步」之后**静默消失**。
 */
function cloneFollowRig(
  rig: CameraFollowRig | null | undefined
): CameraFollowRig | null {
  if (!rig) return null
  // 两种形态字段不同，故分开抄——抄错一边的表现是「切一次参照，那几个读数静默清零」。
  return isOrbitRig(rig)
    ? {
        frame: "rigid",
        azimuth: rig.azimuth,
        elevation: rig.elevation,
        distance: rig.distance
      }
    : { frame: "world", offset: [...rig.offset] }
}

export function cloneCameraLookAt(state: CameraLookAtState): CameraLookAtState {
  return {
    mode: state.mode,
    targetUuid: state.targetUuid,
    target: { x: state.target.x, y: state.target.y, z: state.target.z },
    follow: cloneFollowRig(state.follow)
  }
}

/**
 * 这个机位现在归哪种模式管。没有注视状态、或数据里是个不认识的取值时一律按「手动」——
 * 手动是缺省态，也是唯一一种「本方什么都不做」的模式，认错了只是少驱动一次朝向。
 */
export function getCameraLookAtMode(camera: any): CameraLookAtMode {
  const mode = getCameraLookAt(camera)?.mode
  return mode === "point" || mode === "object" ? mode : "free"
}

/** 朝向此刻是不是由注视驱动的（位置/跟随两种模式）。 */
export function isCameraAimed(camera: any): boolean {
  return camera?.isCamera === true && getCameraLookAtMode(camera) !== "free"
}

/**
 * 注视点此刻的坐标读数（**父层坐标**，与 camera.position 同一层，见 CameraLookAtState.target）。
 *
 * 对象模式下给的是 state.target 里缓存的目标中心（由 resolveLookAtPoint 每次对准时刷新），
 * 位置模式下即用户设的那一点；尚无注视状态时退到由当前朝向推导的那一点，**不写入 userData**
 * （同面板字段的约定：用户提交前摄像机行为保持不变）。
 *
 * 视口连线、装置调节器与时间轴的「注视位置」轨道共用它，三处读到的必须是同一个点——
 * 各自 `userData.lookAt?.target ?? 推导` 抄一遍的话，退化分支迟早会走岔。
 */
export function readCameraLookAtPoint(
  camera: any,
  target = new THREE.Vector3()
): THREE.Vector3 {
  const state = getCameraLookAt(camera)
  if (!state) return target.copy(deriveAimPoint(camera))
  return target.set(state.target.x, state.target.y, state.target.z)
}

/**
 * 就地改写注视点并重新对准（坐标是**父层**的，同 readCameraLookAtPoint）——**不进历史**的
 * 那一条通道。
 *
 * 两个消费方都属于「派生量 / 逐帧写入」，故都不该经 SetCameraLookAtCommand：
 *   · 时间轴「注视位置」轨道的落地（每一帧都在写，进历史会灌满撤销栈）；
 *   · 视口装置调节器的拖动途中（整段拖动在抬手时一次性记一条历史，见 useDirectorCameraRig）。
 * 面板上的提交仍走命令——那是一次明确的、独立的用户编辑。
 *
 * 只在位置模式下有意义：跟随模式的注视点由被跟随图形决定，写进去下一次对准就被覆盖；
 * 手动模式压根不对准，写的只是一份缓存。故调用方须自行确认模式（时间轴那一侧由接管规则
 * 挡住，见 TIMELINE_PROPERTY_OVERRIDES）。
 */
export function writeCameraLookAtPoint(
  editor: any,
  camera: any,
  x: number,
  y: number,
  z: number
): void {
  const state = ensureCameraLookAt(camera)
  state.target = { x, y, z }
  applyCameraLookAt(editor, camera)
}

export function ensureCameraLookAt(camera: any): CameraLookAtState {
  if (!camera.userData.lookAt) {
    const point = deriveAimPoint(camera)
    camera.userData.lookAt = {
      // 缺省「手动调整」：新机位与场景里的普通图形一样，位置与旋转都归用户，
      // 注视点只是一份「切到位置模式时从哪儿起步」的缓存。
      mode: "free",
      targetUuid: null,
      target: { x: point.x, y: point.y, z: point.z }
    } satisfies CameraLookAtState
  }
  return camera.userData.lookAt
}

/**
 * 机位「跟随」的目标图形名称；非机位、非跟随模式或没有目标时返回 null。
 *
 * 跟随期间注视点由被跟随图形给出（时间轴上「注视位置」一行据此停用，见
 * directorTimeline.ts 的 isTimelinePropertyOverridden）。名称解析收在这里，使
 * 「谁在被跟随」只有这一处答案。
 *
 * 目标已从场景消失时给出占位名而不是 null：resolveLookAtPoint 要到下一次对准时才把
 * 状态降级回手动，这中间仍是跟随态，标签得如实说明「跟着一个已经没了的东西」。
 */
export function getCameraFollowTargetName(
  editor: any,
  camera: any
): string | null {
  const state = getCameraLookAt(camera)
  if (!camera?.isCamera || state?.mode !== "object" || !state.targetUuid)
    return null
  const target = (editor.scene.children as any[]).find(
    (child) => child.uuid === state.targetUuid
  )
  return target?.name || "已删除图形"
}

/**
 * 场景里正跟随这个图形的那些机位（不含导演视角那台自由相机）。
 *
 * 两个消费方：图形动了要重新对准（本文件的 useCameraLookAt），图形被删了要退回手动
 * （cameraLookAtSwitch.ts 的 useCameraLookAtSwitch）。抽成模块级函数是因为后者住在**上面
 * 一层**——它还要动时间轴的轨道，而 timeline/directorTimeline 反过来 import 本文件，塞在
 * 这里就成环了（见那边的文件头）。
 */
export function camerasFollowing(editor: any, target: any): any[] {
  if (!target?.uuid) return []
  return Object.values(editor.cameras ?? {}).filter((camera: any) => {
    if (camera === editor.camera) return false
    const state = getCameraLookAt(camera)
    return state?.mode === "object" && state.targetUuid === target.uuid
  })
}

/**
 * 这份注视状态**解析出来**的注视点（父层坐标，见下方），不改任何状态。
 *
 * 与 resolveLookAtPoint 分开一层，是因为「换注视目标」那一路要在状态**还没落到机位身上**时
 * 就问出新的注视点（三把锁要按它重新量一次，见 cameraLookAtSwitch.ts）。两者只该有这一份
 * 解析实现——各写一遍的话，「跟随谁就看它的中心」这条会在其中一处走岔。
 *
 * 手动模式没有注视点（null，本方不驱动朝向）；跟随模式下目标不在场景里同样是 null，
 * 「那时该怎么办」由调用方决定（就地降级归 resolveLookAtPoint）。
 *
 * 给的是**父层坐标**（同 CameraLookAtState.target）：跟随模式下目标的中心是世界坐标，在这里
 * 就换算过来，故两种模式的返回口径一致，调用方不必再判一次自己拿到的是哪一层。
 */
export function resolveCameraLookAtPointOf(
  editor: any,
  camera: any,
  state: CameraLookAtState
): THREE.Vector3 | null {
  return resolveAimAnchorOf(editor, camera, state)?.point ?? null
}

// 解析当前应注视的那一点（**父层坐标**），并顺手维护状态上那两件事：跟随模式把解析出的中心
// 缓存进 state.target（面板显示与目标丢失后的回退都读它），目标已不在场景中则就地降级为手动。
function resolveLookAtPoint(editor: any, camera: any): THREE.Vector3 | null {
  const state = getCameraLookAt(camera)
  if (!state) return null

  if (state.mode === "object" && state.targetUuid) {
    const point = resolveCameraLookAtPointOf(editor, camera, state)
    if (point) {
      state.target = { x: point.x, y: point.y, z: point.z }
      return point
    }
    // 被跟随的图形没了：退回手动（用户此后自己摆朝向），不留一个指向空处的跟随态。
    state.mode = "free"
    state.targetUuid = null
    return null
  }

  return resolveCameraLookAtPointOf(editor, camera, state)
}

/**
 * 「把镜头对准这一点」的那一份旋转（父层空间，滚转为零）。
 *
 * `point` 收的是**父层坐标**（同 CameraLookAtState.target），世界坐标只在本函数内部出现一次
 * ——`up` 必须按**世界**上方解释（否则舞台一转，画面跟着歪），故眼位与目标都换算到世界里算，
 * 末尾再把父层朝向反乘掉。**不要**图省事改成「直接拿父层的眼位与目标算」：那样 up 就成了父层
 * 的上方。
 *
 * 算法与 Object3D.lookAt 同源（含父层朝向的反乘），只是不写进节点——它是本方要交给求值层
 * 的分量，写进节点就把用户的倾斜盖掉了。
 */
export function cameraAimQuaternion(
  camera: any,
  point: THREE.Vector3,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  camera.updateWorldMatrix(true, false)
  _worldPosition.setFromMatrixPosition(camera.matrixWorld)
  // 换算进**本方自己的**暂存量：入参可能是调用方还要接着用的向量（机位视角的环视手势
  // 就是拿一个复用向量传进来的），就地改会把它的下一步算歪。
  parentToWorld(camera, _aimPoint.copy(point))
  // 相机的 lookAt 是 (eye, target)——与普通对象相反，取反了会正好背对目标。
  _matrix.lookAt(_worldPosition, _aimPoint, camera.up)
  out.setFromRotationMatrix(_matrix)

  const parent = camera.parent
  if (parent) {
    _matrix.extractRotation(parent.matrixWorld)
    out.premultiply(_parentQuat.setFromRotationMatrix(_matrix).invert())
  }
  return out
}

/**
 * 把机位此刻的朝向分解出「倾斜」那一份——即相对于「正对着它现在看的方向」的残差。
 *
 * 机位当前朝向必定把 -Z 指向自己的正前方，而按那个方向算出的对准朝向同样如此，故残差
 * 恒是一次绕视线轴的滚转。切换模式时用它把倾斜留下来（见 planCameraLookAtSwitch）。
 */
function currentRollQuaternion(
  camera: any,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  const facing = deriveAimPoint(camera)
  cameraAimQuaternion(camera, facing, _aimQuat)
  return out.copy(_aimQuat).invert().multiply(camera.quaternion)
}

/**
 * 将摄像机朝向对准注视点；返回朝向是否实际变化，供调用方决定
 * 是否需要派发 objectChanged（也是跟随逻辑不陷入死循环的终止条件）。
 *
 * 落地经求值层：本方声明的是「对准」这一分量，用户的倾斜（authored）原样保留在它之下。
 * 手动模式下撤掉分量即还原 authored——那正是「谁也不驱动」。
 */
export function applyCameraLookAt(editor: any, camera: any): boolean {
  const point = resolveLookAtPoint(editor, camera)
  const before = camera.quaternion.clone()

  if (!point) {
    // 没有分量可撤时短路：setEvaluated(null) 自己也会短路，但那一步要先取记录，
    // 而本函数在播放期间每帧每机位都会走一遍。
    if (getEvaluated(camera, CAMERA_AIM_SOURCE, "quaternion") === null)
      return false
    setEvaluated(camera, CAMERA_AIM_SOURCE, "quaternion", null)
    return camera.quaternion.angleTo(before) > 1e-6
  }

  // **朝向恒为「对准锚点」**，三种情形（不跟拍 / 固定方位 / 锁定视角）一律走这一句：机位的
  // 旋转 = 对准锚点 · 注视角度，跟拍只改变**站位**怎么算。锁定视角的「与对象一体」由偏移随
  // 对象朝向一起转给出（见 cameraFollowPosition），不必也**不要**再冻一份取景快照——冻了的话
  // 调 X/Y角度 时机位挪了、镜头却保持旧朝向，表现是「斜着走」「调了没变化」。
  cameraAimQuaternion(camera, point, _aimQuat)
  setEvaluated(camera, CAMERA_AIM_SOURCE, "quaternion", _aimQuat.toArray())
  return camera.quaternion.angleTo(before) > 1e-6
}

/**
 * 「让这个机位看向空间里的这一点」（**父层坐标**，同 CameraLookAtState.target）——**转镜头的
 * 唯一入口**。
 *
 * 落到哪一份数据上由模式决定，这正是它必须只有一处实现的原因：
 *   · 位置模式——改**注视点**，朝向由对准派生（分量经求值层写回）；
 *   · 手动调整——改**机位自己的 authored 朝向**，注视坐标只顺带更新那份缓存；
 *   · 跟随模式——注视点由被跟随图形给出，谁也别插手，直接返回。
 *
 * **不要**改回在调用方直写 `camera.lookAt(point)`：对准是叠在 authored 之上的派生分量，而
 * 求值层会把「节点上的值与我上次写下去的不一致」认作用户改了 authored（那条启发式兜的是
 * gizmo 拖拽）。于是直写进去的完整朝向被收作 authored，下一次对准再乘一遍——表现就是
 * 「镜头没有对准注视目标」，且越操作偏得越远。机位视角的左键环视就是这么踩到的。
 */
export function aimCameraAt(
  editor: any,
  camera: any,
  point: THREE.Vector3
): void {
  const state = ensureCameraLookAt(camera)
  if (state.mode === "object") return

  state.target = { x: point.x, y: point.y, z: point.z }
  if (state.mode === "point") {
    applyCameraLookAt(editor, camera)
    return
  }
  writeAuthored(
    camera,
    "quaternion",
    cameraAimQuaternion(camera, point, _aimQuat).toArray()
  )
}

// ————————————————————————————————————————————————————————————————
// 注视角度（镜头相对「对准方向」的旋转偏移）
//
// 存的就是 authored 旋转本身：aim 模式下节点上的朝向 = 对准 · authored，故 authored 量的
// 正是「相对于正对着目标，镜头又转过了多少」。面板的「注视角度」与时间轴「旋转」那一行读写
// 的都是它——**不另存一份角度**，否则同一件事有两份数据，关键帧插值与撤销各按各的走。
//
// 三个轴**全部开放**（早先只开 z）：
//   · x = 俯仰偏（目标落在画面偏上/偏下）
//   · y = 水平偏（目标落在画面偏左/偏右——过肩镜头、给前进方向留出空间）
//   · z = 倾斜（画面绕视线歪多少）
// 它们是**相对量**，故目标怎么动、机位怎么绕，取景关系都不变——这正是把它们记在 authored
// 上（而不是记成一份世界朝向）的理由。求值层的 R_对准 · R_authored 本就是这个形状，放开三
// 轴不需要改任何合成规则。
//
// 唯一的代价在旧数据：≤v3 的 authored 里躺着**完整朝向**（那时对准直写 quaternion），照新
// 含义解释就是一份巨大的偏移，镜头会朝着一个陈旧方向歪出去。故那一批要在恢复时归一成纯
// 滚转——判据由 codec 按**场景版本**给出（markLegacyCameraRotation），**不要**改回「每次机位
// 进场都无条件归一」：那样用户刚调好的偏移一重新打开导演台就被抹平了。
// ————————————————————————————————————————————————————————————————

/** 注视角度：相对对准方向的旋转偏移（度）。 */
export interface CameraAimAngles {
  /** 俯仰偏：+ 为镜头上抬（目标落在画面偏下）。 */
  x: number
  /** 水平偏：+ 为镜头左摆（目标落在画面偏右）。 */
  y: number
  /** 倾斜：绕视线轴的滚转。 */
  z: number
}

/** 机位当前的注视角度（度）。 */
export function readCameraAimAngles(camera: any): CameraAimAngles {
  _rollQuat.fromArray(readAuthored(camera, "quaternion"))
  _euler.setFromQuaternion(_rollQuat, camera.rotation?.order ?? "XYZ")
  return {
    x: _euler.x * THREE.MathUtils.RAD2DEG,
    y: _euler.y * THREE.MathUtils.RAD2DEG,
    z: _euler.z * THREE.MathUtils.RAD2DEG
  }
}

/** 注视角度（度）对应的 authored 欧拉角。 */
export function cameraAimAnglesEuler(
  camera: any,
  angles: CameraAimAngles
): THREE.Euler {
  return new THREE.Euler(
    angles.x * THREE.MathUtils.DEG2RAD,
    angles.y * THREE.MathUtils.DEG2RAD,
    angles.z * THREE.MathUtils.DEG2RAD,
    camera.rotation?.order ?? "XYZ"
  )
}

/**
 * 视口里转了一下之后，authored（注视角度）应该变成多少。
 *
 * 手柄转过的是一份**世界**差量 ΔR，而要写回去的是 authored。合成关系是「世界 = base ·
 * authored」（base = 父层朝向 · 对准；旋转拖动期间站位与注视点都不动，故 base 恒定），于是
 *     base · authored' = ΔR · base · authored
 *     authored'        = base⁻¹ · ΔR · base · authored
 * 即把 ΔR **共轭**到 authored 所在的那层空间里（同轨迹切线朝向的换算）。base 不必另取，由
 * 按下那一刻的两份读数当场解出：`base = worldStart · authoredStart⁻¹`。
 *
 * 一条式子**同时覆盖三个环**：绕视线那一个代进去正好还原成「倾斜 += 转过的角度」，故不必
 * 为它留特判。**不要**改成「把 ΔR 直接右乘到 authored 上」——那是在**机位自己的局部轴**上转，
 * 手柄画在视线基底上、转出来的却是另一个方向，越偏越远（同 applyMotionTangent 左乘/右乘那
 * 一条：纯绕视线时两者恰好同解，故这个错只在拖另外两个环时才露头）。
 *
 * 住在这里而不是留在 useDirectorCameraRig 里：这是「注视角度」这个量自己的数学，与谁在拖
 * 它无关；留在 composable 里就没法单独验，而它正是那种一写反就只在某个环上出错的式子。
 */
export function authoredAfterWorldDelta(
  worldStart: THREE.Quaternion,
  authoredStart: THREE.Quaternion,
  deltaWorld: THREE.Quaternion,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  const base = _baseQuat
    .copy(worldStart)
    .multiply(_rollQuat.copy(authoredStart).invert())
  return out
    .copy(base)
    .invert()
    .multiply(deltaWorld)
    .multiply(base)
    .multiply(authoredStart)
}

/**
 * 换注视模式时，authored 整体转过的那一份差量（父层空间，**左乘**）。
 *
 * authored 这个量的**依据随模式变**：手动调整下它是完整朝向（求值层没有对准分量），位置/
 * 跟随下它是「相对正对着目标又转过了多少」，两者相差的正是对准分量。planCameraLookAtSwitch
 * 已经为**当前那一份**算好了换算后的值，故差量直接由前后两份读数解出：
 *     authored' = ΔR · authored  ⟹  ΔR = authored' · authored⁻¹
 *
 * 它的用处是把**时间轴上那条旋转轨道**一起换过去（见 rebaseRotationTrack）：轨道存的
 * 就是 authored（同一份量、同一条轨道，见 TIMELINE_PROPERTIES 的 rotation），只换当前值不换
 * 轨道的话，旧帧的数字原样留着、含义却翻了个面——播放头一移到那些帧上镜头就甩出去。
 *
 * **一条轨道只能有一个依据**，故整条轨道共用这**一个** ΔR，而不是逐帧按各自时刻的对准分量
 * 精确换算。逐帧换算听着更准，实际不成立：①每帧的依据各不相同，帧与帧之间插出来的值就没有
 * 意义了（那正是「统一值的依据」要消掉的东西）；②跟随模式下某一帧的对准取决于**被跟随对象
 * 那一刻在哪**，那不是这个机位自己的数据答得出来的。整条轨道刚性地转同一个 ΔR，帧与帧之间
 * 的相对关系因此原样保留。
 *
 * **左乘**：合成是 `world = R_派生 · authored`，模式切换换掉的是左边那一份，故补偿也在左边
 * ——右乘是在机位自己的局部轴上转（同 applyMotionTangent 与 authoredAfterWorldDelta 那两条：
 * 纯滚转时两者恰好同解，故写反了只在带俯仰偏/水平偏时才露头）。
 */
export function authoredRebaseDelta(
  authoredBefore: THREE.Quaternion,
  authoredAfter: THREE.Quaternion,
  out = new THREE.Quaternion()
): THREE.Quaternion {
  return out
    .copy(authoredAfter)
    .multiply(_rollQuat.copy(authoredBefore).invert())
}

/** 机位当前的倾斜角（度）——注视角度的 z 分量，视口装置的旋转手柄绕视线那一个环改的就是它。 */
export function readCameraRoll(camera: any): number {
  return readCameraAimAngles(camera).z
}

/**
 * 只把倾斜换成这个角度、**另外两轴原样保留**的 authored 欧拉角。
 *
 * 「原样保留」是必需的：视口装置的旋转手柄只有绕视线那一个环（它答的就是倾斜），而用户可能
 * 已经在面板上调过俯仰偏/水平偏。早先这里把 x/y 写死成 0，转一下那个环就会把取景偏移抹平。
 */
export function cameraRollEuler(camera: any, degrees: number): THREE.Euler {
  return cameraAimAnglesEuler(camera, {
    ...readCameraAimAngles(camera),
    z: degrees
  })
}

// ————————————————————————————————————————————————————————————————
// 绕注视点的球坐标（X角度 / Y角度 / 距离）
//
// aim 模式下机位的位置就是「绕注视点转到哪个方位、离多远」，故面板与视口调节器都按这套
// 坐标呈现（需求原话：调整机位图形不再是 xyz，而是和注视位置的横向与X角度度）。真正被
// 持久化、被位置关键帧记录的仍是 xyz——这里只是同一件事的另一套读数，换算收在这两个函数
// 里，视口与面板不各算一遍。
// ————————————————————————————————————————————————————————————————

/** 机位（authored 站位）相对注视点的球坐标。 */
/**
 * 任意一个**父层坐标**的站位在这个机位的球坐标里是多少（绕当前注视点）。
 *
 * 与 readCameraOrbit 分开一层，是因为插值要问的不是「机位现在在哪」而是「两个关键帧各在
 * 哪」——两者的换算完全相同，故只该有这一份实现。
 *
 * `around` 给的是「绕哪一点量」（父层坐标），不给即绕机位当前的注视点。换注视目标那一路要在
 * 新锚点**还没落到机位身上**时就问出读数，故要能显式指定。
 */
export function cameraOrbitOf(
  camera: any,
  position: THREE.Vector3,
  around?: THREE.Vector3
): CameraOrbit {
  if (around) _point.copy(around)
  else readCameraLookAtPoint(camera, _point)
  // 注视点与站位同为父层坐标（见 CameraLookAtState.target），故直接相减。
  _offset.copy(position).sub(_point)
  _spherical.setFromVector3(_offset)
  return {
    azimuth: _spherical.theta * THREE.MathUtils.RAD2DEG,
    elevation: 90 - _spherical.phi * THREE.MathUtils.RAD2DEG,
    distance: _spherical.radius
  }
}

export function readCameraOrbit(camera: any): CameraOrbit {
  // 读 authored：机位也能放轨迹片段，节点上的坐标那时是算出来的派生量（同属性面板的
  // 位置字段），照它读再提交就把派生量变成了真站位。
  return cameraOrbitOf(
    camera,
    _authored.fromArray(readAuthored(camera, "position"))
  )
}

/** 由球坐标反算机位站位（父层坐标，可直接写 authored）。 */
export function cameraOrbitPosition(
  camera: any,
  orbit: CameraOrbit,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const elevation = THREE.MathUtils.clamp(
    orbit.elevation,
    -MAX_ELEVATION_DEG,
    MAX_ELEVATION_DEG
  )
  _spherical.set(
    Math.max(orbit.distance, MIN_AIM_DISTANCE),
    (90 - elevation) * THREE.MathUtils.DEG2RAD,
    orbit.azimuth * THREE.MathUtils.DEG2RAD
  )
  readCameraLookAtPoint(camera, _point)
  return out.setFromSpherical(_spherical).add(_point)
}

/**
 * 被注视驱动的机位，两个关键帧之间的站位插值——**在球坐标里插，而不是在 xyz 里插**。
 *
 * 一句话：**没设变化率曲线时，用户在面板上看到的那三个读数各自线性推进**（Y角度 / X角度 /
 * 距离），机位实际走的那条线是这三者共同作用的结果。
 *
 * 为什么必须换个空间插：xyz 线性插值走的是两帧之间的**弦**，而面板上呈现的是绕注视点的球
 * 坐标——弦上的点换算回球坐标之后，同样的时间在两头扫过的角度小、在中间扫过的角度大，距离
 * 还会在中途塌进去。用户没有设过任何缓动，却看见了缓动。
 * （角速度 dθ/dt 在中点取到最大 2·tanα、在两端取到最小 sin2α，α 为半弦角；弧越大越明显。）
 *
 * **对全部 aim 模式机位生效，不再只在锁着的时候改道。** 早先的判据是「锁了才改道」，理由是
 * 「没锁时两点之间该走直线（一次平移推轨）」——那条已被推翻，因为它把「感官上是不是匀速」
 * 这件事挂在了一个语义完全不同的开关（锁是一条**约束**：这一项此后不许变）上：想要「绕过去
 * 别忽快忽慢」就得先随便钉一项，而钉了又真的把那一项冻住了。
 *
 * **纯推拉不受影响**：两端角度相同时，球坐标插出来的点全在同一条射线上，那仍是一条直线。
 * 真正变了的只有「两端角度不同」的那些段——而那正是要修的现象本身。
 *
 * 它只在**不跟拍**时用得上：那时站位是 xyz 的 authored（位置关键帧插的就是它）。开了跟拍的
 * 机位站位由三条角度/距离轨道驱动，那三条本就是标量、各自线性推进，不经这里。
 *
 * Y角度走**最短弧**（同旋转属性的 lerpAngleDeg）：170° → -170° 该就近跨过 ±180，而不是
 * 反着扫 340°。要「反着绕大圈」或「多转几圈」则由段自己的 `turns` 说（见
 * TimelineKeyframe.turns）：总角度 = 最短弧 + turns × 360°，故同一个整数既表达方向、也表达
 * 圈数。它加在**角度**上而不是加在 t 上，于是与变化率曲线正交——曲线怎么分配快慢，都还是
 * 走完这同一段总角度。
 *
 * 参照点取机位**当前**的注视点，两端与结果都相对同一个点换算，故注视点自己也在动时仍是连续的。
 *
 * 两种情形返回 null 交回 xyz 直线插值：**手动调整模式**（那时机位与普通图形无异，注视点只是
 * 一份陈旧缓存，绕着它插毫无道理），以及**任一端与注视点重合**（半径为零时球坐标给不出方向，
 * 插出来会是一次凭空的甩动）。
 */
export function lerpCameraOrbitPosition(
  camera: any,
  from: number[],
  to: number[],
  t: number,
  turns = 0,
  out = new THREE.Vector3()
): number[] | null {
  if (!isCameraAimed(camera)) return null

  const a = cameraOrbitOf(camera, _from.fromArray(from))
  const b = cameraOrbitOf(camera, _to.fromArray(to))
  if (a.distance < MIN_AIM_DISTANCE || b.distance < MIN_AIM_DISTANCE)
    return null
  const shortest = ((((b.azimuth - a.azimuth + 180) % 360) + 360) % 360) - 180
  const delta = shortest + turns * 360

  return cameraOrbitPosition(
    camera,
    {
      azimuth: a.azimuth + delta * t,
      elevation: a.elevation + (b.elevation - a.elevation) * t,
      distance: a.distance + (b.distance - a.distance) * t
    },
    out
  ).toArray()
}

// ————————————————————————————————————————————————————————————————
// 跟拍装置
//
// 跟随模式缺省只驱动**朝向**：机位原地摇头看着目标——那是「摇镜跟拍」，角色走远了镜头只是
// 转过去，不会跟上去。第三人称跟拍要的是**站位也跟着走**，始终保持同一个相对位姿。
//
// 四条取舍：
// ① 站位是**派生量，经求值层 override 落地**（同轨迹片段的 applyMotionPlacement），不直写
//    `camera.position`：直写会把 authored 一路覆盖掉——用户摆的站位、位置关键帧存的那一份
//    全都变成算出来的采样点，关掉跟拍就回不到原处，存盘存进去的也是某一帧的落点。
// ② 相对位姿**存读数**而不是布尔（同三个锁）：开启那一刻把机位当时相对目标的球坐标记下来，
//    此后恒定。驱动得有个目标读数，而「摆好机位再按一下」比让用户填三个数字自然得多。
// ③ 参照系二选一（frame）：跟目标航向 = 真·第三人称（拐弯时镜头绕到同一侧），跟世界方位 =
//    侧移伴随。两者实现只差一次 yaw 相乘，故是一个选项而不是两个功能。
// ④ 只取目标的**航向**（绕 Y 的 yaw），不用完整朝向：角色前倾/侧翻（趴着的角色、俯冲的
//    物体）会把镜头带到地下去。这与切线朝向里 faceTangent 只转航向是同一条取舍。
// ⑤ **硬跟，不做跟随延迟**：位姿必须是「时刻 → 位置」的纯函数，来回拖播放头、跳着取值、
//    录制时在别的时刻取值，结果都得一致。弹簧阻尼依赖上一帧状态，会打破这条约定（同根位移
//    那一条取舍）。要做也该做成无状态的「沿轨迹回溯 N 米取样」，而不是攒状态。
// ————————————————————————————————————————————————————————————————

/** 求值层里跟拍分量的来源名（同一域内必须只有这一个字面量，见 EvaluatedSource）。 */
export const CAMERA_FOLLOW_SOURCE = "cameraFollow"

/** 这个机位的跟拍装置（没开、或在自由调整模式即 null）。 */
export function getCameraFollowRig(camera: any): CameraFollowRig | null {
  if (!camera?.isCamera || !isCameraAimed(camera)) return null
  const state = getCameraLookAt(camera)
  if (!state?.follow) return null
  // **就地归一**（同 resolveLookAtPoint 里「目标没了就降级」那条）：装置的形状是这一层的
  // 不变式，而它可能来自持久化数据或外部改写。不归一的话，缺字段那一份会一路漏到读写两侧
  // ——`rig.offset[0]` 直接抛「Cannot read properties of undefined」，而那发生在场景恢复
  // 途中（自动关键帧的基准要读一遍全部属性），整个导演台起不来。
  //
  // 必须**写回 state**、返回同一个引用：三条球坐标与相对位置那一条的 write 是就地改这份
  // 装置（`rig.offset = …`），返回一份归一化的副本会让那些改动落到临时对象上、手一松就没了。
  const normalized = normalizeFollowRig(state.follow)
  if (normalized !== state.follow) state.follow = normalized
  return state.follow
}

/** 有限数，取不到即退回缺省（外部改写/旧形态的数据都可能缺字段）。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/**
 * 把一份跟拍装置归一成两种合法形态之一；已经合法的原样返回（**同一个引用**，见调用处）。
 *
 * 两种参照存的是两套参数，故这里也分两支。固定方位那一支还兼一次**形态迁移**：早先两种参照
 * 共用球坐标，那时的 `'world'` 语义正是「球坐标偏移，但不随对象朝向转」——与 xyz 偏移完全
 * 等价，故按同一份球坐标换算出偏移即可，机位不会因为这次归一挪动一丝一毫。
 */
function normalizeFollowRig(raw: any): CameraFollowRig | null {
  if (!raw || typeof raw !== "object") return null

  if (raw.frame === "rigid") {
    const valid =
      typeof raw.azimuth === "number" &&
      typeof raw.elevation === "number" &&
      typeof raw.distance === "number"
    return valid
      ? raw
      : {
          frame: "rigid",
          azimuth: finiteOr(raw.azimuth, 0),
          elevation: finiteOr(raw.elevation, 0),
          distance: Math.max(
            finiteOr(raw.distance, DEFAULT_AIM_DISTANCE),
            MIN_AIM_DISTANCE
          )
        }
  }

  if (Array.isArray(raw.offset) && raw.offset.length >= 3) return raw
  // 缺 offset：按球坐标那几个字段换算一次（旧形态）。一个字段都没有时 orbitOffset 会把半径
  // 夹到下限，机位落在锚点近旁——一眼看得见，比抛异常或凭空给一个方位好。
  const offset = orbitOffset(
    {
      azimuth: finiteOr(raw.azimuth, 0),
      elevation: finiteOr(raw.elevation, 0),
      distance: finiteOr(raw.distance, 0)
    },
    new THREE.Vector3()
  )
  return { frame: "world", offset: offset.toArray() }
}

/** 站位此刻是不是由跟拍驱动的（属性面板与时间轴的属性行显隐都问它）。 */
export function isCameraFollowingPosition(camera: any): boolean {
  return getCameraFollowRig(camera) !== null
}

/**
 * **锚点**：机位看着的、并且（开了跟拍时）绕着转的那样东西。
 *
 * 两种 aim 模式只在「锚点从哪儿来」这一处不同，此外一个字都不差——这正是把它抽出来的理由：
 *   · 注视对象——锚点是那个图形：位置取它的中心（`getObjectCenterWorld`，与对准同源，两处
 *     不同源的话镜头会盯着一处、绕着另一处转），朝向取它的世界朝向；
 *   · 注视位置——锚点是用户摆的那一点，位置即 `state.target`；它**没有朝向**（一个点转不了，
 *     需求原话「注视位置不能旋转」），故朝向恒为单位四元数。锁定视角在这种模式下因此退化成
 *     「一份用球坐标表达的固定相对位置」，仍与固定方位不同——那一支存的是 xyz。
 *
 * 位置一律给**父层坐标**（与 camera.position 同一层，见 CameraLookAtState.target），朝向一律
 * 给**世界四元数**（参照朝向本就该按世界解释，否则舞台一转取景就歪）。
 */
export interface CameraAimAnchor {
  point: THREE.Vector3
  quaternion: THREE.Quaternion
}

const _anchorPoint = new THREE.Vector3()
const _anchorQuat = new THREE.Quaternion()

export function resolveAimAnchor(
  editor: any,
  camera: any
): CameraAimAnchor | null {
  const state = getCameraLookAt(camera)
  return state ? resolveAimAnchorOf(editor, camera, state) : null
}

/**
 * 同上，但按**显式给出的那份状态**解析。
 *
 * 换注视模式/换注视目标那一路要在新状态**还没落到机位身上**时就问出锚点（跟拍读数要按它重新
 * 量一次，见 cameraLookAtSwitch.ts）。两者只该有这一份解析实现——各写一遍的话，「跟随谁就看
 * 它的中心」这条会在其中一处走岔。
 */
export function resolveAimAnchorOf(
  editor: any,
  camera: any,
  state: CameraLookAtState
): CameraAimAnchor | null {
  if (!camera?.isCamera || state.mode === "free") return null

  if (state.mode === "object") {
    if (!editor?.scene || !state.targetUuid) return null
    const target = editor.scene.getObjectByProperty("uuid", state.targetUuid)
    if (!target) return null
    target.updateWorldMatrix(true, false)
    getObjectCenterWorld(target, _anchorPoint)
    worldToParent(camera, _anchorPoint)
    target.getWorldQuaternion(_anchorQuat)
    return { point: _anchorPoint, quaternion: _anchorQuat }
  }

  // 注视位置：一个点没有朝向（见上），故参照朝向恒为单位四元数。
  _anchorPoint.set(state.target.x, state.target.y, state.target.z)
  _anchorQuat.identity()
  return { point: _anchorPoint, quaternion: _anchorQuat }
}

/** 球坐标读数 → 相对注视点的偏移向量（夹掉两个退化端点，同 cameraOrbitPosition）。 */
function orbitOffset(orbit: CameraOrbit, out: THREE.Vector3): THREE.Vector3 {
  const elevation = THREE.MathUtils.clamp(
    orbit.elevation,
    -MAX_ELEVATION_DEG,
    MAX_ELEVATION_DEG
  )
  _spherical.set(
    Math.max(orbit.distance, MIN_AIM_DISTANCE),
    (90 - elevation) * THREE.MathUtils.DEG2RAD,
    orbit.azimuth * THREE.MathUtils.DEG2RAD
  )
  return out.setFromSpherical(_spherical)
}

/**
 * 跟拍装置此刻要求的机位站位（**父层坐标**，可直接交给求值层）。
 *
 * 参照点与朝向都取目标**此刻**的世界读数，故它必须在目标那一帧的位置/朝向全部落地之后再算
 * （见 applyTimelineAt 里的机位循环）；算早一帧，镜头就永远慢目标一帧。
 */
export function cameraFollowPosition(
  editor: any,
  camera: any,
  out = new THREE.Vector3()
): THREE.Vector3 | null {
  const rig = getCameraFollowRig(camera)
  const anchor = rig ? resolveAimAnchor(editor, camera) : null
  if (!rig || !anchor) return null

  // 锚点与对准用的是同一个点（见 resolveAimAnchor），两处不同源的话镜头会盯着一处、绕着
  // 另一处转。锚点是父层坐标，故两支都是「锚点 + 一个父层方向」。
  if (!isOrbitRig(rig)) {
    // 固定方位：存的就是一份父层轴向的偏移，直接加——锚点怎么转都不参与。
    _offset.fromArray(rig.offset)
    return out.copy(anchor.point).add(_offset)
  }

  // 锁定视角：球坐标偏移**按锚点的世界朝向转过**，故锚点转身机位绕到同一侧。转出来是一个
  // 世界方向，而锚点是父层坐标，故换算回父层再相加（方向量只受父层**旋转**影响）。
  orbitOffset(rig, _offset)
  _offset.applyQuaternion(_frameQuat.copy(anchor.quaternion))
  parentDirection(camera, _offset)
  return out.copy(anchor.point).add(_offset)
}

/** 世界**方向**（不是点）→ 机位父层空间：只摘掉父层的朝向，不含平移。 */
function parentDirection(camera: any, direction: THREE.Vector3): THREE.Vector3 {
  const parent = camera?.parent
  if (!parent) return direction
  parent.updateWorldMatrix(true, false)
  _matrix.extractRotation(parent.matrixWorld)
  return direction.applyQuaternion(
    _parentQuat.setFromRotationMatrix(_matrix).invert()
  )
}

/**
 * 读机位**当前**相对锚点的位姿——开启跟拍时拿它把那一刻的读数记下来，属性面板的三个数字
 * 也读它。没有锚点（自由调整、注视目标已删）时返回 null。
 *
 * `frame` 决定读数相对谁；换参照时用它重新读一次，画面因此不动（同 planCameraLookAtSwitch
 * 换算 authored 的取舍：切换本身不该改变画面）。
 *
 * `anchor` 显式指定绕谁量，不给即机位当前的锚点。**换注视模式/换注视目标时要显式给**——那一刻
 * 新锚点还没落到机位身上，不给就量成了相对旧锚点（见 cameraLookAtSwitch.ts 的 planSwitch）。
 */
export function readCameraFollowRig(
  editor: any,
  camera: any,
  frame: CameraFollowFrame = "world",
  anchor?: CameraAimAnchor | null
): CameraFollowRig | null {
  camera.updateWorldMatrix(true, false)
  return cameraFollowRigFromWorld(
    editor,
    camera,
    _worldPosition.setFromMatrixPosition(camera.matrixWorld),
    frame,
    anchor
  )
}

/**
 * 由一个**世界坐标的站位**反推跟拍装置的读数——「把机位放在这儿，相对锚点就是这个位姿」。
 *
 * 这是**调整跟拍相对位置**的唯一入口：跟拍期间站位由装置驱动（求值层 override），谁再去写
 * authored 都会被顶掉，所以视口拖手柄、面板改「机位角度」都得折回装置本身来（同轨迹片段里
 * 拖对象被路径「吸收」的那条取舍）。**不要**在这些入口里改回写 `camera.position`——那不是
 * 「没生效」，而是写进了一份此刻不参与合成的数据，用户看到的是手一松就弹回去。
 */
export function cameraFollowRigFromWorld(
  editor: any,
  camera: any,
  worldPosition: THREE.Vector3,
  frame: CameraFollowFrame = "world",
  /** 绕谁量；不给即机位当前的锚点（见 readCameraFollowRig）。 */
  explicitAnchor?: CameraAimAnchor | null
): CameraFollowRig | null {
  const anchor = explicitAnchor ?? resolveAimAnchor(editor, camera)
  if (!anchor) return null

  // 锚点是父层坐标，入参是世界坐标——先把锚点搬到世界里，差出来的就是世界方向。
  _point.copy(anchor.point)
  parentToWorld(camera, _point)
  _offset.copy(worldPosition).sub(_point)

  if (frame === "world") {
    // 固定方位存的是**父层轴向**的偏移（与 camera.position 同一层），故把世界方向换算回去。
    parentDirection(camera, _offset)
    return { frame: "world", offset: _offset.toArray() }
  }

  // 锁定视角：反着转回锚点的参照系里再拆成球坐标。正变换在 cameraFollowPosition，两者必须
  // 同源（都用 anchor.quaternion），各写一份的话「设进去的读数」与「量出来的读数」会对不上。
  _offset.applyQuaternion(_frameQuat.copy(anchor.quaternion).invert())
  _spherical.setFromVector3(_offset)
  return {
    frame: "rigid",
    azimuth: _spherical.theta * THREE.MathUtils.RAD2DEG,
    elevation: 90 - _spherical.phi * THREE.MathUtils.RAD2DEG,
    distance: Math.max(_spherical.radius, MIN_AIM_DISTANCE)
  }
}

/**
 * 把跟拍装置落地成求值层的 override 分量；返回这一趟有没有动过它。
 *
 * 与 applyMotionPlacement 同一形状（含「关掉之后要撤掉分量」那一步）：不撤的话关掉跟拍、
 * 或目标被删之后，机位会僵在最后一次算出来的位置上，而 authored 里明明还存着用户摆的站位。
 */
export function applyCameraFollow(editor: any, camera: any): boolean {
  const applied = Boolean(camera?.userData?.cameraFollowApplied)
  const point = cameraFollowPosition(editor, camera, _followPoint)

  if (!point) {
    if (!applied) return false
    setEvaluated(camera, CAMERA_FOLLOW_SOURCE, "position", null)
    camera.userData.cameraFollowApplied = false
    return true
  }

  setEvaluated(
    camera,
    CAMERA_FOLLOW_SOURCE,
    "position",
    point.toArray(),
    "override"
  )
  camera.userData.cameraFollowApplied = true
  return true
}

/** 世界坐标 → 机位所在的那一层坐标（机位一般直挂场景，父层带变换时才有区别）。就地改写。 */
function worldToParent(camera: any, point: THREE.Vector3): THREE.Vector3 {
  const parent = camera?.parent
  if (!parent) return point
  parent.updateWorldMatrix(true, false)
  return parent.worldToLocal(point)
}

/**
 * 机位所在的那一层坐标 → 世界坐标（worldToParent 的逆，同样就地改写）。
 *
 * 注视点存的是父层坐标（见 CameraLookAtState.target），而视口叠加层（注视装置的连线与手柄）
 * 与对准数学要的是世界坐标，换算一律经这一对函数，**不要**在调用方各自 `parent.localToWorld`
 * ——机位没有父节点时的退化分支迟早会漏掉一处。
 */
export function parentToWorld(
  camera: any,
  point: THREE.Vector3
): THREE.Vector3 {
  const parent = camera?.parent
  if (!parent) return point
  parent.updateWorldMatrix(true, false)
  return parent.localToWorld(point)
}

// ————————————————————————————————————————————————————————————————
// 模式切换
// ————————————————————————————————————————————————————————————————

/** 切换注视模式时要一并写下去的两份数据：新的注视状态 + 新的 authored 朝向。 */
export interface CameraLookAtSwitch {
  state: CameraLookAtState
  /** authored 四元数（xyzw）——切换前后画面不跳变，全靠这一份换算。 */
  rotation: number[]
}

/**
 * 算出「切到这个模式」该写的注视状态与 authored 朝向。
 *
 * 两条不变式，缺一不可：
 *   ①**注视角度（authored）在 aim 模式之间原样带走**——它是一条**相对量**（镜头相对「正对着
 *     锚点」又转过了多少），换个锚点它照样成立。需求原话：「注视角度是相对旋转不要变」。
 *     只有**自由调整 ⇄ aim** 那一对才必须换算：自由调整下 authored 装的是完整世界朝向，含义
 *     与偏移不同，不换算的话切过去镜头会当场甩出去（换算出来的残差恒是纯滚转，见
 *     currentRollQuaternion）。
 *   ②**切换本身不改变画面**——切到手动收下完整朝向、对准分量撤掉，合成结果不变；切到位置把
 *     锚点摆在**零偏移视线**上（下面那一段），故对准出来的分量恰好等于此刻那一份。
 *
 * 早先切到位置时是「锚点摆在**当前视线**上 + authored 压成纯滚转」：画面确实不跳，但用户设
 * 好的俯仰偏/水平偏被**吸进了锚点位置里**，面板上那两个读数当场清零（用户报的「注视角度又
 * 变回去了」）。**不要**改回去——两条不变式可以同时成立，见 aimRayPoint。
 */
export function planCameraLookAtSwitch(
  camera: any,
  mode: CameraLookAtMode,
  targetUuid: string | null = null
): CameraLookAtSwitch {
  const state = ensureCameraLookAt(camera)

  if (mode === "free") {
    return {
      state: { mode: "free", targetUuid: null, target: { ...state.target } },
      rotation: camera.quaternion.toArray()
    }
  }

  // aim → aim 原样带走（不变式 ①）；自由调整 → aim 才换算成偏移。
  const rotation = isCameraAimed(camera)
    ? [...readAuthored(camera, "quaternion")]
    : currentRollQuaternion(camera).toArray()

  if (mode === "object") {
    return {
      state: { mode: "object", targetUuid, target: { ...state.target } },
      rotation
    }
  }

  // 位置模式：注视点沿**零偏移视线**摆放，距离沿用上一次的注视距离。
  // 注视点与 camera.position 同为父层坐标，故这个距离量得下去（早先 target 存世界坐标时，
  // 舞台一带变换这里就是两个坐标系相减，切模式会把注视距离量错）。
  _point.set(state.target.x, state.target.y, state.target.z)
  const distance = _point.distanceTo(camera.position)
  const next = aimRayPoint(
    camera,
    rotation,
    distance > MIN_AIM_DISTANCE ? distance : undefined
  )
  return {
    state: {
      mode: "point",
      targetUuid: null,
      target: { x: next.x, y: next.y, z: next.z }
    },
    rotation
  }
}

/**
 * 「把注视角度摘掉之后，镜头正对着哪儿」——沿那条射线取 `distance` 处的一点（父层坐标）。
 *
 * 这是切到位置模式时锚点该去的地方：设锚点在此，对准分量算出来恰好等于此刻节点上那一份
 * （`q_node = R_对准 · R_authored` ⟹ `R_对准 = q_node · R_authored⁻¹`），于是**画面不动**，而
 * authored（注视角度）原样留着——两条不变式同时成立。
 *
 * 与 `deriveAimPoint`（沿**当前视线**取点）的分野正在这里：那一条会把偏移吸进锚点位置，
 * 读数随之清零。自由调整切过来时两者同解——那时传进来的 rotation 已经是纯滚转残差，摘掉它
 * 剩下的正是当前视线。
 */
function aimRayPoint(
  camera: any,
  authored: number[],
  distance = DEFAULT_AIM_DISTANCE
): THREE.Vector3 {
  _aimQuat
    .copy(camera.quaternion)
    .multiply(_rollQuat.fromArray(authored).invert())
  return new THREE.Vector3(0, 0, -1)
    .applyQuaternion(_aimQuat)
    .multiplyScalar(Math.max(distance, MIN_AIM_DISTANCE))
    .add(camera.position)
}

/**
 * 标记「这台机位的 authored 朝向是 ≤v3 那种完整朝向，进场时要归一成纯滚转」。
 *
 * 由 codec 在恢复旧场景时打上（版本号只有它知道），由 ensureShotLookAt 消费一次即清掉。
 * 用一次性标记而不是让 codec 直接归一：分解要拿机位此刻的世界朝向，恢复途中还没有。
 */
export function markLegacyCameraRotation(camera: any): void {
  if (!camera?.isCamera) return
  camera.userData.legacyAimRotation = true
}

/** 取走并清掉上面那个标记（只自愈一次，此后 authored 归用户）。 */
function consumeLegacyCameraRotation(camera: any): boolean {
  if (camera?.userData?.legacyAimRotation !== true) return false
  delete camera.userData.legacyAimRotation
  return true
}

/**
 * 旧数据（DIRECTOR_SCENE_VERSION ≤ 3）的注视状态迁移。
 *
 * 那时只有两种模式，`'manual'` 的含义是「对准过一次，此后朝向自由」——朝向可以早已不在
 * 那一点上（用户转过机位、或机位视角漫游过）。新的「位置」是**持续锁定**，照搬过去会让
 * 旧场景一打开就有机位当场转向一个陈旧的坐标，故一律迁到「手动」，朝向原样保留。
 *
 * 例外是**已经为「注视位置」打过关键帧**的机位：那条轨道的意义就是让镜头逐帧跟着一个点走，
 * 迁到手动它会静默失效，故迁到「位置」。判据由调用方给（轨道表不在本文件的职责里）。
 */
export function migrateLegacyCameraLookAt(
  // mode 是 string 而不是 CameraLookAtMode：入参正是「还没迁移的那一份」，里面装着
  // 早已不在联合类型里的 'manual'。
  state: Omit<CameraLookAtState, "mode"> & { mode: string },
  hasAimTrack: boolean
): CameraLookAtState {
  if (state.mode === "manual")
    return { ...state, mode: hasAimTrack ? "point" : "free" }
  return { ...state, mode: state.mode === "object" ? "object" : "free" }
}

// 全局跟随逻辑：被注视的图形移动时，所有跟随它的机位重新对准；
// 机位自身移动时同样保持对准注视点（类似云台锁定目标）。
// 朝向是由注视状态派生的，经求值层落地而不走命令，不进入撤销历史
// （注视状态本身的面板变更则经 SetCameraLookAtCommand 进历史）。
export function useCameraLookAt(editor: any) {
  const signals = editor.signals
  let applying = false

  /**
   * 机位一进场就把注视状态建起来（**不改朝向**：建的是由当前朝向推导的那一点），
   * 已是 aim 模式的（存档恢复出来的那些）当场对准一次——存档里存的是 authored（倾斜），
   * 对准分量是派生量、不进持久化，不补这一下机位会停在只带倾斜的朝向上。
   *
   * 这一步也是「注视位置」成为一条时间轴轨道的前提。轨道的取值靠 `read` 回答，而
   * 「没有状态时退到推导点」这条退化分支是**跟着朝向走**的：用户转一下机位，推导点
   * 就变了，自动补帧会据此凭空补出一个注视关键帧。让状态从机位诞生那一刻就存在，
   * `read` 便只读用户/关键帧写的那一份，与朝向解耦。
   */
  function ensureShotLookAt(object: any): void {
    if (!object?.isCamera || object.userData?.isDirectorShot !== true) return
    ensureCameraLookAt(object)
    if (!isCameraAimed(object)) return
    // 只有 codec 标记过的**旧数据**才归一成纯滚转（≤v3 的 authored 里躺的是完整朝向，
    // 照今天「注视角度」的含义解释就是一份巨大的偏移，镜头会朝陈旧方向歪出去）。
    //
    // 判定放在 codec、执行放在这里，是因为两件事各有各的时机：版本号只有 codec 知道，
    // 而分解要拿机位此刻的世界朝向（见 currentRollQuaternion），恢复途中还不成立。
    // **不要**改回「每次进场都无条件归一」——放开三轴之后，那等于每次重新打开导演台都把
    // 用户调好的取景偏移抹平一次。
    if (consumeLegacyCameraRotation(object)) {
      writeAuthored(
        object,
        "quaternion",
        currentRollQuaternion(object).toArray()
      )
    }
    applyCameraLookAt(editor, object)
  }

  function onObjectChanged(object: any) {
    if (applying || !object) return
    applying = true
    try {
      if (object.isCamera) {
        // aim 模式随机位移动重新对准（云台锁定目标）：位置模式下挪机位就是绕注视点
        // 转，跟随模式下就是换个位置看同一个人。手动模式不对准——朝向归用户。
        if (!isCameraAimed(object)) return
        // 顺序是「跟拍定站位 → 对准」：后一步是前一步的下游，反过来会拿上一轮的站位
        // 去算这一轮的朝向，画面上是镜头慢一步。
        const followed = applyCameraFollow(editor, object)
        if (applyCameraLookAt(editor, object) || followed) {
          signals.objectChanged.dispatch(object)
        }
        return
      }
      for (const camera of camerasFollowing(editor, object)) {
        // 被跟随的图形动了：开了跟拍的机位整套跟过去，没开的只转不挪（摇镜跟拍）。
        const followed = applyCameraFollow(editor, camera)
        if (applyCameraLookAt(editor, camera) || followed) {
          signals.objectChanged.dispatch(camera)
        }
      }
    } finally {
      applying = false
    }
  }

  onMounted(() => {
    signals.objectChanged.add(onObjectChanged)
    signals.objectAdded.add(ensureShotLookAt)
    // 本 composable 挂载前就已在场的机位（组件晚于场景挂载）补建一次。
    for (const camera of Object.values(editor.cameras) as any[])
      ensureShotLookAt(camera)
  })

  onBeforeUnmount(() => {
    signals.objectChanged.remove(onObjectChanged)
    signals.objectAdded.remove(ensureShotLookAt)
  })
}
