import { onBeforeUnmount } from "vue"
import * as THREE from "three"

import { SetCameraPoseCommand } from "@/components/three-editor/commands/SetCameraPoseCommand"
import { SetRotationCommand } from "@/components/three-editor/commands/SetRotationCommand"
import { SetValueCommand } from "@/components/three-editor/commands/SetValueCommand"
import { readAuthored } from "@/components/three-editor/EvaluatedTransform"
import { CAMERA_FOV_MAX, CAMERA_FOV_MIN } from "./cameraFrustum"
import { directorGizmoGrabbed } from "./directorGizmoOwner"
import {
  aimCameraAt,
  cloneCameraLookAt,
  deriveAimPoint,
  ensureCameraLookAt,
  getCameraLookAt,
  getCameraLookAtMode,
  type CameraLookAtMode,
  type CameraLookAtState
} from "./cameraLookAt"

// 机位视角（editor.viewportCamera !== editor.camera）下的鼠标导航。
//
// 视口按视角分治：导演视角（viewportCamera === editor.camera）由轨道相机
// EditorControls 接管（绕 controls.center 旋转/平移/滚轮缩放）；机位视角把
// EditorControls 整体禁用（controls.enabled=false，见 Viewport.ts），改由本组合件
// 接管指针/滚轮，直接操作作为视口相机的机位对象。
//
// **能做什么由机位当前的注视模式决定，判据收在纯函数 `resolveCameraViewNavigation`**：
//
//   · 自由调整（free）→ `'roam'`，一套完整的第一人称漫游：
//       左键拖动  → 以机位自身为中心旋转朝向（原地环视，改的是机位自己的 authored 朝向）
//       右键拖动  → 沿当前可视平面平移机位（屏幕像素 1:1 映射到指针下方那个东西的深度处）
//       滚轮      → 沿视线前后移动机位（第一人称前进/后退，定量步长，非 zoom）
//   · 注视位置（point）/ 注视对象（object）→ `'fov'`，**指针一概不接，滚轮只改 FOV**。
//
// 这条分野是需求本身：机位一旦有了注视锚点，它的**站位与朝向就是一套装置的读数**
// ——朝向由锚点驱动（见 cameraLookAt.ts 的 aimCameraAt），站位则对应面板上「机位角度」
// 的横向角/纵向角/距离，还可能被跟拍 override、被站位轨迹接管。在这块画面上随手拖一下
// 就把其中某一份改掉，用户读不出自己改的是哪一个数；要挪机位就去导演视角拖装置手柄、
// 或改面板上那三个读数。**剩下唯一与装置无关的镜头参数就是 FOV**，故滚轮改判给它。
//
// 早先 point 模式是放行的（旋转手势改注视点、平移与漫游把注视点沿相同位移一起搬），
// 那套「注视点跟着机位走」的补偿已随之整体撤掉——**不要**改回去：它让「注视位置」这份
// 用户数据在用户没碰过它的手势里被静默改写，而注视位置那一行还能放轨迹、能打关键帧。
//
// 历史：拖动手势（旋转/平移）在指针按下时快照起始状态，拖动期间直接就地改写机位
// 做实时预览（派发 objectChanged 触发渲染/面板回填/跟随），指针抬起时提交一条命令；
// 滚轮无自然手势终点（漫游与变焦都是），逐格提交 updatable 的命令，靠 History
// 500ms 窗口自动合并为一条。

