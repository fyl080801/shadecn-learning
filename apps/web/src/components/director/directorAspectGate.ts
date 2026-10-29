import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue"
import type * as THREE from "three"

import { ASPECT_RATIOS, type AspectRatioKey } from "./directorState"

// 画幅比例「分辨率闸门」（resolution gate）单点源。
//
// 背景：视口渲染时 Viewport.ts 的 updateAspectRatio 会把当前视口相机的 aspect
// 改写成「视口容器的超宽比例」并铺满整屏；取景框（DirectorAspectRatioOverlay）
// 只是盖在满屏渲染之上的 CSS 窗口，于是取景框里看到的是满屏渲染的一个放大子窗口，
// 与机位预览（useCameraThumbnail，按所选比例完整渲染相机 = 真实成片）不一致。
//
// 本模块把取景框做成真正的分辨率闸门：给视口相机施加 camera.setViewOffset，使视口
// 渲染成一张「以取景框为基准、向四周扩展（overscan）」的画面——取景框区域内 = 相机
// 在所选比例下的真实输出（完整 FOV + 所选比例）= 机位预览，取景框外则是同一画面的
// 延伸（被叠加层的模糊遮罩盖住）。因为 offset 持久挂在相机投影上，视口拾取/变换
// gizmo/角色标签投影都与所见画面一致，无需另行换算。
//
// 机位预览（useCameraThumbnail）与关键帧截取（useViewportCapture）渲染的是同一个
// 相机对象，必须在各自渲染前用 detachCameraGate 临时摘除该 offset（渲染纯粹的比例
// 成片），渲染后 reattachCameraGate 复原——否则会连同 overscan 一起被渲染/截取。

// 取景框内缩边距，必须与 DirectorAspectRatioOverlay 对齐（单点源在此，叠加层复用）。
//
// 面板列（场景 + 属性）与底部时间轴都停靠在视口区域**之外**，占位已体现在视口自身
// 尺寸里，故这里只需让开仍然悬浮在视口上的两组浮层：
//   - 左侧纵向工具栏（DirectorConsoleModal 的 .director-toolbar-dock：left:16 + 宽 56）；
//   - 右上角罗盘与其下的变换按钮列（.director-view-helper：right:16 + 宽 72）。
const EDGE_MARGIN = 24
const OVERLAY_GAP = 8
// 工具栏与取景框之间留得比罗盘那侧宽：工具栏整列贴着取景框左缘，8px 显得局促。
const TOOLBAR_GAP = 16
const TOOLBAR_CLEARANCE = 16 + 56 + TOOLBAR_GAP
const VIEW_HELPER_CLEARANCE = 16 + 72 + OVERLAY_GAP

export interface AspectGateFrame {
  x: number
  y: number
  w: number
  h: number
}

// 在视口区域内（扣除边缘余地、左侧纵向工具栏与右上角罗盘列的占位后）按所选比例
// contain 适配并居中的取景框（视口像素坐标，y 向下）。`auto` 或尺寸无效时返回 null。
// 该矩形的宽高比严格等于所选比例（contain-fit 保证），是叠加层绘制与相机闸门的
// 唯一几何来源。
//
// viewW/viewH 传入的是视口区域（而非整个浮层）的尺寸：面板列与时间轴的显隐、
// 时间轴高度变化都会改变这两个值，取景框随之重算，无需额外的让位参数。
export function computeAspectGateFrame(
  viewW: number,
  viewH: number,
  ratioKey: AspectRatioKey
): AspectGateFrame | null {
  if (ratioKey === "auto" || viewW <= 0 || viewH <= 0) return null
  const a = ASPECT_RATIOS[ratioKey]
  if (!a) return null

  const marginTop = EDGE_MARGIN
  const marginBottom = EDGE_MARGIN
  const marginLeft = TOOLBAR_CLEARANCE
  const marginRight = VIEW_HELPER_CLEARANCE
  const availW = Math.max(0, viewW - marginLeft - marginRight)
  const availH = Math.max(0, viewH - marginTop - marginBottom)
  if (availW <= 0 || availH <= 0) return null

  let fw: number
  let fh: number
  if (a >= availW / availH) {
    fw = availW
    fh = availW / a
  } else {
    fh = availH
    fw = availH * a
  }
  if (fw <= 0 || fh <= 0) return null
  return {
    x: marginLeft + (availW - fw) / 2,
    y: marginTop + (availH - fh) / 2,
    w: fw,
    h: fh
  }
}

