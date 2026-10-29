import { onBeforeUnmount, onMounted, watch } from "vue"
import * as THREE from "three"
import { TransformControls } from "three/addons/controls/TransformControls.js"

import { markShotViewHelper } from "@/components/three-editor/shotViewHelpers"
import { enableTransformShiftEven } from "@/components/three-editor/transformShiftEven"
import { SetPositionCommand } from "@/components/three-editor/commands/SetPositionCommand"
import { SetRotationCommand } from "@/components/three-editor/commands/SetRotationCommand"
import {
  readAuthored,
  writeAuthored
} from "@/components/three-editor/EvaluatedTransform"
import { SetCameraLookAtCommand } from "@/components/three-editor/commands/SetCameraLookAtCommand"

import {
  applyCameraFollow,
  applyCameraLookAt,
  authoredAfterWorldDelta,
  cameraFollowRigFromWorld,
  cloneCameraLookAt,
  getCameraLookAt,
  getCameraLookAtMode,
  isCameraAimed,
  type CameraFollowRig,
  isCameraFollowingPosition,
  isOrbitRig,
  parentToWorld,
  readCameraLookAtPoint,
  writeCameraLookAtPoint,
  type CameraLookAtState
} from "./cameraLookAt"
import {
  directorGizmoOwner,
  ownsDirectorGizmo,
  resolveCameraRigMode,
  setDirectorGizmoGrabbed
} from "./directorGizmoOwner"
import {
  activeDirectorSelection,
  activeDirectorSelectionOf,
  selectDirectorItem
} from "./directorSelection"
import type { DirectorTransformMode } from "./useDirectorTransform"

// 机位「注视装置」的**视口那一侧**：把镜头到注视点的那条线画出来，并让这套装置可拖。
//
// aim 模式（位置 / 跟随，见 cameraLookAt.ts）下机位与注视点是一套装置，视口里因此有**两个
// 手柄、两种模式**：
//   · **移动**——
//       ① **镜头**上的移动手柄：自由挪机位，镜头始终盯着注视点。它就是面板上「机位角度」
//          那一行（X角度 / Y角度 / 距离）的可视化版本——那三个量正是站位相对注视点的球
//          坐标，故这里不必也**不该**把它约束成定半径的环：拖远拖近就是改距离。
//       ② **注视点**上的移动手柄（仅注视位置模式）：**只挪锚点**，机位站位不动、镜头随即转
//          过去（开了跟拍的话站位是锚点的派生量，自动跟过来）。早先这里是「整套平移」，那条
//          行为已由跟拍开关接管，见 onGizmoObjectChange 的 target 分支。注视对象模式没有这
//          一个：那时锚点由被注视的图形给出，挪不动。
//          注视点**没有旋转手柄**：一个点转不了（需求原话「注视位置不能旋转」）。选着它却切到
//          旋转模式时**一个手柄都不出**，而不是退回镜头那一个——退回去的话，用户明明选着注视点、
//          转出来的却是机位的注视角度。
//   · **旋转**——镜头上的**三个圆环**，基底取视线：绕 Z（= 视线）是「倾斜」，绕 X/Y 是俯仰偏
//     与水平偏。三个环合起来就是面板上的「注视角度」——镜头相对「正对着目标」又转过了多少
//     （见 cameraLookAt.ts 的注视角度小节），故目标可以不落在画面正中央（过肩、留前进空间）。
//     早先只给绕视线那一个环，另外两个方向在视口里没有入口、只能回面板填数字。它们与移动
//     手柄不打架：移动改的是「机位在哪」（连带对准），旋转改的是「在对准之上再偏多少」。
//
// 与 useDirectorMotionPath 同一套做法（视口里直接操作一份领域数据的既有先例），几处约定
// 一模一样，改这里之前先读那份文件头：
//   · 叠加层挂在 editor.sceneHelpers 上并打 markShotViewHelper（机位视角下也要看得见，否则
//     「点得到却看不见」）；
//   · 拖动用**独立的** TransformControls，不复用 editor.transformControls——共享 gizmo 在
//     mouseUp 时会往历史塞一条针对被拖对象（这里是机位本身）的裸变换命令，而我们要落的是
//     「挪锚点」「挪机位并重新对准」或「改注视角度」；
//   · 「同时只出现一个调节器」经 directorGizmoOwner 仲裁。本方**不声明所有权**：它就是
//     aim 模式机位的那个「对象 gizmo」，故跟着 'object' 这一份走——所有权归别人（点了路径点、
//     开了姿势页）时自己收摊，回到 'object' 时自己回来。对象 gizmo 那一侧据同一个判据让位
//     （见 useDirectorObjectGizmo），两处必须共用 resolveCameraRigMode，各判各的必然会出现
//     「两个调节器并存」或「一个都没有」。
//
// 两个手柄是**两个 TransformControls 实例**，但**同一时刻只出场一个**：机位是「一个对象含
// 两个可调元素」的那一类，故它有一个「现在调的是哪一个」的状态——就是选区里的
// `{kind:'object'}`（镜头本体）与 `{kind:'cameraTarget'}`（注视点），见 directorSelection。
// 缺省是镜头；视口里点一下注视点上那颗小球即切过去，点别处再切回来。
//
// 此前两个手柄**同时在场**（当时的需求是「位置可调两处」），代价是位置模式下视口里凭空多出
// 一个调节器，用户读不出自己正在调哪一个——这正是本次要消掉的现象。**不要**改回去：要同时
// 露出两处可调点，露的应是「可点选的小球」（本文件的 targetPicker），而不是第二个调节器。
//
// 两个手柄**都要**把「指针压在我身上」报给 directorGizmoGrabbed——机位视角的第一人称导航问
// 的是引擎那个共享 gizmo 的 axis，问不到这两份，不报的话抓住手柄一拖、机位跟着一起转。
//
// 画给谁：**选中的那个机位**。与轨迹「只画选中对象的」同一条理由——这条线是「这个机位在看
// 哪儿」的读数，全场机位一起画会把视口糊成一团线。透过某个机位取景时不画它自己那一条
// （连线在画面正中缩成一个点，纯属遮挡），镜头上那个手柄同样不给（它正摆在眼睛上），只留
// 注视点那一个；那时挪机位走第一人称漫游。
// 手动调整模式下线与手柄都不给：那时机位不看任何一点，它与普通图形一样归对象 gizmo。