// 每像素旋转弧度，与 EditorControls.rotationSpeed 对齐，两视角手感一致。
const ROTATE_SPEED = 0.005
// 每格滚轮沿视线前后漫游的步长，取**指针下方那个东西的深度**的这个比例（与
// EditorControls.zoomSpeed 对齐，两视角手感一致）：贴到桌面前时一格走几厘米、
// 眺望远处时一格走几米，越靠近步子越小、永远不会一格穿过去。
//
// 此前是定值 0.5m，与画面尺度无关，凑近小物件时一格就飞过去、拉远了又挪不动；而右键
// 平移按注视距离标定、漫游时注视点随机位同向移动故该距离恒定不变，于是滚轮改变了画面
// 尺度、平移速度却纹丝不动——那正是「缩放前后右键拖动速度不一致」的来源。两者现在共用
// 同一个深度基准（见 gestureDepth）。
const ROAM_RATIO = 0.1
// 步长下限：按比例走是渐近的，贴到墙面前每格只剩几毫米，就成了「推不过去」。给一个
// 与画面尺度无关的最小步长，凑到近前仍能一格一格穿过去（机位视角是第一人称漫游，
// 穿过去是正当操作，不像轨道相机那样有个必须绕着转的中心）。
const MIN_ROAM_STEP = 0.05
// 步长与平移深度的兜底区间：指针下方是墙皮时深度可能只有几厘米，是天边时又是几百米，
// 不夹一下会退化成「一格纹丝不动」或「一格飞出场景」。
const MIN_GESTURE_DEPTH = 0.2
const MAX_GESTURE_DEPTH = 200
// 触发拖动的最小像素位移：低于此阈值视为点击（交给视口的拾取选中），不提交历史。
const DRAG_THRESHOLD = 2
// 尚无注视状态、或注视点与机位重合时，推导注视距离的回退值（对齐
// cameraLookAt.deriveAimPoint 的 DEFAULT_AIM_DISTANCE）。
const FALLBACK_AIM_DISTANCE = 5
// 滚轮变焦每格的倍率指数：新 FOV = 旧 FOV × e^(±FOV_ZOOM_SPEED)。取指数而不是「每格 ±5°」
// 是为了**进出互逆**（滚出去再滚回来正好回到原处，同 EditorControls.zoomSpeed 的取舍），
// 且窄视野时每格走得更细——15° 附近一格约 0.8°、90° 附近一格约 4.6°，与画面上看到的变化
// 幅度相称；按定值加减则长焦端一格就跳过去了。
const FOV_ZOOM_SPEED = 0.05

type GestureMode = "none" | "rotate" | "pan"

/**
 * 机位视角下这个机位允许什么鼠标操作——**本文件全部闸门的单点源**（指针接不接、滚轮
 * 走哪一条，都问它）。纯函数，回归用例见 useDirectorCameraControls.spec.ts。
 *
 *   · `'roam'`——自由调整：左键环视 / 右键平移 / 滚轮前后漫游。机位此时与普通图形无异，
 *     站位与朝向都归用户，怎么拖都是在改用户自己写下的那一份。
 *   · `'fov'`——注视位置与注视对象：**指针一概不接，滚轮只改 FOV**。两种模式在这里
 *     一个字不差，故不必分开——差别只在锚点从哪儿来（见 cameraLookAt.ts 的
 *     resolveAimAnchor），而「机位是一套装置、站位与朝向是它的读数」两者同样成立。
 */
export function resolveCameraViewNavigation(
  mode: CameraLookAtMode
): "roam" | "fov" {
  return mode === "free" ? "roam" : "fov"
}

/** 滚轮变焦一格之后的 FOV（向上滚推近 = 视野变窄），夹在面板滑杆的同一对量程内。 */
export function nextCameraFov(fov: number, deltaY: number): number {
  const scaled = fov * Math.exp((deltaY > 0 ? 1 : -1) * FOV_ZOOM_SPEED)
  return THREE.MathUtils.clamp(scaled, CAMERA_FOV_MIN, CAMERA_FOV_MAX)
}

// 机位当前视线前方单位向量（本地 -Z 经四元数变换）。
function cameraForward(camera: any, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, -1).applyQuaternion(camera.quaternion)
}