// 给相机施加分辨率闸门：让取景框区域（frame）恰好显示相机在所选比例下的完整视锥
// （aspect = frame.w/frame.h = 所选比例），视口其余区域为同一画面向四周的延伸。
//
// 推导：setViewOffset(fullW, fullH, x, y, w, h) 把相机基准视锥映射到参考图
// fullW×fullH，并把其中子窗 [x, x+w]×[y, y+h] 铺到实际 GL 视口。取参考图 = 取景框
// （fullW=frame.w, fullH=frame.h），渲染子窗 = 整个视口（w=viewW, h=viewH），偏移
// 到取景框左上（x=-frame.x, y=-frame.y，y 向下），则 GL 像素 p 对应参考坐标 p-frame.*，
// 取景框像素 [frame.x, frame.x+frame.w] 恰好回落到参考 [0, frame.w] = 完整基准视锥。
// 令 aspect = frame.w/frame.h，可验证最终视锥宽高比 = viewW/viewH，画面无拉伸。
function applyCameraGate(
  camera: any,
  frame: AspectGateFrame,
  viewW: number,
  viewH: number
): boolean {
  if (!camera?.isPerspectiveCamera) return false
  if (frame.w <= 0 || frame.h <= 0 || viewW <= 0 || viewH <= 0) return false
  camera.aspect = frame.w / frame.h
  camera.setViewOffset(frame.w, frame.h, -frame.x, -frame.y, viewW, viewH)
  camera.updateProjectionMatrix()
  return true
}

// 清除相机闸门，恢复为满铺视口的常规投影（aspect = 视口宽高比）。
function resetCameraGate(camera: any, viewW: number, viewH: number) {
  if (!camera?.isPerspectiveCamera) return
  if (camera.view?.enabled) camera.clearViewOffset()
  if (viewW > 0 && viewH > 0) camera.aspect = viewW / viewH
  camera.updateProjectionMatrix()
}

// 闸门挂起开关：影片录制（useDirectorMovieExport）期间，渲染表面本身被缩到取景框
// 大小、相机 aspect 由录制流程按所选画幅接管，闸门必须整体让位——既不能再施加
// view offset（否则录进 overscan），也不能在 windowResize 后把 aspect 改回视口宽高比
// （否则覆盖录制画幅）。与 detachCameraGate 的区别：后者只摘一次，随后任何一次
// 信号触发都会把闸门装回来，无法覆盖一整段录制过程。
const gateSuspended = ref(false)

export function setCameraGateSuspended(suspended: boolean) {
  gateSuspended.value = suspended
}

