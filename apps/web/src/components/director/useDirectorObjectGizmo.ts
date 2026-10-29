import { onBeforeUnmount, onMounted, watch } from "vue"

import {
  directorGizmoOwner,
  fallbackDirectorTransformMode,
  isDirectorTransformModeAllowed,
  ownsDirectorGizmo,
  resolveCameraRigMode,
  resolveObjectTransformModes,
  setDirectorObjectTransformModes
} from "./directorGizmoOwner"
import type { DirectorTransformMode } from "./useDirectorTransform"

// 对象自己那个变换 gizmo（`editor.transformControls`）在导演台里的**唯一裁决点**：
// 只有所有权归 'object' 时它才挂在选中对象上，否则一律摘下（见 directorGizmoOwner）。
//
// 为什么要在 Viewport 之外再管一次：Viewport 在**每一次** objectSelected 里无条件
// `transformControls.attach(object)`，那是 three-editor 完整编辑器的行为，导演台不改引擎层。
// 于是「摘一次就当摘掉了」在导演台里不成立——选中轨迹片段（对象 gizmo 让位给轨迹调节器）之后
// 再点一下模型，Viewport 就把它挂回来了，视口里两个调节器并存。故这里挂一个**优先级低于
// Viewport** 的 objectSelected 监听，排在它之后把不该出现的那次挂载收回去。
//
// 听哪些信号：**选中变化**（attach 就发生在那时）、**变换模式变化**（机位在移动/旋转之间
// 换手）、以及**选中对象自身的变化**——最后这一条是后加的，理由见 onObjectChanged。
//
// 本仓库未迁移时间轴：源项目在这里还挂了一条 gizmo 抬手监听，用来把拖动派生的自动关键帧
// 结算进历史（settleDerivedEdits）。没有时间轴就没有自动关键帧，那条监听随之去掉。
export function useDirectorObjectGizmo(editor: any) {
  const signals = editor.signals

  /** 当前工具栏模式；被注视驱动的机位据它决定这一下归谁（见 resolveCameraRigMode）。 */
  let transformMode: DirectorTransformMode =
    editor.transformControls?.mode ?? "translate"

  /**
   * 能挂 gizmo 的对象。与 Viewport 的判据一致（场景与编辑器相机本身不是可变换的对象），
   * 不另加条件——两处不一致就会出现「Viewport 挂了、我们又摘掉」的闪烁。
   */
  function attachable(object: any): any {
    if (!object || object === editor.scene || object === editor.camera)
      return null
    return object
  }

  /**
   * 把「gizmo 现在挂在谁身上」带来的模式限制发布出去，并在当前模式因此不再可用时换掉它。
   *
   * 机位没有缩放（判据见 resolveObjectTransformModes），故正停在缩放上时选中一个机位，
   * 工具栏要**当场切回移动**——只把按钮置灰是不够的：那时视口里还挂着缩放手柄，拖它照样
   * 能把机位拉变形，而用户看到的是一个自己按不动的按钮正亮着。
   *
   * 放在这里而不是引擎层的 Viewport（骨骼只给旋转那一条就在那儿）：机位是导演台的概念，
   * 引擎层不反向依赖 director 域（见 .claude/rules/three-editor.md §0）。
   */
  function syncTransformModes(target: any): void {
    setDirectorObjectTransformModes(resolveObjectTransformModes(target))

    const mode = editor.transformControls?.mode
    if (!mode || isDirectorTransformModeAllowed(mode)) return
    signals.transformModeChanged.dispatch(fallbackDirectorTransformMode())
  }

  function sync(): void {
    const controls = editor.transformControls
    if (!controls) return

    const selected = ownsDirectorGizmo("object")
      ? attachable(editor.selected)
      : null
    // 被注视驱动的机位：这一下（整体平移 / 绕注视点转）归装置调节器，对象 gizmo 让位。
    // 判据与它那一侧共用，见 resolveCameraRigMode。
    const wanted =
      selected && resolveCameraRigMode(selected, transformMode)
        ? null
        : selected
    // 排在下面那道判等短路之前：短路问的是「gizmo 要不要重挂」，与「工具栏该开放什么」
    // 不是同一个问题。跟在它后面写就得反过来论证「这两件事永远同时变化」，而那是个会随
    // 后续改动悄悄失效的前提。发布那一侧自己判等，重复调用不产生额外重渲染。
    // 传的是**选中的那个对象**而不是最终挂上去的那一个：机位让位给装置调节器时 gizmo 虽
    // 不挂，工具栏该开放什么仍由这个机位说了算（否则按钮会一起亮成全集、缩放也开着）。
    syncTransformModes(selected)

    // 判等短路：attach/detach 都会改 gizmo 的可见性并要求重绘，而本函数挂在每次选中变化上。
    if ((controls.object ?? null) === wanted) return

    if (wanted) controls.attach(wanted)
    else controls.detach()
    // 同其余叠加层：借 cameraChanged 请求一次重绘（Viewport 按需渲染）。
    signals.cameraChanged.dispatch(editor.viewportCamera)
  }

  /**
   * 换变换模式时也要重挂一次：被注视驱动的机位在「移动」与「旋转」之间换手
   * （跟随模式的移动归对象 gizmo、旋转归装置调节器），模式一变谁出场就变了。
   *
   * 用信号带来的那一份而不是回读 editor.transformControls.mode——Viewport 也听这条信号
   * 并在自己的监听里 setMode，两边的先后顺序不该成为本方读数正确与否的前提。
   */
  function onTransformModeChanged(mode: DirectorTransformMode): void {
    transformMode = mode
    sync()
  }

  /**
   * **选中对象自己变了**也要重裁一次。
   *
   * 让位判据是 `resolveCameraRigMode`，而它问的是 `isCameraAimed` ——那读的是
   * `userData.lookAt`，换注视模式只派发 objectChanged（选中态、所有权、变换模式一个都没变）。
   * 不听这条的话：给一台**已经选中**的机位切到「注视对象」，装置调节器出场了，对象 gizmo
   * 却没人收回去，视口里于是两个位置手柄并存——用户报的正是它。
   *
   * 只认**选中的那一个**：objectChanged 在拖动期间是每次指针移动一发，而别的对象变化与
   * 「谁拥有调节器」无关。选中对象自己的那几发则由 sync 内部的判等短路兜住（gizmo 已经挂
   * 在对上的那个人身上时直接返回），故不会每帧 attach/detach。
   */
  function onObjectChanged(object: any): void {
    if (object === editor.selected) sync()
  }

  onMounted(() => {
    // 负优先级 = 排在 Viewport 那条默认优先级（0）的监听**之后**跑（signals 按优先级从高到
    // 低派发）。顺序反了的话，我们摘完 Viewport 又挂回去，改动等于没发生。
    signals.objectSelected.add(sync, null, -100)
    signals.objectChanged.add(onObjectChanged)
    signals.rendererCreated.add(sync)
    signals.transformModeChanged.add(onTransformModeChanged, null, -100)
    sync()
  })

  // 所有权变了立刻对账：轨迹/关节那几方交还所有权时，对象 gizmo 要自己回来（它们只负责
  // 释放，不越权替对象挂 gizmo）。
  const stop = watch(directorGizmoOwner, sync)

  onBeforeUnmount(() => {
    stop()
    signals.objectSelected.remove(sync)
    signals.objectChanged.remove(onObjectChanged)
    signals.rendererCreated.remove(sync)
    signals.transformModeChanged.remove(onTransformModeChanged)
  })
}
