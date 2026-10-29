import { computed, readonly, ref } from "vue"

import { isCameraAimed } from "./cameraLookAt"
import { activeDirectorSelection } from "./directorSelection"
import type { DirectorTransformMode } from "./useDirectorTransform"

/**
 * 带路径的片段轨道（镜头站位 `motion` / 机位注视点 `aimMotion`）。
 *
 * 源项目问时间轴注册表（timeline/directorTimeline 的 isMotionClipTrack，判据是轨道定义的
 * hasPath）。本仓库没有迁移时间轴，这里把那两条轨道的 key 写成常量，只为保持调节器归属的
 * 规则与源项目一致——没有时间轴时选区里本就不会出现片段。
 */
const MOTION_CLIP_TRACKS: ReadonlySet<string> = new Set(["motion", "aimMotion"])

function isMotionClipTrack(track: string | null | undefined): boolean {
  return Boolean(track && MOTION_CLIP_TRACKS.has(track))
}

// 导演台视口里**同时只出现一个变换调节器（gizmo）**——这份状态就是那条不变式的单点源。
//
// 为什么需要它：导演台里能挂 TransformControls 的地方已经有四处，各自建了自己的实例（理由见
// 各自文件：共享 gizmo 会往历史塞一条针对被拖对象的裸变换命令，而它们要落的是别的东西）：
//   · 对象自己的变换 gizmo —— `editor.transformControls`，由 Viewport 在 objectSelected 里挂；
//   · 关节旋转 —— useCharacterJointControls（姿势页）；
//   · 轨迹路径点 —— useDirectorMotionPath 的 nodeTC；
//   · 轨迹整体 —— useDirectorMotionPath 的 pathTC。
//
// 各方原先都是「自己动手把别人摘掉」（一个布尔闩 + `editor.transformControls.detach()`），这条
// 路必然漏：闩记的是「我摘过了」，而 Viewport 在**每一次** objectSelected 里都会重新 attach
// ——摘过之后用户再点一下模型，对象 gizmo 就回来了，而摘它的那一方以为自己还摘着，于是视口里
// 同时出现两个调节器（选中轨迹片段后再点一下模型即可复现）。
//
// 改为：**从选区派生**。「调节器归谁」与「现在选中的是什么」本就是同一个问题的两种问法，
// 各存一份就要手工对账（此前 `setDirectorGizmoOwner('motionNode')` 必须与 `selectedNodeIndex`
// 保持一致，还要反过来监听所有权把选中态清掉）。现在选区是唯一的存储（见 directorSelection），
// 本文件只把它翻译成「哪一份 gizmo 出场」。
//
// 「后来者居上」这条语义没有变，只是落到了选区上：用户最后一次点的是什么，选区就是什么，
// 调节器随即跟过去。
//
// 一条纪律留着：**挂 gizmo 之前问 `ownsDirectorGizmo`**，别只在自己那一侧记一个布尔。
//
// 跨 Editor 实例存活，故导演台挂载时要 `resetDirectorGizmoOwner()`（同其余模块级状态，
// 见 .claude/rules/three-editor.md §3）。

export type DirectorGizmoOwner =
  | "object"
  | "motionPath"
  | "motionNode"
  | "joint"

/** 缺省归对象自己——选区为空、或选中的是与视口调节器无关的东西（关键帧、连线段）时。 */
const DEFAULT_OWNER: DirectorGizmoOwner = "object"

/**
 * 姿势编辑上下文开着吗（= 姿势页挂载期间为真，由 useCharacterJointControls 声明与交还）。
 *
 * 它回答的**不是**「现在选中的是什么」，而是「哪一种编辑上下文开着」——两个问题，故是两份
 * 状态，不是选区的拷贝。选区答不了这一问：姿势页开着的时候用户照样会去点一颗姿势关键帧
 * （时间轴上点关键帧正是**跳到**姿势页的路），那一下选区变成 `keyframe`，可姿势模式并没有
 * 结束。只按选区派生的话，缺省项会把角色级的位置/旋转/缩放手柄放出来——而那正是姿势模式
 * 明确不给的东西（摆姿只操作关节），视口里于是同时出现关节圆环与角色 gizmo。
 *
 * 落点是**缺省项**而不是最高优先级：「后来者居上」这条语义不变——姿势页开着时去点一格轨迹
 * 片段或一个路径点，调节器照样归它们。变的只是「没有更具体的东西被选中」时退到哪一份。
 */
const poseEditing = ref(false)

/** 进入/退出姿势编辑（唯一调用方是 useCharacterJointControls 的挂载与卸载）。 */
export function setDirectorPoseEditing(active: boolean): void {
  if (poseEditing.value !== active) poseEditing.value = active
}