/** 叠加层根节点名（sceneHelpers 里按名字找，同骨架线/轨迹的约定）。 */
const OVERLAY_NAME = "director-camera-rig-overlay"

/**
 * 连线只有**一支颜色**：位置模式与跟随模式画的是同一件事——「这个机位在看哪儿」。
 *
 * 早先跟随模式另给一支灰蓝（照搬轨迹「非编辑态」的配色，理由是注视点不由用户说了算），
 * 代价是它在深色场景里几乎看不出来，用户读到的是「跟随对象时根本没有连线」。可不可调是
 * 手柄与小球回答的问题（跟随模式下两者都不给），不该由这条读数线的可见度去暗示。
 */
const COLOR_LINE = 0x2cfff8

/** 机位与注视点的最小间距：贴到一起时「看哪儿」就没有方向可言了。 */
const MIN_AIM_DISTANCE = 0.05

/** 注视点上那颗可点选小球的半径（与轨迹路径点手柄同一量级，视觉上是同一类东西）。 */
const TARGET_PICKER_RADIUS = 0.09
const COLOR_TARGET_PICKER = 0xffffff
const COLOR_TARGET_PICKER_ACTIVE = 0x2cfff8

/** 哪一个手柄：镜头上的，还是注视点上的。 */
export type RigHandle = "camera" | "target"

/**
 * 此刻出场的是**哪一个**手柄（null = 一个也不出）。
 *
 * 返回一个值而不是给两个手柄各一个布尔——「同时只出现一个」这条不变式因此是结构性的，
 * 而不是「两个判据恰好不会同时为真」。此前正是两个各自为政的布尔，位置模式 + 移动时双双
 * 为真，视口里就出现了两个调节器（用户读不出自己在调哪一个）。
 *
 * 纯函数、无副作用，故这条规则可以单独验（见 useDirectorCameraRig.spec.ts）。
 */
export function resolveRigHandle(options: {
  /** 装置调节器此刻该以哪种模式出场（null = 不出场，让位给对象自己的 gizmo）。 */
  mode: DirectorTransformMode | null
  /** 正透过这个机位取景吗。 */
  isViewportCamera: boolean
  /**
   * 注视点此刻可不可调。两种情形为假：注视对象模式（那一点由被注视的图形给出，挪不动），
   * 以及**不在移动模式**（注视点是一个点，没有朝向可转，见 CameraLookAtState.target）。
   */
  targetAdjustable: boolean
  /** 选区此刻是不是停在这个机位的注视点上。 */
  targetSelected: boolean
}): RigHandle | null {
  if (!options.mode) return null
  // **正透过这个机位取景时一个手柄都不给**：机位视角下这条镜头的站位与取景一律不由鼠标改，
  // 唯一能调的是滚轮变焦（见 useDirectorCameraControls 的 resolveCameraViewNavigation）。
  // 别的机位不受影响——它们此刻只是画面里的图形，与拖别的对象没有区别。
  //
  // 早先这里只挡住镜头那一个，理由是纯人机的（手柄就摆在眼睛上，糊在画面正中既看不清也点
  // 不准），注视点那一个照给。可它同样是「在这块画面上用鼠标改这一条镜头的取景」，与镜头
  // 手柄是同一件事，故随注视模式禁用鼠标导航一并收掉。要调就回导演视角。
  if (options.isViewportCamera) return null
  // **选区停在注视点上时，手柄只可能是它自己**——可调就给，不可调（切到了旋转模式：注视点
  // 是一个点，转不了）就一个都不给。
  //
  // **不要**在这里退回镜头那一个：用户明明选着注视点，切一下旋转手柄却跳到机位上、转出来的
  // 是机位的注视角度——那正是用户报的「选中注视位置那个点，旋转却到了机位上」。要转机位就
  // 先点一下机位（点别处会退回镜头本体，见 resolveRigClick）。
  if (options.targetSelected) return options.targetAdjustable ? "target" : null
  return "camera"
}

/**
 * 点在视口里的这一下，对注视装置意味着什么。
 *
 *   · `select-target` —— 点中了注视点小球：把「正在调整的」切到注视点；
 *   · `keep-target`   —— 点中小球时它本就选着：什么也不用改；
 *   · `release-target`—— 选着注视点却点在了别处：退回镜头本体；
 *   · `ignore`        —— 与本装置无关。
 *
 * 抽成纯函数是为了让「哪一下该消费掉事件」这条规则可以单独验（见 useDirectorCameraRig.spec.ts）
 * ——它正是「点别的图形要按两下」那个 bug 的所在。
 */
export type RigClickOutcome =
  | "select-target"
  | "keep-target"
  | "release-target"
  | "ignore"

export function resolveRigClick(options: {
  targetAdjustable: boolean
  targetSelected: boolean
  hitPicker: boolean
}): RigClickOutcome {
  if (options.hitPicker && options.targetAdjustable) {
    return options.targetSelected ? "keep-target" : "select-target"
  }
  return options.targetSelected ? "release-target" : "ignore"
}