export function useDirectorCameraControls(editor: any) {
  const signals = editor.signals

  let canvas: HTMLElement | null = null
  let mode: GestureMode = "none"
  let activePointerId: number | null = null
  let moved = false
  // 指针按下时的屏幕像素起点（判定是否越过拖动阈值）与上一次位置（求增量）。
  let downX = 0
  let downY = 0
  let lastX = 0
  let lastY = 0
  // 平移手势的参考深度，**按下时定一次**：拖动中途跟着指针重新拾取的话，光标扫过
  // 远近不同的表面会让同一次拖动忽快忽慢。
  let panDepth = FALLBACK_AIM_DISTANCE

  // 手势起始快照（供指针抬起时构建命令的 old 值）。
  const startPosition = new THREE.Vector3()
  let startLookAt: CameraLookAtState | null = null
  /** 手动调整模式下旋转手势改的是 authored 朝向，撤销要回到这一份。 */
  let startRotation: THREE.Euler | null = null

  // 旋转手势：以球坐标累积注视偏移（radius 恒定 = 起始注视距离），
  // 每帧从球坐标重算注视点，避免逐帧读回四元数带来的漂移。
  const rotateSpherical = new THREE.Spherical()

  // 复用临时对象，避免拖动期间频繁分配。
  const _vec = new THREE.Vector3()
  const _target = new THREE.Vector3()
  const _normalMatrix = new THREE.Matrix3()

  function inCameraView(): boolean {
    return !!editor.viewportCamera && editor.viewportCamera !== editor.camera
  }

  // 这个机位此刻允许什么——见 resolveCameraViewNavigation。指针手势（旋转/平移）只在
  // 'roam' 下接；'fov' 下机位的站位与朝向都是装置的读数，指针一概让路。
  function navigationOf(camera: any): "roam" | "fov" {
    return resolveCameraViewNavigation(getCameraLookAtMode(camera))
  }

  // 当前机位到其注视点的距离；**只作为拾取不到东西时的兜底**——注视点是一份用户数据
  // （机位对着谁），漫游时它随机位同向移动故这个距离恒定不变，拿它当手感基准会让平移
  // 速度与画面尺度脱节。
  function aimDistance(camera: any): number {
    const state = getCameraLookAt(camera)
    if (state) {
      const d = camera.position.distanceTo(
        _vec.set(state.target.x, state.target.y, state.target.z)
      )
      if (d > 0.01) return d
    }
    return FALLBACK_AIM_DISTANCE
  }

  /**
   * 本次手势的参考深度：指针下方那个东西所在的**视线深度**（在视线方向上的投影距离，
   * 而不是到该点的直线距离——光标在画面边缘时两者差出十几个百分点）。
   *
   * 平移与滚轮漫游共用它，于是「凑得越近走得越慢、拖得越准」在两个手势上同时成立。
   * 拾取不到（指针指向天空、且射线与地面不相交）时退回注视距离，即此前的行为。
   */
  function gestureDepth(camera: any, clientX: number, clientY: number): number {
    const point = editor.pickViewportPoint?.(clientX, clientY)
    if (point) {
      const depth = cameraForward(camera, _vec).dot(
        _target.copy(point).sub(camera.position)
      )
      if (depth > MIN_GESTURE_DEPTH) return Math.min(depth, MAX_GESTURE_DEPTH)
    }
    return THREE.MathUtils.clamp(
      aimDistance(camera),
      MIN_GESTURE_DEPTH,
      MAX_GESTURE_DEPTH
    )
  }

  // 拖动起点：捕获当前机位的起始位置、注视状态与 authored 朝向快照。注视状态缺省时用
  // 当前视线推导出的手动状态兜底（朝向不变），使旋转手势的撤销能回到原始朝向。
  function captureGestureStart(camera: any) {
    startPosition.copy(camera.position)
    startRotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().fromArray(readAuthored(camera, "quaternion")),
      camera.rotation.order
    )
    const existing = getCameraLookAt(camera)
    if (existing) {
      startLookAt = cloneCameraLookAt(existing)
    } else {
      const point = deriveAimPoint(camera)
      startLookAt = {
        mode: "free",
        targetUuid: null,
        target: { x: point.x, y: point.y, z: point.z }
      }
    }
  }

  // 初始化旋转手势的球坐标：以起始注视偏移为基准，radius 锁定为注视距离。
  function beginRotate(camera: any) {
    const state = getCameraLookAt(camera)
    let radius = FALLBACK_AIM_DISTANCE
    if (state) {
      _vec
        .set(state.target.x, state.target.y, state.target.z)
        .sub(camera.position)
      if (_vec.lengthSq() > 1e-6) {
        radius = _vec.length()
        rotateSpherical.setFromVector3(_vec)
        rotateSpherical.radius = radius
        return
      }
    }
    // 无注视偏移可用：以当前视线前方 × 回退距离建立初始偏移。
    cameraForward(camera, _vec).multiplyScalar(radius)
    rotateSpherical.setFromVector3(_vec)
    rotateSpherical.radius = radius
  }

  /**
   * 旋转手势的每帧更新：累积方位角/极角 → 重算视线落点。
   *
   * **只在自由调整下跑得到**（见 resolveCameraViewNavigation），故落点写的一定是机位
   * 自己的 authored 朝向，注视坐标只顺带更新那份缓存（切到注视模式时的起点）。这里
   * **不能**顺手改写 lookAt.mode：那等于用户转了一下画面，注视目标就被静默换成「位置」，
   * 属性面板下半页当场换了一副表。
   */
  function updateRotate(camera: any, dx: number, dy: number) {
    // 抓取式（画面随光标走）：拖右→注视方位左移使画面右移。上下方向按需
    // 反转（拖下→抬头、拖上→低头），故 phi 用 += 而非 -=。符号为可调项。
    rotateSpherical.theta -= dx * ROTATE_SPEED
    rotateSpherical.phi += dy * ROTATE_SPEED
    rotateSpherical.makeSafe()

    _vec.setFromSpherical(rotateSpherical)
    _target.copy(camera.position).add(_vec)

    // 转镜头一律经 aimCameraAt——**不要**在这里直写 camera.lookAt：那一份会被求值层认作
    // authored，下一次对准再乘一遍，表现是「镜头没有对准注视目标」（见该函数的说明）。
    aimCameraAt(editor, camera, _target)
    camera.updateMatrixWorld(true)
    signals.objectChanged.dispatch(camera)
  }

  // 平移手势的每帧更新：屏幕像素经相机本地轴映射到世界位移（1:1 对齐注视距离
  // 处的平面，与 EditorControls.pan 同一公式）。position 与手动注视点沿相同世界
  // 位移一起平移，使视线偏移（target - position）与朝向保持不变——否则注视点滞留
  // 在平移前的世界坐标，后续左键旋转会以过期注视点为中心、起手瞬间猛拉朝向（视图
  // 跳变），且平移后的旋转中心也不再是画面中心的图形。注视距离取平移前状态计算，
  // 避免平移侧移拉大 target-position 距离导致手感漂移。
  function updatePan(camera: any, dx: number, dy: number) {
    const height = canvas ? canvas.clientHeight : 0
    if (!height) return
    // 注视点缺省时按当前视线推导一个手动点（不改朝向），作为随平移移动的基准。
    const look = ensureCameraLookAt(camera)
    // 1:1 映射的深度取按下那一刻指针下方那个东西（panDepth），不是注视距离——
    // 后者在漫游时恒定不变，见 gestureDepth 的说明。
    const targetDistance =
      panDepth * Math.tan(((camera.fov ?? 50) / 2) * THREE.MathUtils.DEG2RAD)
    const panSpeed = (2 * targetDistance) / height

    camera.updateMatrixWorld(true)
    _vec.set(-dx, dy, 0).multiplyScalar(panSpeed)
    _vec.applyMatrix3(_normalMatrix.getNormalMatrix(camera.matrix))

    camera.position.add(_vec)
    look.target.x += _vec.x
    look.target.y += _vec.y
    look.target.z += _vec.z
    camera.updateMatrixWorld(true)
    signals.objectChanged.dispatch(camera)
  }

  function onPointerDown(event: PointerEvent) {
    if (!inCameraView() || activePointerId !== null) return
    if (event.button !== 0 && event.button !== 2) return

    const camera = editor.viewportCamera
    // 有注视锚点的机位不接指针：那时站位与朝向都是装置的读数（见文件头）。
    if (navigationOf(camera) !== "roam") return

    // 左键落在变换 gizmo 手柄上时（transformControls.axis 非空）交给对象拖拽，
    // 不旋转机位；右键 gizmo 不响应，无需此判定。
    const tc = editor.transformControls
    if (event.button === 0 && tc && (tc.dragging || tc.axis)) return
    // 导演台自建的那些调节器是**另外的 TransformControls 实例**，上面那一问问不到它们
    // ——机位注视装置的手柄就摆在取景机位的正前方，不让路的话抓住它一拖，机位跟着一起转。
    if (event.button === 0 && directorGizmoGrabbed.value) return

    mode = event.button === 0 ? "rotate" : "pan"
    activePointerId = event.pointerId
    moved = false
    downX = event.clientX
    downY = event.clientY
    lastX = event.clientX
    lastY = event.clientY
    if (mode === "pan")
      panDepth = gestureDepth(camera, event.clientX, event.clientY)

    captureGestureStart(camera)
    if (mode === "rotate") beginRotate(camera)

    canvas?.setPointerCapture(event.pointerId)
    if (canvas) canvas.style.cursor = "grabbing"
  }

  function onPointerMove(event: PointerEvent) {
    if (mode === "none" || event.pointerId !== activePointerId) return

    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY

    // 越过拖动阈值前视作潜在点击（交给视口拾取选中），不改动机位、不提交历史。
    if (!moved) {
      if (
        Math.hypot(event.clientX - downX, event.clientY - downY) <
        DRAG_THRESHOLD
      )
        return
      moved = true
    }

    const camera = editor.viewportCamera
    if (mode === "rotate") updateRotate(camera, dx, dy)
    else updatePan(camera, dx, dy)
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== activePointerId) return

    const camera = editor.viewportCamera
    if (moved && startLookAt) {
      if (mode === "rotate") {
        // 自由调整（手势只在这一种模式下接得到）：转的是机位自己的朝向。注视坐标
        // 只是缓存（切到注视模式时的起点），不为它单记一条历史——撤销回到起始朝向
        // 即可，缓存下次用到时自会重算。
        editor.execute(
          new SetRotationCommand(
            editor,
            camera,
            new THREE.Euler().setFromQuaternion(
              new THREE.Quaternion().fromArray(
                readAuthored(camera, "quaternion")
              ),
              camera.rotation.order
            ),
            startRotation
          )
        )
      } else if (mode === "pan") {
        // 位置与注视点一并提交、原子撤销（见 SetCameraPoseCommand）：
        // 二者在平移期间沿相同位移移动，撤销/重做必须同步复原，否则错位复现跳变。
        const newState = cloneCameraLookAt(
          camera.userData.lookAt as CameraLookAtState
        )
        editor.execute(
          new SetCameraPoseCommand(
            editor,
            camera,
            camera.position.clone(),
            newState,
            startPosition.clone(),
            startLookAt
          )
        )
      }
    }

    endGesture(event.pointerId)
  }

  function onPointerCancel(event: PointerEvent) {
    if (event.pointerId !== activePointerId) return
    endGesture(event.pointerId)
  }

  function endGesture(pointerId: number) {
    mode = "none"
    activePointerId = null
    moved = false
    startLookAt = null
    startRotation = null
    if (canvas) {
      canvas.style.cursor = ""
      if (canvas.hasPointerCapture?.(pointerId))
        canvas.releasePointerCapture(pointerId)
    }
  }

  function onWheel(event: WheelEvent) {
    if (!inCameraView()) return

    const camera = editor.viewportCamera
    event.preventDefault()

    // 有注视锚点的机位：滚轮改 FOV（那是唯一与注视装置无关的镜头参数，见文件头）。
    // SetValueCommand 自带 updatable，连续滚动在 History 500ms 窗口内合并为一条；
    // 到量程端点即判等短路，不留空历史。projectionMatrix 由 Viewport 的 objectChanged
    // 监听统一刷新（撤销那一路同样经它，故这里不必自己刷）。
    if (navigationOf(camera) === "fov") {
      const current = camera.fov ?? 50
      const next = nextCameraFov(current, event.deltaY)
      if (Math.abs(next - current) < 1e-4) return
      editor.execute(new SetValueCommand(editor, camera, "fov", next))
      return
    }

    // 第一人称漫游：滚轮沿视线前后移动机位（向上滚前进、向下滚后退），步长按指针
    // 下方那个东西的深度取比例（见 ROAM_RATIO），故与右键平移共用同一个手感基准。
    // 注视点（视线锚点）随机位同向平移、保持视线偏移与朝向不变，使漫游后左键旋转仍
    // 以画面中心为中心、不跳变——与右键平移同一 SetCameraPoseCommand 原子撤销链路；
    // updatable=true 令连续滚动在 History 500ms 窗口内合并为一条。
    //
    // 位移仍沿**视线**而不是沿「机位 → 光标点」那条斜线：机位的站位就是成片的机位，
    // 朝光标斜着挪会把取景一起挪走（这与导演视角的轨道相机不同，那儿动的只是观察视角）。
    const step =
      (event.deltaY > 0 ? -1 : 1) *
      Math.max(
        ROAM_RATIO * gestureDepth(camera, event.clientX, event.clientY),
        MIN_ROAM_STEP
      )
    cameraForward(camera, _vec).multiplyScalar(step) // 沿视线前向的世界位移

    const before = camera.position.clone()
    const after = before.clone().add(_vec)

    // 注视点缺省时按当前视线推导手动点（不改朝向）作为随漫游平移的基准。
    const startState = cloneCameraLookAt(ensureCameraLookAt(camera))
    const newState = cloneCameraLookAt(startState)
    newState.target.x += _vec.x
    newState.target.y += _vec.y
    newState.target.z += _vec.z

    editor.execute(
      new SetCameraPoseCommand(
        editor,
        camera,
        after,
        newState,
        before,
        startState,
        true
      )
    )
  }

  function attach(domElement: HTMLElement) {
    detach()
    canvas = domElement
    canvas.addEventListener("pointerdown", onPointerDown)
    canvas.addEventListener("pointermove", onPointerMove)
    canvas.addEventListener("pointerup", onPointerUp)
    canvas.addEventListener("pointercancel", onPointerCancel)
    canvas.addEventListener("wheel", onWheel, { passive: false })
  }

  function detach() {
    if (!canvas) return
    canvas.removeEventListener("pointerdown", onPointerDown)
    canvas.removeEventListener("pointermove", onPointerMove)
    canvas.removeEventListener("pointerup", onPointerUp)
    canvas.removeEventListener("pointercancel", onPointerCancel)
    canvas.removeEventListener("wheel", onWheel)
    canvas = null
  }

  // 渲染器由 useDirectorRenderer 在 onMounted 的微任务中创建并派发；本组合件在
  // setup 阶段同步订阅即可捕获该派发，拿到 renderer.domElement（与 EditorControls/
  // TransformControls 连接的同一元素）。
  function onRendererCreated(renderer: any) {
    attach(renderer.domElement as HTMLElement)
  }
  signals.rendererCreated.add(onRendererCreated)

  onBeforeUnmount(() => {
    signals.rendererCreated.remove(onRendererCreated)
    detach()
  })
}