/**
 * 现在的调节器归谁——**选区的派生量**，没有 setter。
 *
 * 对照表即全部规则：
 *   · 路径点（index 非空）→ 那个点的手柄；选中整条路径（index 为 null）→ 整体手柄。
 *     选中的是那个点的**贝塞尔调整点**时（handle 非空）同样归 'motionNode'——调节器还是那一个
 *     移动手柄，只是挂到了手柄小球上，故这里不必多一种归属；
 *   · 一格**轨迹**片段 → 整条路径的手柄（其余轨道的片段与视口调节器无关，归对象）；
 *   · 关节（含姿势页刚打开、还没点具体哪个关节的 groupKey=null 态）→ 关节手柄；
 *   · 其余（对象本体、机位注视点、关键帧、连线段）→ 缺省那一份。机位注视点跟着 'object'
 *     走是**刻意**的：注视装置本就是 aim 模式机位的那个「对象 gizmo」，只是换了形态，
 *     镜头手柄与注视点手柄由它自己按选区分（见 useDirectorCameraRig）。
 *
 * 缺省那一份不恒为 'object'：姿势编辑上下文开着时它是 'joint'（见 poseEditing）。
 */
export const directorGizmoOwner = computed<DirectorGizmoOwner>(() => {
  const fallback: DirectorGizmoOwner = poseEditing.value
    ? "joint"
    : DEFAULT_OWNER
  const item = activeDirectorSelection.value
  if (!item) return fallback
  switch (item.kind) {
    case "pathNode":
      return item.index === null ? "motionPath" : "motionNode"
    case "clip":
      // 轨迹类的片段（镜头站位 / 机位注视点两条轴）才有路径可调，其余片段与视口调节器无关。
      return isMotionClipTrack(item.track) ? "motionPath" : fallback
    case "joint":
      return "joint"
    default:
      return fallback
  }
})

export function ownsDirectorGizmo(candidate: DirectorGizmoOwner): boolean {
  return directorGizmoOwner.value === candidate
}

/**
 * 指针此刻是不是压在某个**导演台自建**调节器的手柄上。
 *
 * 机位视角的第一人称导航（useDirectorCameraControls）据它让路：那一侧原本只问
 * `editor.transformControls.axis`，而自建的那些调节器是**另外的实例**，问不到——表现是
 * 抓住手柄一拖，机位跟着一起转。装置调节器出场时机位往往正是被取景的那一个，故必须有这
 * 一处答案；将来别的自建调节器要在机位视角下可用时，同样在自己的 `axis-changed` 里写它。
 */
const gizmoGrabbed = ref(false)

export const directorGizmoGrabbed = readonly(gizmoGrabbed)

export function setDirectorGizmoGrabbed(grabbed: boolean): void {
  if (gizmoGrabbed.value !== grabbed) gizmoGrabbed.value = grabbed
}

export function resetDirectorGizmoOwner(): void {
  // 所有权本身已是选区的派生量，无须（也无从）复位——复位选区即可，见 resetDirectorSelection。
  gizmoGrabbed.value = false
  // 姿势编辑上下文不是派生量，故要复位：上一次会话停在姿势页上时，新场景一打开角色级
  // gizmo 会因为一个早已不成立的上下文而始终不出场。
  poseEditing.value = false
  // 对象侧的限制同为模块级状态，一并复位——上一次会话停在机位上时，新场景一打开
  // 缩放按钮会因为一条早已不成立的限制而始终置灰。
  objectModes.value = ALL_TRANSFORM_MODES
}

// ————————————————————————————————————————————————————————————————
// 公共 helper 工具栏对各调节器开放哪几种模式
//
// 导演台里所有调节器共用右上角那一个工具栏（移动/旋转/缩放，见 DirectorTransformControls），
// 故「现在这个按钮能不能按」必须有一处答案——按下一个什么也不会发生的按钮，用户读到的是
// 「工具栏坏了」。声明在这里而不是工具栏组件里：工具栏与 useDirectorTransform 都不认识具体
// 是谁在被调节，而所有权本就住在本文件。
//
// 答案由**两问相交**得出，两者语义不同，刻意分开：
//   ①**调节器**认不认这个模式（下表 DIRECTOR_GIZMO_TRANSFORM_MODES，按所有权取）；
//   ②**被调节的那个对象**支不支持这种变换（objectModes，由对象 gizmo 的裁决点写入，
//     见 useDirectorObjectGizmo）——机位不给「缩放」：把镜头拉大拉小没有意义，机位的
//     取景范围由 FOV 表达。
// 相交而不是二选一：两条约束可以同时成立。
//
// motionNode / joint 的调节器内部同样是固定模式（前者恒 translate、后者恒 rotate），但它们的
// 工具栏此前一直是全开的，收紧会连带改动轨迹页与姿势页的既有手感，故此处按现状留全集；要收紧
// 时改这一处即可，工具栏与 useDirectorTransform 都不必动。
// ————————————————————————————————————————————————————————————————