export interface CameraGateSnapshot {
  fullWidth: number
  fullHeight: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

// 临时摘除相机上的分辨率闸门（若有），返回快照供之后复原。机位预览与关键帧截取需在
// 渲染前调用，使其渲染的是纯粹的比例成片而非带 overscan 的视口画面。调用方随后会自行
// 设置渲染用 aspect 并 updateProjectionMatrix，故此处 clearViewOffset 后不必再刷新。
export function detachCameraGate(camera: any): CameraGateSnapshot | null {
  const view = camera?.view
  if (!view?.enabled) return null
  const snapshot: CameraGateSnapshot = {
    fullWidth: view.fullWidth,
    fullHeight: view.fullHeight,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
    width: view.width,
    height: view.height
  }
  camera.clearViewOffset()
  return snapshot
}

// 复原 detachCameraGate 摘除的闸门。调用方在其后会 updateProjectionMatrix
// （随 aspect 还原一并刷新），故此处不重复刷新。
export function reattachCameraGate(
  camera: any,
  snapshot: CameraGateSnapshot | null
) {
  if (!snapshot) return
  camera.setViewOffset(
    snapshot.fullWidth,
    snapshot.fullHeight,
    snapshot.offsetX,
    snapshot.offsetY,
    snapshot.width,
    snapshot.height
  )
}

// 将分辨率闸门与「当前视口相机」保持同步：取景框/视口尺寸/所选比例变化，
// 以及视口相机切换（导演视角↔机位视角、切换机位）或视角重置后（这些都会触发
// Viewport.updateAspectRatio 把相机 aspect 改回视口宽高比）都重新施加。切换视口相机时
// 先清除上一台相机残留的 offset（否则会污染其机位预览缩略图）。
//
// frame/size 由 DirectorAspectRatioOverlay 测量并传入，保证叠加层绘制与相机闸门取用
// 同一份几何。施加后派发 cameraChanged 触发视口重渲染（该信号在 Viewport 中仅重置
// pathtracer + 请求渲染，DirectorViewHelper 仅标脏罗盘，无副作用）。
export function useCameraAspectGate(
  editor: any,
  frame: Ref<AspectGateFrame | null>,
  size: Ref<{ w: number; h: number }>
) {
  // 当前已被施加闸门的相机（THREE 对象，不入响应式）。
  let gatedCamera: THREE.PerspectiveCamera | null = null
  let scheduled = false
  let disposed = false

  function apply() {
    const camera = editor.viewportCamera
    const { w: viewW, h: viewH } = size.value

    // 视口相机已切换：先解除上一台的残留闸门（否则会污染其机位预览缩略图）。
    if (gatedCamera && gatedCamera !== camera) {
      resetCameraGate(gatedCamera, viewW, viewH)
      gatedCamera = null
    }

    if (!camera?.isPerspectiveCamera) return

    // 挂起（录制中）：只摘掉自己残留的 view offset，不碰 aspect——此时相机的
    // 宽高比属于录制流程，见 setCameraGateSuspended。
    if (gateSuspended.value) {
      if (gatedCamera) {
        if (camera.view?.enabled) camera.clearViewOffset()
        camera.updateProjectionMatrix()
        gatedCamera = null
      }
      return
    }

    const f = frame.value
    if (f && applyCameraGate(camera, f, viewW, viewH)) {
      gatedCamera = camera
    } else {
      resetCameraGate(camera, viewW, viewH)
      gatedCamera = null
    }

    editor.signals.cameraChanged.dispatch(camera)
  }

  // viewportCameraChanged/windowResize/cameraResetted 会同步触发 Viewport 的
  // updateAspectRatio（把相机 aspect 改回视口宽高比）。若本监听器在其之前执行，
  // 闸门会被随后覆盖成错误 aspect。故统一用微任务合并调度：apply 总在同步信号
  // 处理链跑完之后、下一帧渲染（rAF）之前执行，与监听注册顺序无关，并把同一
  // tick 内的多次触发合并为一次。
  //
  // 另一半保障在 Viewport.updateAspectRatio 里：已装上 view offset 的相机（即本
  // 闸门的作用对象）它不再改写 aspect。否则 windowResize 之后、本微任务重算之前
  // 的那次同步重绘（Viewport 为避免 resize 清空绘制缓冲区而必须做，见那里的说明）
  // 会用「视口比例 + 闸门 offset」渲染，画面横向拉伸——连续拖拽调整视口尺寸时
  // 表现为画面持续扭曲。
  function scheduleApply() {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) apply()
    })
  }

  // frame 依赖 size/aspectRatio，watch 它即覆盖两者变化；size 单独再 watch
  // 一次以确保 viewW/viewH 变化（即便 frame 恒为 null 的 auto 态）也重算。
  watch([frame, size], scheduleApply, { deep: true })
  // 挂起/恢复同样要重算：恢复时把闸门重新装回当前视口相机。
  watch(gateSuspended, scheduleApply)

  onMounted(() => {
    editor.signals.viewportCameraChanged.add(scheduleApply)
    editor.signals.cameraResetted.add(scheduleApply)
    editor.signals.windowResize.add(scheduleApply)
    scheduleApply()
  })

  onBeforeUnmount(() => {
    disposed = true
    editor.signals.viewportCameraChanged.remove(scheduleApply)
    editor.signals.cameraResetted.remove(scheduleApply)
    editor.signals.windowResize.remove(scheduleApply)
    // 卸载时清除残留 offset，避免相机带着闸门泄漏到下一次会话/其它消费方。
    if (gatedCamera) {
      const { w: viewW, h: viewH } = size.value
      resetCameraGate(gatedCamera, viewW, viewH)
      gatedCamera = null
    }
  })
}