/**
 * 拖镜头手柄拖出来的那个落点，**该写到哪儿去**。
 *
 *   · `follow-rig` —— 跟拍开着：站位由装置驱动（求值层 override），落点折回装置本身；
 *   · `authored`   —— 其余一律直写 authored（用户摆的那一份站位）。
 *
 * 立场是「站位这条通道此刻归谁，落点就折回谁的数据里」：有 override 在时 authored 一个字
 * 都不参与合成，写它等于什么也没发生。故跟拍那一支必须折回装置本身。
 *
 * **播放头压在一格站位轨迹里时仍写 authored**（曾经有第三种取值 `motion-path`：直写节点、
 * 交给吸收折进路径，已随吸收整体撤掉）。那几秒的站位由路径说了算，视口里的机位因此不跟着
 * 手柄走；改的是**片段之外**的那一份站位。要改这几秒走的路，去线上加点或拖点位
 * （见 useDirectorMotionPath）。
 *
 * 纯函数、无副作用，故这条规则可以单独验（见 useDirectorCameraRig.spec.ts）。
 */
export type RigTranslateTarget = "follow-rig" | "authored"

export function resolveRigTranslateTarget(options: {
  /** 跟拍开着吗（站位是被跟随锚点的派生量）。 */
  following: boolean
}): RigTranslateTarget {
  return options.following ? "follow-rig" : "authored"
}

/**
 * 这一下要不要消费掉（halt 本次派发，不让 Selector 再解释一遍）。
 *
 * **只有点中小球的那两种才消费**：小球是我们自己的东西，交给 Selector 会被解析成「点了机位」。
 * `release-target` 一定**不**消费——那一下用户点的是别的图形或空白，本就该正常生效。
 */
export function rigClickConsumesEvent(outcome: RigClickOutcome): boolean {
  return outcome === "select-target" || outcome === "keep-target"
}