const ALL_TRANSFORM_MODES: DirectorTransformMode[] = [
  "translate",
  "rotate",
  "scale"
]

export const DIRECTOR_GIZMO_TRANSFORM_MODES: Record<
  DirectorGizmoOwner,
  DirectorTransformMode[]
> = {
  object: ALL_TRANSFORM_MODES,
  motionPath: ALL_TRANSFORM_MODES,
  motionNode: ALL_TRANSFORM_MODES,
  joint: ALL_TRANSFORM_MODES
}

/**
 * 选中的是个被注视驱动的机位时，这一下变换归**装置调节器**而不是对象自己的 gizmo——
 * 返回它该以哪种模式出场，null 即让位给对象 gizmo（见 useDirectorCameraRig 的文件头）。
 *
 * 判据收在这里是因为它有**两个**消费方：装置调节器据它决定出不出场，对象 gizmo 的裁决点
 * （useDirectorObjectGizmo）据它决定挂不挂。各判各的必然会出现「两个调节器并存」或「一个
 * 都没有」——那正是 gizmo 所有权这套机制最初要解决的那类不一致。
 *
 * aim 模式下**移动与旋转都归它**：移动那一下不只是挪机位（位置模式还多一个摆在注视点上的
 * 整体平移手柄），旋转那一下更不是普通旋转（只给绕视线那一个环 = 倾斜）。交给对象 gizmo 的
 * 话，它会把整份朝向写进 authored，而 authored 在 aim 模式下只该装倾斜——镜头会当场偏出去。
 * 缩放不在此列（机位本就没有，见 resolveObjectTransformModes）。
 */
export function resolveCameraRigMode(
  object: any,
  mode: DirectorTransformMode
): DirectorTransformMode | null {
  if (!isCameraAimed(object)) return null
  return mode === "translate" || mode === "rotate" ? mode : null
}

/**
 * 一个对象支持哪几种变换——「对象 gizmo 挂在它身上时，工具栏该开放什么」的单点源。
 *
 * 机位不给缩放：镜头没有大小，取景范围由 FOV 表达（时间轴上机位同样没有缩放轨道，见
 * TIMELINE_PROPERTIES 的 scale.supports；机位属性面板里也没有缩放字段）。判据不能与
 * 时间轴那一条合并成一个函数：**群众分组**在这里要给缩放（它的缩放手柄改的是成员间距，
 * 见 Viewport 的 crowdSpacing），在时间轴上却没有缩放轨道，两处答案本就不同。
 *
 * 骨骼只给旋转那一条留在引擎层（Viewport 的 objectSelected）：那是 three-editor 自己的
 * 约束，与导演台无关。
 */
export function resolveObjectTransformModes(
  object: any
): DirectorTransformMode[] {
  if (object?.isCamera) return ["translate", "rotate"]
  return ALL_TRANSFORM_MODES
}

/**
 * 对象 gizmo 此刻挂在谁身上所带来的限制（没挂时即全集）。
 *
 * 由 useDirectorObjectGizmo 单方写入——那里本就是「对象 gizmo 挂不挂、挂给谁」的唯一裁决点，
 * 挂载判定与限制发布出自同一处，才不会出现「gizmo 已经换了对象、工具栏还按上一个置灰」。
 */
const objectModes = ref<DirectorTransformMode[]>(ALL_TRANSFORM_MODES)

export function setDirectorObjectTransformModes(
  modes: DirectorTransformMode[]
): void {
  // 判等短路：本函数挂在每次选中变化上，而它驱动的是工具栏的重渲染。
  const same =
    modes.length === objectModes.value.length &&
    modes.every((mode, index) => objectModes.value[index] === mode)
  if (!same) objectModes.value = modes
}

/** 此刻工具栏该开放哪几种模式（调节器与被调节对象两条约束相交）。 */
export const allowedDirectorTransformModes = computed<DirectorTransformMode[]>(
  () => {
    const byOwner =
      DIRECTOR_GIZMO_TRANSFORM_MODES[directorGizmoOwner.value] ??
      ALL_TRANSFORM_MODES
    return byOwner.filter((mode) => objectModes.value.includes(mode))
  }
)

export function isDirectorTransformModeAllowed(
  mode: DirectorTransformMode
): boolean {
  return allowedDirectorTransformModes.value.includes(mode)
}

/**
 * 当前模式不再可用时该退到哪一种。
 *
 * 一律优先「移动」：三种模式里只有它对任何对象都成立，也是用户按下去最不会出意外的那一个
 * （需求原话「缩放中选中了机位，变成移动位置」）。
 */
export function fallbackDirectorTransformMode(): DirectorTransformMode {
  const allowed = allowedDirectorTransformModes.value
  return allowed.includes("translate")
    ? "translate"
    : (allowed[0] ?? "translate")
}