export function useDirectorCameraRig(editor: any) {
  const signals = editor.signals

  let overlay: THREE.Group | null = null
  let line: THREE.Line | null = null
  /** 注视点上那颗可点选的小球（点它即把「正在调整的」从镜头切到注视点）。 */
  let targetPicker: THREE.Mesh | null = null
  /** gizmo 挂的代理对象：它们代表的是「镜头」「注视点」这两个位置，不是场景里的对象。 */
  const proxies: Record<RigHandle, THREE.Object3D | null> = {
    camera: null,
    target: null
  }
  const gizmos: Record<RigHandle, any> = { camera: null, target: null }
  /** 「按住 Shift 让平面手柄两轴等量变化」的卸载函数（见 three-editor/transformShiftEven.ts）。 */
  const shiftEvenOff: Record<RigHandle, (() => void) | null> = {
    camera: null,
    target: null
  }
  /** 当前工具栏模式；由 transformModeChanged 同步，见文件头的「共用判据」。 */
  let transformMode: DirectorTransformMode =
    editor.transformControls?.mode ?? "translate"

  /** 按下那一刻的装置快照：整段拖动在抬手时与最终状态一比即成一条历史。 */
  let dragStart: {
    handle: RigHandle
    mode: DirectorTransformMode
    /** 机位的 authored 站位（父层坐标）。 */
    position: THREE.Vector3
    /** 注视点（**父层坐标**，与 position 同一层，见 CameraLookAtState.target）。 */
    target: THREE.Vector3
    /** 机位的 authored 朝向 = 注视角度（旋转手柄改的就是它）。 */
    authored: THREE.Quaternion
    /**
     * 机位此刻的**世界**朝向。
     *
     * 旋转要把手柄转过的那一份世界差量换算回 authored，而换算需要「世界 = base ·
     * authored」里的 base（= 父层朝向 · 对准）。它由这两份读数当场解出（base = 世界 ·
     * authored⁻¹），故不必再各自去取父层与对准。
     */
    world: THREE.Quaternion
    /** 代理此刻的位姿——差量按它算，而不是在上一帧结果上接着变换（同轨迹整体手柄）。 */
    proxyPosition: THREE.Vector3
    proxyQuaternion: THREE.Quaternion
    state: CameraLookAtState
  } | null = null

  const _origin = new THREE.Vector3()
  const _point = new THREE.Vector3()
  const _delta = new THREE.Vector3()
  const _offset = new THREE.Vector3()
  const _position = new THREE.Vector3()
  const _quat = new THREE.Quaternion()
  const _quatStart = new THREE.Quaternion()
  const _authored = new THREE.Quaternion()
  const _up = new THREE.Vector3(0, 1, 0)
  const _right = new THREE.Vector3()
  const _basisUp = new THREE.Vector3()
  const _forward = new THREE.Vector3()
  const _matrix = new THREE.Matrix4()

  function domElement(): HTMLElement | null {
    return editor.transformControls?.domElement ?? null
  }

  function requestRender(): void {
    // 同其余叠加层：借 cameraChanged 请求一次重绘（Viewport 按需渲染）。
    signals.cameraChanged.dispatch(editor.viewportCamera)
  }

  /**
   * 本装置此刻管的是哪个机位：选中的那个导演机位，且它正被注视驱动。
   *
   * 三种情况不管：选中的不是机位、机位被隐藏（场景面板关掉了它，那时连机位模型带 FOV
   * 椎体都不显示，只剩这条线飘着最费解）、手动调整模式（那时机位不看任何一点）。
   *
   * **正透过它取景的机位照管**：那时拖手柄就是推拉与环绕，正是机位视角下最常做的两件事。
   * 只有连线不画——它在画面正中缩成一个点，纯属遮挡。
   */
  function targetCamera(): any {
    const camera = editor.selected
    if (!camera?.isCamera || camera.userData?.isDirectorShot !== true)
      return null
    if (!camera.visible) return null
    if (!isCameraAimed(camera)) return null
    return camera
  }

  /** 此刻装置调节器该以哪种模式出场（null = 不出场，让位给对象自己的 gizmo）。 */
  function rigMode(camera: any): DirectorTransformMode | null {
    if (!camera || !ownsDirectorGizmo("object")) return null
    return resolveCameraRigMode(camera, transformMode)
  }

  /**
   * 注视点此刻可不可调：**注视位置模式 + 移动**。
   *   · 注视对象模式下那一点由被注视的图形给出，挪不动；
   *   · 旋转模式下它没有可转的东西（一个点没有朝向）——那时 resolveRigHandle 一个手柄都不出。
   */
  function targetAdjustable(camera: any): boolean {
    return (
      rigMode(camera) === "translate" && getCameraLookAtMode(camera) === "point"
    )
  }

  /** 选区此刻是不是停在本机位的注视点上。 */
  function targetSelected(camera: any): boolean {
    return activeDirectorSelectionOf("cameraTarget")?.uuid === camera?.uuid
  }

  /** 这个手柄此刻出不出场（规则见 resolveRigHandle——同一时刻至多一个为真）。 */
  function handleVisible(camera: any, handle: RigHandle): boolean {
    return (
      resolveRigHandle({
        mode: rigMode(camera),
        isViewportCamera: camera === editor.viewportCamera,
        targetAdjustable: targetAdjustable(camera),
        targetSelected: targetSelected(camera)
      }) === handle
    )
  }

  // ————————————————————————————————————————————————————————
  // 叠加层
  // ————————————————————————————————————————————————————————

  function ensureOverlay(): THREE.Group {
    if (overlay) return overlay
    overlay = new THREE.Group()
    overlay.name = OVERLAY_NAME
    // 与骨架线/轨迹同理：机位视角下也要看得见——那时照样能选中另一个机位调它的注视点。
    markShotViewHelper(overlay)
    editor.sceneHelpers.add(overlay)

    const material = new THREE.LineBasicMaterial({
      color: COLOR_LINE,
      depthTest: false
    })
    const geometry = new THREE.BufferGeometry()
    // 两个端点的缓冲一次建好、此后就地改值：本叠加层跟着播放头逐帧重画，每帧新建一份
    // BufferAttribute 是纯粹的垃圾产出（轨迹那边只在片段变化时重建，故不必如此）。
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3)
    )
    line = new THREE.Line(geometry, material)
    line.name = "lookat-line"
    line.frustumCulled = false
    line.renderOrder = 998
    // 线只是读数，不参与拾取——压在它上面点一下该选中它背后的东西。
    line.raycast = () => {}
    overlay.add(line)

    for (const handle of ["camera", "target"] as RigHandle[]) {
      const proxy = new THREE.Object3D()
      proxy.name = `camera-rig-${handle}`
      overlay.add(proxy)
      proxies[handle] = proxy
    }

    // 注视点上那颗可点选的小球：机位的两个可调元素里，镜头本体点模型即可选中，注视点
    // 在视口里本来没有任何可点的东西——「同时只出现一个调节器」之后就更需要它了。
    //
    // 名字必须是 'picker'：Selector 只把 sceneHelpers 里叫这个名字的东西算进拾取（见
    // Selector.getIntersects）。不叫它的话，点在小球上等于点了背后的空白，Selector 顺手
    // 取消对象选中，整个叠加层随即消失——小球按一下就没了（同轨迹路径点手柄的坑）。
    targetPicker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: COLOR_TARGET_PICKER,
        depthTest: false
      })
    )
    targetPicker.name = "picker"
    targetPicker.frustumCulled = false
    targetPicker.renderOrder = 999
    targetPicker.scale.setScalar(TARGET_PICKER_RADIUS)
    overlay.add(targetPicker)

    return overlay
  }

  /** 把注视点小球摆到位并按「是不是正在调它」换个颜色；不可调时整个藏起来。 */
  function syncTargetPicker(camera: any): void {
    if (!targetPicker) return
    if (!camera || !targetAdjustable(camera)) {
      targetPicker.visible = false
      return
    }
    targetPicker.visible = true
    worldTarget(camera, _point)
    targetPicker.position.copy(_point)
    // Selector 把带 userData.object 的辅助器解析回它代表的对象：点小球时机位保持选中
    // （本就选着，select 判等短路），不会掉进「点了手柄反而取消选中」。
    targetPicker.userData.object = camera
    const active = targetSelected(camera)
    ;(targetPicker.material as THREE.MeshBasicMaterial).color.setHex(
      active ? COLOR_TARGET_PICKER_ACTIVE : COLOR_TARGET_PICKER
    )
    targetPicker.scale.setScalar(TARGET_PICKER_RADIUS * (active ? 1.5 : 1))
  }

  /**
   * 抢在 Selector 之前的点击判定。规则见纯函数 `resolveRigClick`——要点是**点在别处那一下
   * 不消费事件**：退回镜头本体与「选中你点的那个东西」在同一次点击里一起发生。
   *
   * 此前这里一律 halt（照搬了轨迹路径点那套「一次点击只剥一层」），于是注视点选中期间点别
   * 的图形要按两下：第一下只把选中退回机位本体，第二下才选中它；点空白取消选中同理要两下。
   * **不要**改回去——注视点不是一个需要保护的编辑上下文（它就是机位的一个位置），没有理由
   * 为它多收用户一次点击。
   */
  function onIntersectionsDetected(intersects: THREE.Intersection[]): void {
    const camera = targetCamera()
    if (!camera) return

    const outcome = resolveRigClick({
      targetAdjustable: targetAdjustable(camera),
      targetSelected: targetSelected(camera),
      hitPicker:
        targetPicker !== null &&
        intersects.some((hit) => hit.object === targetPicker)
    })

    if (outcome === "select-target") {
      selectDirectorItem({ kind: "cameraTarget", uuid: camera.uuid })
    } else if (outcome === "release-target") {
      // 退回镜头本体，但**不** halt：这一下同时还要落到 Selector 上——点在别的图形上就
      // 选中它、点在空白处就取消选中，都是一次点击的事。
      selectDirectorItem({ kind: "object", uuid: camera.uuid })
    }

    if (rigClickConsumesEvent(outcome)) signals.intersectionsDetected.halt()
  }

  function rebuildOverlay(): void {
    ensureOverlay()
    if (!overlay || !line) return

    const camera = targetCamera()
    if (!camera) {
      line.visible = false
      if (targetPicker) targetPicker.visible = false
      detachAll()
      requestRender()
      return
    }
    // 只藏线不藏整个叠加层：两个代理（gizmo 挂着的那两个）也住在里面，藏了它们调节器
    // 就没了落点。
    line.visible = camera !== editor.viewportCamera

    // 线从**镜头**画到注视点：起点取机位的世界坐标（机位可能挂在别的节点下，
    // 也可能正被轨迹片段推着走，两种情形下 position 都不是世界坐标）；终点一律问
    // worldTarget——位置模式下是用户设的那一点，跟随模式下是被跟随图形的
    // **中心**（由 resolveLookAtPoint 每次对准时刷新），故两种模式画的是同一条读数线。
    camera.getWorldPosition(_origin)
    worldTarget(camera, _point)

    const positions = line.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute
    positions.setXYZ(0, _origin.x, _origin.y, _origin.z)
    positions.setXYZ(1, _point.x, _point.y, _point.z)
    positions.needsUpdate = true

    syncTargetPicker(camera)
    syncGizmos(camera)
    requestRender()
  }

  // ————————————————————————————————————————————————————————
  // 两个手柄
  // ————————————————————————————————————————————————————————

  function setupGizmo(handle: RigHandle): any {
    if (gizmos[handle]) return gizmos[handle]
    const dom = domElement()
    if (!dom) return null

    const gizmo = new TransformControls(editor.viewportCamera)
    gizmo.connect(dom)
    gizmo.size = 0.7
    gizmo.addEventListener("dragging-changed", onGizmoDraggingChanged)
    gizmo.addEventListener("mouseDown", () => onGizmoMouseDown(handle))
    gizmo.addEventListener("mouseUp", onGizmoMouseUp)
    gizmo.addEventListener("objectChange", () => onGizmoObjectChange(handle))
    gizmo.addEventListener("change", requestRender)
    // 指针压在任一手柄上都要报出去，机位视角的第一人称导航据此让路（见文件头）。
    gizmo.addEventListener("axis-changed", onAnyAxisChanged)
    shiftEvenOff[handle] = enableTransformShiftEven(gizmo)
    editor.sceneHelpers.add(markShotViewHelper(gizmo.getHelper()))
    gizmos[handle] = gizmo
    return gizmo
  }

  function detachAll(): void {
    gizmos.camera?.detach()
    gizmos.target?.detach()
    setDirectorGizmoGrabbed(false)
  }

  /**
   * 把两个手柄各自摆到位（该出场的出场，不该的摘掉）。
   *
   * 旋转模式下镜头那个代理的朝向定的正是那**一个**圆环的轴：局部 Z = 视线（由注视点指向
   * 镜头），故绕它转即倾斜，且转过的角度可以直接当成倾斜的增量（authored = Rz(倾斜)，
   * 见 onGizmoObjectChange 的推导）。
   */
  function syncGizmos(camera: any): void {
    for (const handle of ["camera", "target"] as RigHandle[]) {
      // 正被拖的那一个不重摆：它的落点每次指针移动都在变，跟着重摆等于把手柄从指针
      // 底下抽走。另一个**要**跟上——拖注视点时机位是跟着走的，它的手柄不跟就掉队了。
      if (dragStart?.handle === handle) continue
      syncGizmo(camera, handle)
    }
  }

  function syncGizmo(camera: any, handle: RigHandle): void {
    const proxy = proxies[handle]
    if (!proxy) return

    if (!handleVisible(camera, handle)) {
      gizmos[handle]?.detach()
      return
    }

    const gizmo = setupGizmo(handle)
    if (!gizmo) return

    const mode = rigMode(camera) ?? "translate"
    camera.getWorldPosition(_origin)
    worldTarget(camera, _point)
    proxy.position.copy(handle === "camera" ? _origin : _point)

    if (handle === "camera" && mode === "rotate") {
      // 代理的三轴取**视线基底**：Z = 视线（注视点 → 镜头），X/Y 与它凑成正交基。
      // 三个环因此各对应注视角度的一个轴——绕 Z 是倾斜，绕 X/Y 是俯仰偏与水平偏
      // （见 cameraLookAt.ts 的注视角度小节）。这也是它必须用 local 空间的原因。
      _forward.copy(_origin).sub(_point)
      if (_forward.lengthSq() < 1e-8) _forward.set(0, 0, 1)
      _forward.normalize()
      _right.crossVectors(_up, _forward)
      // 视线竖直时叉乘退化——退到镜头自己的右方向。
      if (_right.lengthSq() < 1e-8)
        _right.setFromMatrixColumn(camera.matrixWorld, 0)
      _right.normalize()
      _matrix.makeBasis(
        _right,
        _basisUp.crossVectors(_forward, _right),
        _forward
      )
      proxy.quaternion.setFromRotationMatrix(_matrix)
    } else {
      proxy.quaternion.identity()
    }
    proxy.updateMatrixWorld(true)

    gizmo.setMode(mode)
    // 移动是世界轴上的平移；旋转要按代理自己的视线基底来，故用 local。
    gizmo.setSpace(handle === "camera" && mode === "rotate" ? "local" : "world")
    // 三个环全给：注视角度是三轴的（俯仰偏 / 水平偏 / 倾斜），只留 Z 环的话另外两个
    // 轴在视口里就没有入口，只能回面板填数字。
    gizmo.showX = true
    gizmo.showY = true
    gizmo.showZ = true
    gizmo.camera = editor.viewportCamera
    gizmo.attach(proxy)
  }

  function onAnyAxisChanged(): void {
    const grabbed = (["camera", "target"] as RigHandle[]).some(
      (handle) =>
        Boolean(gizmos[handle]?.axis) && Boolean(gizmos[handle]?.object)
    )
    setDirectorGizmoGrabbed(grabbed)
  }

  function onGizmoDraggingChanged(event: any): void {
    // 同共享 gizmo：拖动期间关掉轨道控制，松手后仅在导演视角恢复。
    editor.controls.enabled =
      !event.value && editor.viewportCamera === editor.camera
  }

  function onGizmoMouseDown(handle: RigHandle): void {
    const camera = targetCamera()
    const state = camera ? getCameraLookAt(camera) : null
    const mode = rigMode(camera)
    const proxy = proxies[handle]
    if (!state || !mode || !proxy) return
    // 整段拖动记一条历史：按下时留底，抬手时与最终状态一比即成一条命令（规则 §2）。
    dragStart = {
      handle,
      mode,
      position: new THREE.Vector3().fromArray(readAuthored(camera, "position")),
      target: readCameraLookAtPoint(camera, new THREE.Vector3()),
      authored: new THREE.Quaternion().fromArray(
        readAuthored(camera, "quaternion")
      ),
      world: camera.getWorldQuaternion(new THREE.Quaternion()),
      proxyPosition: proxy.position.clone(),
      proxyQuaternion: proxy.quaternion.clone(),
      state: cloneCameraLookAt(state)
    }
  }

  function onGizmoObjectChange(handle: RigHandle): void {
    const camera = targetCamera()
    const proxy = proxies[handle]
    if (!camera || !proxy || !dragStart || dragStart.handle !== handle) return

    if (handle === "target") {
      // 整套平移：注视点与站位加同一个位移，视线偏移与朝向都不变。
      // 位移量在**世界**坐标里（手柄摆在世界里），而注视点与站位都是**父层**坐标，故把
      // 按下那一刻的注视点搬到世界、加上位移、再换算回父层；父层里的位移由前后两份读数
      // 相减得出——位移是方向量，直接乘父层矩阵会把平移分量也叠进去。
      _delta.copy(proxy.position).sub(dragStart.proxyPosition)
      _point.copy(dragStart.target)
      parentToWorld(camera, _point).add(_delta)
      parentPoint(camera, _point, _point)
      // **只挪锚点，机位站位一个字都不写**。
      //
      // 早先这里是「整套平移」（站位加同一个位移跟着走）。那条行为已由**跟拍**开关接管：
      // 开着时站位是锚点的派生量、自动跟过来（applyCameraFollow 会在下一次落地算出来），
      // 关着就该只转头。留着旧行为的话，同一件事有两个入口，而且与面板的「注视位置」
      // 字段、时间轴上注视位置关键帧的落地（两处都只改锚点）对不上——同一个拖动，在视口里
      // 做和在面板里做会得到两种结果。播放头压在一格注视轨迹里时更要如此：那一下的意思
      // 是「让这条轨迹从这儿过」（改动随即被路径吸收），不是「把整套装置搬个地方」。
      writeCameraLookAtPoint(editor, camera, _point.x, _point.y, _point.z)
    } else if (dragStart.mode === "translate") {
      const state = getCameraLookAt(camera)
      const destination = resolveRigTranslateTarget({
        following: isCameraFollowingPosition(camera)
      })
      if (destination === "follow-rig") {
        // 跟拍中：站位由装置驱动（求值层 override），写 authored 会被当场顶掉——手一
        // 松就弹回去。故拖出来的落点折回**装置**本身（同面板「机位角度」那一行、同
        // 轨迹里拖对象被路径吸收的那条取舍）。代理在世界坐标里，直接拿它反推即可。
        const rig = cameraFollowRigFromWorld(
          editor,
          camera,
          proxy.position,
          state!.follow!.frame
        )
        if (rig) state!.follow = rig
        applyCameraFollow(editor, camera)
        applyCameraLookAt(editor, camera)
      } else {
        // 挪镜头：位移照搬到站位上，对准随即重算——Y角度/X角度/距离三个读数因此
        // 一起变，那正是面板上「机位角度」那一行（同一件事的另一套读数）。
        //
        // 基准恒取 **authored**（用户摆的那一份）。播放头压在一格站位轨迹里时，节点
        // 上的合成值是路径给的、与 authored 差着一整条轨迹——但那几秒的站位本就归路径
        // 管，这一趟改的是片段之外的站位，故基准与落点都在 authored 这一侧
        // （见 resolveRigTranslateTarget 的说明）。
        //
        // 位移量在**世界**坐标里（手柄摆在世界里），站位却是父层坐标，故同 target
        // 分支：先把基准搬到世界、加上位移、再换算回父层。舞台带着旋转/缩放时，直接
        // 把世界位移加在父层读数上会歪。
        _delta.copy(proxy.position).sub(dragStart.proxyPosition)
        _position.copy(dragStart.position)
        parentToWorld(camera, _position).add(_delta)
        parentPoint(camera, _position, _position)
        keepAimDistance(camera, _position)
        writeAuthored(camera, "position", _position.toArray())
        applyCameraLookAt(editor, camera)
      }
    } else {
      // 注视角度：三个环各改一个轴（绕 Z 是倾斜，绕 X/Y 是俯仰偏与水平偏）。
      // 手柄转过的是一份**世界**差量，换算回 authored 的那条共轭式住在 cameraLookAt.ts
      // （authoredAfterWorldDelta，一条式子覆盖三个环）。
      _quatStart.copy(dragStart.proxyQuaternion).invert()
      _quat.copy(proxy.quaternion).multiply(_quatStart)
      authoredAfterWorldDelta(
        dragStart.world,
        dragStart.authored,
        _quat,
        _authored
      )
      writeAuthored(camera, "quaternion", _authored.toArray())
      // 朝向变了，对准那一份分量不变，但节点上的合成值要重算一次才能立刻看见。
      applyCameraLookAt(editor, camera)
    }

    // 派发出去，才有属性面板的实时回填、FOV 椎体的跟随与自动关键帧——后者攒下的轨道
    // 变化会在抬手那条命令执行时挂到它头上（见 flushAutoKeyHistory），整段拖动因此
    // 是「一步历史 + 一份轨道前后快照」。
    signals.objectChanged.dispatch(camera)
  }

  function onGizmoMouseUp(): void {
    const start = dragStart
    dragStart = null
    const camera = targetCamera()
    const state = camera ? getCameraLookAt(camera) : null
    if (!start || !state) {
      rebuildOverlay()
      return
    }

    if (start.handle === "target") {
      // 拖动期间只改了锚点（站位一个字都没写，见 onGizmoObjectChange），故这一步记的
      // 就是注视状态本身。没挪动就不记一步空历史（抓一下手柄又放开很常见）。
      readCameraLookAtPoint(camera, _point)
      if (_point.distanceTo(start.target) > 1e-6) {
        editor.execute(
          new SetCameraLookAtCommand(
            editor,
            camera,
            cloneCameraLookAt(state),
            start.state
          )
        )
      }
    } else if (start.mode === "translate") {
      // 按下与抬手必须问同一句：拖动期间落点写去了哪儿，这一步就该记哪一份。判据在
      // 一次拖动之内不会变（跟拍开关不会在拖动途中变）。
      const destination = resolveRigTranslateTarget({
        following: isCameraFollowingPosition(camera)
      })
      if (destination === "follow-rig") {
        // 拖动期间改的是装置（见 onGizmoObjectChange），故这一步记的也是注视状态。
        // 判等按装置的读数比：抓一下手柄又放开不该记一步空历史。两种参照存的参数不同
        // （固定方位是一份 xyz 偏移、锁定视角是三个球坐标），故各比各的。
        if (followRigChanged(start.state.follow, state.follow)) {
          editor.execute(
            new SetCameraLookAtCommand(
              editor,
              camera,
              cloneCameraLookAt(state),
              start.state
            )
          )
        }
      } else {
        _position.fromArray(readAuthored(camera, "position"))
        if (_position.distanceTo(start.position) > 1e-6) {
          editor.execute(
            new SetPositionCommand(
              editor,
              camera,
              _position.clone(),
              start.position
            )
          )
        }
      }
    } else {
      // 整份 authored 一起比、一起提交：三个环改的是同一个四元数的不同轴，按某一个
      // 角度的标量去比会漏掉另外两轴上的改动（那正是「转了却撤销不掉」）。
      _authored.fromArray(readAuthored(camera, "quaternion"))
      if (_authored.angleTo(start.authored) > 1e-4) {
        editor.execute(
          new SetRotationCommand(
            editor,
            camera,
            authoredEuler(camera, _authored),
            authoredEuler(camera, start.authored)
          )
        )
      }
    }
    // 源项目在这里还要结算拖动途中补出的自动关键帧（settleDerivedEdits）；本仓库未迁移
    // 时间轴，没有自动关键帧可结算。
    rebuildOverlay()
  }

  /**
   * authored 四元数 → SetRotationCommand 要的欧拉角。
   *
   * 命令按欧拉角记（与面板、时间轴同一口径），故轴序必须取机位自己的 `rotation.order`
   * ——换一个轴序，同一份朝向解出来的三个数就不是同一组了。
   */
  function authoredEuler(
    camera: any,
    quaternion: THREE.Quaternion
  ): THREE.Euler {
    return new THREE.Euler().setFromQuaternion(
      quaternion,
      camera.rotation?.order ?? "XYZ"
    )
  }

  /** 世界坐标的注视点 → 机位所在那一层的坐标（站位与它必须同一个坐标系才能相减）。 */
  function parentPoint(
    camera: any,
    world: THREE.Vector3,
    out: THREE.Vector3
  ): THREE.Vector3 {
    out.copy(world)
    const parent = camera?.parent
    if (!parent) return out
    parent.updateWorldMatrix(true, false)
    return parent.worldToLocal(out)
  }

  /**
   * 注视点的**世界**坐标——本叠加层画的每一样东西（连线的终点、注视点小球、手柄代理）都
   * 摆在世界坐标里，而注视点存的是父层坐标（见 CameraLookAtState.target）。
   *
   * 收在一处而不是每个 sync 各换算一次：漏掉一处的表现是「舞台一带变换，注视点小球与连线
   * 的终点就分家了」，而那两样东西本该恒在同一点上。
   */
  function worldTarget(camera: any, out: THREE.Vector3): THREE.Vector3 {
    return parentToWorld(camera, readCameraLookAtPoint(camera, out))
  }

  /**
   * 拖动前后跟拍装置有没有真的变。
   *
   * 两种参照存的是**两套参数**（见 CameraFollowRig），故先看参照本身变没变，再按各自的字段
   * 比——照一套字段比另一套会读到 undefined，结果恒为「变了」，抓一下手柄就记一步空历史。
   */
  function followRigChanged(
    before: CameraFollowRig | null | undefined,
    after: CameraFollowRig | null | undefined
  ): boolean {
    if (!before || !after) return before !== after
    if (before.frame !== after.frame) return true
    if (isOrbitRig(before) && isOrbitRig(after)) {
      return (
        Math.abs(before.azimuth - after.azimuth) > 1e-4 ||
        Math.abs(before.elevation - after.elevation) > 1e-4 ||
        Math.abs(before.distance - after.distance) > 1e-6
      )
    }
    if (isOrbitRig(before) || isOrbitRig(after)) return true
    return before.offset.some(
      (n, i) => Math.abs(n - (after.offset[i] ?? 0)) > 1e-6
    )
  }

  /** 别把镜头拖到注视点上：贴到一起就没有「看哪儿」可言，对准会退化。 */
  function keepAimDistance(camera: any, position: THREE.Vector3): void {
    // 注视点与站位同为父层坐标，直接相减。
    readCameraLookAtPoint(camera, _point)
    _offset.copy(position).sub(_point)
    const distance = _offset.length()
    if (distance >= MIN_AIM_DISTANCE) return
    // 退化到零长时没有方向可依，退到镜头当前视线的反方向把它推出去。
    if (distance < 1e-6) _offset.set(0, 0, 1).applyQuaternion(camera.quaternion)
    position.copy(_point).add(_offset.setLength(MIN_AIM_DISTANCE))
  }

  // ————————————————————————————————————————————————————————
  // 生命周期
  // ————————————————————————————————————————————————————————

  function onViewportCameraChanged(): void {
    for (const gizmo of Object.values(gizmos))
      if (gizmo) gizmo.camera = editor.viewportCamera
    rebuildOverlay()
  }

  function onTransformModeChanged(mode: DirectorTransformMode): void {
    // 用信号带来的那一份而不是回读 editor.transformControls.mode：Viewport 也听这条信号
    // 并在自己的监听里 setMode，两边的先后顺序不该成为本方读数正确与否的前提。
    transformMode = mode
    rebuildOverlay()
  }

  function onObjectChanged(object: any): void {
    // 机位自己动了（站位/注视状态）、或被跟随的图形动了，线的两端都可能变。判一下省掉
    // 与本叠加层无关的那些派发——拖别的模型时 objectChanged 是每次指针移动一发。
    if (dragStart) {
      // 拖动期间只让没被拖的那个手柄跟上（整套平移时机位在动），线也照常重画。
      const camera = targetCamera()
      if (camera && object === camera) redrawLine(camera)
      return
    }
    const camera = targetCamera()
    if (!camera) return
    if (object === camera || getCameraLookAt(camera)?.mode === "object")
      rebuildOverlay()
  }

  /** 只重画连线与另一个手柄（拖动途中用，不碰正被拖的那一个）。 */
  function redrawLine(camera: any): void {
    if (!line) return
    camera.getWorldPosition(_origin)
    worldTarget(camera, _point)
    const positions = line.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute
    positions.setXYZ(0, _origin.x, _origin.y, _origin.z)
    positions.setXYZ(1, _point.x, _point.y, _point.z)
    positions.needsUpdate = true
    syncGizmos(camera)
  }

  function onRendererCreated(): void {
    rebuildOverlay()
  }

  // 时间轴逐帧写回场景后重建一次：机位与注视点都可能被关键帧/跟拍挪走，线要跟上。
  // 时间轴的写回**不派发** objectChanged（逐帧扇出会拖垮播放），这条 sceneAnimated 才是
  // 「本帧已落地」的通道——见 Editor.ts 的信号注释与 useDirectorTimeline 的文件头。
  // 此前这里是自己 `watch(timelineCurrentTime, ...)`，已改走统一通道，**不要**改回去。
  function onSceneAnimated(): void {
    rebuildOverlay()
  }

  onMounted(() => {
    if (!domElement()) signals.rendererCreated.add(onRendererCreated)

    signals.objectSelected.add(rebuildOverlay)
    signals.objectChanged.add(onObjectChanged)
    signals.sceneAnimated.add(onSceneAnimated)
    // 高优先级 = 抢在 Selector 的默认优先级监听之前（同轨迹路径点/关节手柄的做法）。
    signals.intersectionsDetected.add(onIntersectionsDetected, null, 100)
    signals.objectRemoved.add(rebuildOverlay)
    signals.editorCleared.add(rebuildOverlay)
    signals.viewportCameraChanged.add(onViewportCameraChanged)
    signals.transformModeChanged.add(onTransformModeChanged)
    rebuildOverlay()
  })

  // 所有权变了立刻对账：别人（路径点、关节）接管时自己收摊，交还给 'object' 时自己回来。
  const stopOwnerWatch = watch(directorGizmoOwner, () => rebuildOverlay())

  // 选区变了也要重建：镜头本体与注视点这两个手柄的换手就发生在选区里（都归 'object' 这一份
  // 所有权，故上面那条 watch 看不见这次变化）。
  const stopSelectionWatch = watch(activeDirectorSelection, () =>
    rebuildOverlay()
  )

  onBeforeUnmount(() => {
    stopOwnerWatch()
    stopSelectionWatch()
    setDirectorGizmoGrabbed(false)
    signals.rendererCreated.remove(onRendererCreated)
    signals.objectSelected.remove(rebuildOverlay)
    signals.objectChanged.remove(onObjectChanged)
    signals.sceneAnimated.remove(onSceneAnimated)
    signals.intersectionsDetected.remove(onIntersectionsDetected)
    signals.objectRemoved.remove(rebuildOverlay)
    signals.editorCleared.remove(rebuildOverlay)
    signals.viewportCameraChanged.remove(onViewportCameraChanged)
    signals.transformModeChanged.remove(onTransformModeChanged)

    for (const handle of ["camera", "target"] as RigHandle[]) {
      const gizmo = gizmos[handle]
      if (!gizmo) continue
      gizmo.detach()
      shiftEvenOff[handle]?.()
      shiftEvenOff[handle] = null
      const helper = gizmo.getHelper()
      helper.parent?.remove(helper)
      gizmo.disconnect?.()
      gizmo.dispose()
      gizmos[handle] = null
    }
    if (line) {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
      line = null
    }
    // 小球与线同理：几何/材质要还回去，引用要断（它的 userData 上还挂着那个机位）。漏掉的
    // 话，导演台每开关一次就多留一份；而且 ensureOverlay 认的是 overlay 为不为空，留一个
    // 非空的 targetPicker 配一个空 overlay 是个再进来就对不上的状态。
    if (targetPicker) {
      targetPicker.geometry.dispose()
      ;(targetPicker.material as THREE.Material).dispose()
      targetPicker.userData.object = null
      targetPicker = null
    }
    if (overlay) {
      overlay.parent?.remove(overlay)
      overlay = null
      proxies.camera = null
      proxies.target = null
    }
  })
}
