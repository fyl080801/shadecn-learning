import * as THREE from "three"
import { PMREMGenerator } from "three/webgpu"

import { TransformControls } from "three/addons/controls/TransformControls.js"

import { EditorControls } from "./EditorControls"
import { readAuthored } from "./EvaluatedTransform"
import { resolveClickTarget } from "./Selector"

import { XR } from "./Viewport.XR"

import { SetPositionCommand } from "./commands/SetPositionCommand"
import { SetRotationCommand } from "./commands/SetRotationCommand"
import { SetScaleCommand } from "./commands/SetScaleCommand"
import { SetCrowdSpacingCommand } from "./commands/SetCrowdSpacingCommand"

import { ColorEnvironment } from "three/addons/environments/ColorEnvironment.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { ViewportPathtracer } from "./Viewport.Pathtracer"
import { markShotViewHelper, renderShotViewHelpers } from "./shotViewHelpers"
import { enableTransformShiftEven } from "./transformShiftEven"
import type { Editor } from "./Editor"

function Viewport(editor: Editor): HTMLDivElement {
  const selector = editor.selector
  const signals = editor.signals

  const container = document.createElement("div")
  container.id = "viewport"
  container.style.position = "absolute"

  //

  let renderer: any = null
  let pmremGenerator: any = null
  let pathtracer: any = null

  // 帧内渲染合并标记（见下方 render()/animate()）。
  let renderRequested = false
  // 选中框包围盒待重算标记：objectChanged/geometryChanged 只置位，
  // 由 animate() 在真正渲染前每帧最多重算一次（精确模式对蒙皮角色开销大）。
  let selectionBoxNeedsUpdate = false
  // 本帧的重算是不是「跟着动画走的那一次」（时间轴逐帧写回 sceneAnimated、
  // AnimationMixer 播放）。精确模式要按骨骼给**每个顶点**做一遍蒙皮
  // （Box3.expandByObject → SkinnedMesh.getVertexPosition），对一具几万顶点的角色
  // 就是每帧十几毫秒的纯 CPU 开销——选中一个角色再播放，掉帧的正是这一笔。
  // 故动画期间与拖拽 gizmo 一样退回廉价包围盒（读每个网格缓存的 boundingBox 再变换），
  // 由 selectionBoxPreciseDirty 记账，在动画停下后的第一帧补一次精确重算。
  let selectionBoxAnimating = false
  let selectionBoxPreciseDirty = false

  let camera: any = editor.camera
  const scene = editor.scene
  const sceneHelpers = editor.sceneHelpers

  // 在 `scene` 之后、`grid`/`sceneHelpers` 之前渲染（见下文
  // render()），这样当地面平面的半透明填充叠加在其上时，
  // 这里绘制的内容已经是缓冲区中真正的背景色了。作为独立场景
  // 而非放在 sceneHelpers 中，使其能在网格/辅助器之前渲染，
  // 而不会与它们争抢渲染顺序。由 Editor 拥有（见 Editor.ts），
  // 以便在此 Viewport 构造之前就已存在。
  const backdrop = editor.backdrop

  // 辅助器

  const GRID_COLORS_LIGHT = [0x999999, 0x777777]
  const GRID_COLORS_DARK = [0x555555, 0x888888]
  const GRID_PLANE_COLOR_LIGHT = 0x3b82f6
  const GRID_PLANE_COLOR_DARK = 0x60a5fa

  // 由 Editor 拥有（见 Editor.ts），不在此构造，原因同上文的 `backdrop`。
  const grid = editor.grid
  const [grid1, grid2] = grid.children
  const gridPlane = editor.groundPlane

  const box = new THREE.Box3()

  const selectionBox: any = new THREE.Box3Helper(box)
  selectionBox.material.depthTest = false
  selectionBox.material.transparent = true
  selectionBox.visible = false

  let objectPositionOnDown: THREE.Vector3 | null = null
  let objectRotationOnDown: THREE.Euler | null = null
  let objectScaleOnDown: THREE.Vector3 | null = null

  // gizmo 拖拽的两个端点值一律取 **authored**，不取节点上的合成值（见 EvaluatedTransform）：
  // 节点上此刻的 position/quaternion 可能含派生量——轨迹段内的采样点、切线朝向、跟拍算出来
  // 的机位站位。拿合成值当 old 存进历史，撤销一步就把派生量固化成作者数据（对象被送到那一
  // 刻的路径采样点上，下一次求值再复合一遍）；拿合成值当 new 写回同理，等于把当时的派生量
  // 并进 authored。SetPosition/SetRotationCommand 内部读写的本就是 authored，这里只是把
  // 调用方这一端补齐。缩放没有派生来源（求值层只记账 position/quaternion），照旧读节点。
  const _authoredQuat = new THREE.Quaternion()

  function authoredPositionOf(object: THREE.Object3D): THREE.Vector3 {
    return new THREE.Vector3().fromArray(readAuthored(object, "position"))
  }

  /** authored 角度，按节点自己的 Euler 轴序读出（群众分组等用非默认顺序）。 */
  function authoredRotationOf(object: THREE.Object3D): THREE.Euler {
    return new THREE.Euler().setFromQuaternion(
      _authoredQuat.fromArray(readAuthored(object, "quaternion")),
      object.rotation.order
    )
  }

  // 群众分组（userData.isCrowdGroup）的缩放手柄语义是调整成员之间的水平
  // 间距（x/z），而非缩放分组或每个成员自身的可见大小——分组 object.scale
  // 必须恒定保持 (1,1,1)。TransformControls 的缩放实现无法感知这层语义，
  // 拖拽时会照常直接写 object.scale；这里在 objectChange 时把它解读为
  // "相对 mouseDown 时间距倍率的比例"，实时把比例应用到各成员的 x/z 局部
  // 位置上做预览，并把分组自身的 scale 立即复位为 (1,1,1)，使分组和成员的
  // 可见大小全程不变。mouseUp 时把最终倍率提交为一条 SetCrowdSpacingCommand
  // （而非下面 case 'scale' 分支默认的 SetScaleCommand——分组的 object.scale
  // 因每帧都被复位为 (1,1,1)，与 mouseDown 时相等，该分支天然不会触发）。
  // 仅当选中对象带 isCrowdGroup 标记时才生效，三维编辑器完整 chrome 与
  // 导演台内除群众分组外的其余对象都不产生这一标记，不受影响。
  //
  // x/z 两轴的间距倍率彼此独立（而非折算为单一倍率）：TransformControls
  // 按当前激活的手柄分别写入 object.scale 对应分量——单轴手柄（X/Z）只改
  // 该轴分量，另一分量保持 1；XZ 平面手柄两分量各自独立变化。因此直接读取
  // scale.x/scale.z 即可拿到各自的拖拽比例，无需按 this.axis 分支处理，
  // 也不能合并为平均值，否则只调整一个轴会连带改变另一轴。
  let crowdSpacingOnDown: {
    factors: { x: number; z: number }
    positions: { x: number; z: number }[]
  } | null = null
  let crowdSpacingLiveFactors = { x: 1, z: 1 }

  function crowdSpacingDragRatios(): { x: number; z: number } {
    const scale = transformControls.object.scale
    return { x: scale.x, z: scale.z }
  }

  function applyCrowdSpacingPositions(
    object: any,
    basePositions: { x: number; z: number }[],
    baseFactors: { x: number; z: number },
    targetFactors: { x: number; z: number }
  ) {
    const ratioX = baseFactors.x === 0 ? 1 : targetFactors.x / baseFactors.x
    const ratioZ = baseFactors.z === 0 ? 1 : targetFactors.z / baseFactors.z
    const children = object.children
    for (let i = 0; i < children.length; i++) {
      const base = basePositions[i]
      if (!base) continue
      children[i].position.x = base.x * ratioX
      children[i].position.z = base.z * ratioZ
    }
    object.updateMatrixWorld(true)
  }

  // 群众分组的缩放手柄只保留水平面两轴（X/Z）与其 XZ 平面手柄，隐藏竖直轴
  // （Y）——间距调整不影响高度。TransformControls 的 showY 是缩放/平移/旋转
  // 三种模式共用的开关，因此只在"当前是缩放模式且选中对象是分组"时才关闭，
  // 切换到平移/旋转模式或选中其它对象时必须恢复为 true，否则会连带隐藏
  // 平移模式下的 Y 轴手柄，导致分组无法整体升降。showY=false 时
  // TransformControls 内部的可见性判定会一并隐藏依赖 showY 的 XY/YZ 平面
  // 手柄与 XYZE 全轴统一缩放手柄（见其 updateMatrixWorld 的可见性表达式），
  // 无需再逐个手动隐藏。
  function syncCrowdScaleAxisVisibility() {
    const object = transformControls.object
    transformControls.showY = !(
      transformControls.getMode() === "scale" &&
      !!object?.userData?.isCrowdGroup
    )
  }

  const transformControls: any = new TransformControls(camera)
  // 拖平面手柄（XY/YZ/XZ）时按住 Shift 让两个轴等量变化——移动即沿平面对角线走、缩放即
  // 两轴同倍率（见 transformShiftEven.ts）。装在这里即覆盖三维编辑器与导演台共用的这一个
  // 对象 gizmo。
  enableTransformShiftEven(transformControls)
  transformControls.addEventListener("axis-changed", function () {
    if (editor.viewportShading !== "realistic") render()
  })
  transformControls.addEventListener("objectChange", function () {
    const object = transformControls.object
    if (
      crowdSpacingOnDown &&
      transformControls.getMode() === "scale" &&
      object?.userData?.isCrowdGroup
    ) {
      const ratios = crowdSpacingDragRatios()
      crowdSpacingLiveFactors = {
        x: crowdSpacingOnDown.factors.x * ratios.x,
        z: crowdSpacingOnDown.factors.z * ratios.z
      }
      applyCrowdSpacingPositions(
        object,
        crowdSpacingOnDown.positions,
        crowdSpacingOnDown.factors,
        crowdSpacingLiveFactors
      )
      object.scale.set(1, 1, 1)
      // 拖拽期间也实时写回 userData，使属性面板的间距滑块跟随拖拽同步
      // 显示（与其余变换字段在拖拽期间的实时回填行为一致）；mouseUp 提交
      // 的 SetCrowdSpacingCommand 仍以 crowdSpacingOnDown 显式基准计算
      // undo/redo，不依赖这里的实时写入。
      if (object.userData.crowdConfig) {
        object.userData.crowdConfig.scaleFactorX = crowdSpacingLiveFactors.x
        object.userData.crowdConfig.scaleFactorZ = crowdSpacingLiveFactors.z
      }
    }
    signals.objectChanged.dispatch(transformControls.object)
  })
  transformControls.addEventListener("mouseDown", function () {
    const object = transformControls.object

    objectPositionOnDown = authoredPositionOf(object)
    objectRotationOnDown = authoredRotationOf(object)
    objectScaleOnDown = object.scale.clone()

    if (object?.userData?.isCrowdGroup) {
      const factors = {
        x: object.userData.crowdConfig?.scaleFactorX ?? 1,
        z: object.userData.crowdConfig?.scaleFactorZ ?? 1
      }
      crowdSpacingOnDown = {
        factors,
        positions: object.children.map((child: any) => ({
          x: child.position.x,
          z: child.position.z
        }))
      }
      crowdSpacingLiveFactors = factors
    } else {
      crowdSpacingOnDown = null
    }

    controls.enabled = false
  })
  transformControls.addEventListener("mouseUp", function () {
    const object = transformControls.object

    if (object !== undefined) {
      switch (transformControls.getMode()) {
        case "translate": {
          // 拖动期间 TC 直写节点，求值层已把那一笔认领成 authored（见
          // adoptExternalEdit），故此刻 authored 就是「用户把它拖到的地方」。
          const position = authoredPositionOf(object)
          if (!objectPositionOnDown!.equals(position)) {
            editor.execute(
              new SetPositionCommand(
                editor,
                object,
                position,
                objectPositionOnDown
              )
            )
          }

          break
        }

        case "rotate": {
          const rotation = authoredRotationOf(object)
          if (!objectRotationOnDown!.equals(rotation)) {
            editor.execute(
              new SetRotationCommand(
                editor,
                object,
                rotation,
                objectRotationOnDown
              )
            )
          }

          break
        }

        case "scale":
          if (crowdSpacingOnDown) {
            const changed =
              Math.abs(
                crowdSpacingLiveFactors.x - crowdSpacingOnDown.factors.x
              ) >= 0.001 ||
              Math.abs(
                crowdSpacingLiveFactors.z - crowdSpacingOnDown.factors.z
              ) >= 0.001
            if (changed) {
              editor.execute(
                new SetCrowdSpacingCommand(
                  editor,
                  object,
                  crowdSpacingLiveFactors,
                  crowdSpacingOnDown.factors,
                  crowdSpacingOnDown.positions
                )
              )
            } else {
              // 未产生实际拖动（如仅点击未移动）：把预览覆盖的位置与
              // 实时回填的 userData 精确复原到起始快照，避免浮点误差残留。
              applyCrowdSpacingPositions(
                object,
                crowdSpacingOnDown.positions,
                crowdSpacingOnDown.factors,
                crowdSpacingOnDown.factors
              )
              if (object.userData.crowdConfig) {
                object.userData.crowdConfig.scaleFactorX =
                  crowdSpacingOnDown.factors.x
                object.userData.crowdConfig.scaleFactorZ =
                  crowdSpacingOnDown.factors.z
              }
            }
          } else if (!objectScaleOnDown!.equals(object.scale)) {
            editor.execute(
              new SetScaleCommand(
                editor,
                object,
                object.scale,
                objectScaleOnDown
              )
            )
          }

          break
      }

      // 拖拽期间出于性能使用了廉价（非精确）包围盒；拖拽停止后
      // 更新为精确包围盒。
      if (editor.selected === object) {
        box.setFromObject(object, true)
        selectionBoxPreciseDirty = false
      }
    }

    crowdSpacingOnDown = null

    // 仅在导演视角恢复轨道控制；机位视角下轨道控制器始终关闭。
    controls.enabled = editor.viewportCamera === editor.camera
  })

  // 变换 gizmo：在导演视角随 sceneHelpers 一同渲染；机位视角下作为「编辑必需」
  // 的例外单独渲染（见 render() 与 shotViewHelpers.ts），使机位视角也能选中并
  // 拖拽编辑对象。
  const transformHelper = markShotViewHelper(transformControls.getHelper())
  sceneHelpers.add(transformHelper)

  //

  new XR(editor, transformControls)

  // 事件

  function updateAspectRatio() {
    for (const uuid in editor.cameras) {
      const camera: any = editor.cameras[uuid]

      const aspect = container.offsetWidth / container.offsetHeight

      if (camera.isPerspectiveCamera) {
        // 带显式 view offset 的相机，其 aspect 属于装上该 offset 的一方
        // （导演台的画幅闸门 directorAspectGate：aspect = 取景框比例，
        // 视口宽高比由 offset 的子窗尺寸表达），在此改写会让投影的宽高比
        // 变成「视口比例²/取景框比例」，画面明显横向拉伸。闸门会在自己的
        // 调度里随尺寸变化重算，这里跳过即可；无 offset 的相机行为不变。
        if (camera.view?.enabled !== true) camera.aspect = aspect
      } else {
        const frustumHeight = camera.top - camera.bottom

        camera.left = (-frustumHeight * aspect) / 2
        camera.right = (frustumHeight * aspect) / 2
      }

      camera.updateProjectionMatrix()

      const cameraHelper: any = editor.helpers[camera.id]
      if (cameraHelper) cameraHelper.update()
    }
  }

  const onDownPosition = new THREE.Vector2()
  const onUpPosition = new THREE.Vector2()
  const onDoubleClickPosition = new THREE.Vector2()

  function getMousePosition(dom: HTMLElement, x: number, y: number) {
    const rect = dom.getBoundingClientRect()
    return [(x - rect.left) / rect.width, (y - rect.top) / rect.height]
  }

  function handleClick() {
    if (onDownPosition.distanceTo(onUpPosition) === 0) {
      const intersects = selector.getPointerIntersects(
        onUpPosition,
        editor.viewportCamera as THREE.Camera
      )
      signals.intersectionsDetected.dispatch(intersects)

      render()
    }
  }

  function onMouseDown(event: any) {
    // event.preventDefault();

    if (event.target !== renderer.domElement) return

    const array = getMousePosition(container, event.clientX, event.clientY)
    onDownPosition.fromArray(array)

    document.addEventListener("mouseup", onMouseUp)
  }

  function onMouseUp(event: any) {
    const array = getMousePosition(container, event.clientX, event.clientY)
    onUpPosition.fromArray(array)

    handleClick()

    document.removeEventListener("mouseup", onMouseUp)
  }

  function onTouchStart(event: any) {
    const touch = event.changedTouches[0]

    const array = getMousePosition(container, touch.clientX, touch.clientY)
    onDownPosition.fromArray(array)

    document.addEventListener("touchend", onTouchEnd)
  }

  function onTouchEnd(event: any) {
    const touch = event.changedTouches[0]

    const array = getMousePosition(container, touch.clientX, touch.clientY)
    onUpPosition.fromArray(array)

    handleClick()

    document.removeEventListener("touchend", onTouchEnd)
  }

  function onDoubleClick(event: any) {
    const array = getMousePosition(container, event.clientX, event.clientY)
    onDoubleClickPosition.fromArray(array)

    const intersects = selector.getPointerIntersects(
      onDoubleClickPosition,
      editor.viewportCamera as THREE.Camera
    )

    if (intersects.length > 0) {
      const intersect = intersects[0]!

      // 双击命中群众分组内的成员时下钻到成员本身（而非在此之前的两次
      // 单击已经选中的整个分组）——resolveClickTarget 只解析到角色/机位
      // 这一级，不再像 Selector 内部单击路径那样继续冒泡到分组。对没有
      // 群众分组祖先的对象，这里与单击已选中的对象相同，select 是无操作
      // 的 no-op（见 Selector.select 的相等性早退）。
      const target: any = resolveClickTarget(intersect.object)
      editor.select(target)

      // 分组内成员的选中（单击选中整组、双击下钻到成员）都只是切换选中
      // 对象，不应联动改变视口——与 DirectorToolbar 添加对象"仅添加并选中，
      // 不调用 editor.focus"同一约定：focus 会让轨道相机对准对象重新
      // 取景，突变视口缩放/距离，选中操作不应改变用户当前的视口。对非
      // 分组对象保留双击聚焦这一既有能力。
      if (!target?.parent?.userData?.isCrowdGroup) {
        signals.objectFocused.dispatch(intersect.object)
      }
    }
  }

  // 视口拾取：把屏幕坐标解析成场景里的一个世界点，供**相机导航**标定手感——绕哪儿
  // 转、拖多快、朝哪儿推都以指针下方那个东西所在的深度为准（见 EditorControls 的
  // 类注释与 director/useDirectorCameraControls）。
  //
  // 没打中任何图形时退回**地面平面**：导演台是一个舞台，空白处多半就是地面，按地面
  // 深度标定远比退回一个与画面无关的固定距离接近直觉。射线与地面平行、或交点在身后
  // 时才真的返回 null，此时各调用方保持原有行为。
  const _pickRaycaster = new THREE.Raycaster()
  const _pickPointer = new THREE.Vector2()
  const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const _groundHit = new THREE.Vector3()

  // 一次解析是一遍整场射线（蒙皮角色不便宜），而滚轮连滚一次就是几十个事件。光标没动
  // 就复用上一次的结果——这同时让「滚进去再滚回来」严格可逆：每一格用的都是同一个焦点。
  // 缓存收在这一处、不在各调用方各存一份（EditorControls 与机位视角的漫游都问它）。
  const PICK_CACHE_MS = 200
  const PICK_CACHE_PX = 2
  let pickCacheX = 0
  let pickCacheY = 0
  let pickCacheTime = -Infinity
  let pickCachePoint: THREE.Vector3 | null = null

  function resolveViewportPoint(
    clientX: number,
    clientY: number
  ): THREE.Vector3 | null {
    const [x, y] = getMousePosition(container, clientX, clientY)

    const viewportCamera = editor.viewportCamera as THREE.Camera
    const intersects = selector.getPointerIntersects(
      { x: x!, y: y! },
      viewportCamera
    )
    if (intersects.length > 0) return intersects[0]!.point.clone()

    _pickPointer.set(x! * 2 - 1, -(y! * 2) + 1)
    _pickRaycaster.setFromCamera(_pickPointer, viewportCamera)
    _groundPlane.constant = -grid.position.y

    return _pickRaycaster.ray.intersectPlane(_groundPlane, _groundHit)
      ? _groundHit.clone()
      : null
  }

  function pickViewportPoint(
    clientX: number,
    clientY: number
  ): THREE.Vector3 | null {
    const now = performance.now()
    const fresh =
      now - pickCacheTime < PICK_CACHE_MS &&
      Math.abs(clientX - pickCacheX) <= PICK_CACHE_PX &&
      Math.abs(clientY - pickCacheY) <= PICK_CACHE_PX

    if (!fresh) {
      pickCacheX = clientX
      pickCacheY = clientY
      pickCacheTime = now
      pickCachePoint = resolveViewportPoint(clientX, clientY)
    }

    // 每次交出副本：调用方拿去做焦点/深度换算时就地改写不该污染缓存。
    return pickCachePoint ? pickCachePoint.clone() : null
  }

  editor.pickViewportPoint = pickViewportPoint

  container.addEventListener("mousedown", onMouseDown)
  container.addEventListener("touchstart", onTouchStart, { passive: false })
  container.addEventListener("dblclick", onDoubleClick)

  // 控制器需要在主逻辑*之后*添加，
  // 否则 controls.enabled 不起作用。

  const controls = new EditorControls(camera)
  controls.pickPoint = pickViewportPoint
  controls.addEventListener("change", function () {
    signals.cameraChanged.dispatch(camera)
    signals.refreshSidebarObject3D.dispatch(camera)
  })

  editor.controls = controls
  // 暴露 transformControls：机位视角的相机导航需读取其 axis/dragging 状态，
  // 以便左键落在变换 gizmo 上时让位于对象拖拽、而非旋转机位（见 Editor.ts 注释）。
  editor.transformControls = transformControls

  // 信号

  signals.editorCleared.add(function () {
    controls.center.set(0, 0, 0)
    if (pathtracer) pathtracer.reset()

    initPT()

    signals.sceneEnvironmentChanged.dispatch(editor.environmentType)
  })

  signals.transformModeChanged.add(function (mode: any) {
    transformControls.setMode(mode)
    syncCrowdScaleAxisVisibility()

    render()
  })

  signals.snapChanged.add(function (dist: any) {
    transformControls.setTranslationSnap(dist)
  })

  signals.spaceChanged.add(function (space: any) {
    transformControls.setSpace(space)

    render()
  })

  signals.rendererUpdated.add(function () {
    scene.traverse(function (child: any) {
      if (child.material !== undefined) {
        child.material.needsUpdate = true
      }
    })

    render()
  })

  signals.rendererCreated.add(function (newRenderer: any) {
    if (renderer !== null) {
      renderer.setAnimationLoop(null)

      try {
        pmremGenerator.dispose()
      } catch (e) {
        console.warn("PMREMGenerator dispose error:", e)
      }

      renderer.dispose()

      container.removeChild(renderer.domElement)
    }

    controls.connect(newRenderer.domElement)
    transformControls.connect(newRenderer.domElement)

    renderer = newRenderer

    renderer.setAnimationLoop(animate)
    renderer.setClearColor(0xaaaaaa)

    if (window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      mediaQuery.addEventListener("change", function (event) {
        renderer.setClearColor(event.matches ? 0x333333 : 0xaaaaaa)
        updateGridColors(
          grid1,
          grid2,
          event.matches ? GRID_COLORS_DARK : GRID_COLORS_LIGHT,
          gridPlane,
          event.matches ? GRID_PLANE_COLOR_DARK : GRID_PLANE_COLOR_LIGHT
        )

        render()
      })

      renderer.setClearColor(mediaQuery.matches ? 0x333333 : 0xaaaaaa)
      updateGridColors(
        grid1,
        grid2,
        mediaQuery.matches ? GRID_COLORS_DARK : GRID_COLORS_LIGHT,
        gridPlane,
        mediaQuery.matches ? GRID_PLANE_COLOR_DARK : GRID_PLANE_COLOR_LIGHT
      )
    }

    renderer.getClearColor(editor.viewportColor)

    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(container.offsetWidth, container.offsetHeight)

    if (renderer.isWebGLRenderer) {
      pmremGenerator = new THREE.PMREMGenerator(renderer)
      pmremGenerator.compileEquirectangularShader()

      pathtracer = ViewportPathtracer(renderer)
    } else {
      pmremGenerator = new PMREMGenerator(renderer)

      pathtracer = null
    }

    container.appendChild(renderer.domElement)

    signals.sceneEnvironmentChanged.dispatch(editor.environmentType)

    render()
  })

  signals.rendererDetectKTX2Support.add(function (ktx2Loader: any) {
    ktx2Loader.detectSupport(renderer)
  })

  signals.sceneGraphChanged.add(function () {
    initPT()
    render()
  })

  signals.cameraChanged.add(function () {
    if (pathtracer) pathtracer.reset()

    render()
  })

  // 逐帧动画写回（见 Editor.ts 的 signals.sceneAnimated）：只做「跟着动的东西」非做不可
  // 的两件事——选中框重算标记 + 请求一次重绘。**不做**数值回填，也不逐帧遍历 helpers：
  // 那些都在 objectChanged 那条线上，由播放停下时的一次 settle 统一对账。
  //
  // 选中框同样只置位、不当场重算（精确模式要遍历蒙皮角色的每个顶点），由 flushRender
  // 每帧最多算一次，且这一次走**廉价**包围盒——与拖拽 gizmo 走的是同一条路，
  // 理由见 selectionBoxAnimating 的声明处。
  signals.sceneAnimated.add(function () {
    if (editor.selected !== null) {
      selectionBoxNeedsUpdate = true
      selectionBoxAnimating = true
    }

    if (pathtracer) pathtracer.reset()

    render()
  })

  signals.objectSelected.add(function (object: any) {
    selectionBox.visible = false
    transformControls.detach()

    if (object !== null && object !== scene && object !== camera) {
      box.setFromObject(object, true)

      if (box.isEmpty() === false) {
        selectionBox.visible = true
      }

      transformControls.attach(object)

      // 在此编辑器中骨骼仅支持旋转：平移/缩放骨骼会使其偏离父级，
      // 并破坏关节连接。
      if (object.isBone && transformControls.mode !== "rotate") {
        signals.transformModeChanged.dispatch("rotate")
      }
    }

    syncCrowdScaleAxisVisibility()

    render()
  })

  signals.objectFocused.add(function (object: any) {
    controls.focus(object)
  })

  signals.geometryChanged.add(function (object: any) {
    if (object !== undefined && editor.selected === object) {
      selectionBoxNeedsUpdate = true
    }

    initPT()
    render()
  })

  signals.objectChanged.add(function (object: any) {
    if (editor.selected === object) {
      // 精确模式会遍历并变换子树中每个网格的每个顶点，对于蒙皮角色
      // （大量骨骼 + 密集网格）来说，在每个 pointer-move 上重复执行
      // 会导致明显的拖拽卡顿。此外一次交互（姿势滑块、注视跟随级联）
      // 可能在同一帧内派发多次 objectChanged，这里只标记待更新，与渲染
      // 一起在动画循环中每帧最多重算一次（见 animate()）。
      selectionBoxNeedsUpdate = true
    }

    if (object.isPerspectiveCamera) {
      object.updateProjectionMatrix()
    }

    const helper: any = editor.helpers[object.id]

    if (helper !== undefined && helper.isSkeletonHelper !== true) {
      helper.update()
    }

    // 灯光目标改变时更新灯光辅助器

    for (const id in editor.helpers) {
      const helper: any = editor.helpers[id]

      if (helper.light && helper.light.target === object) {
        helper.update()
      }
    }

    initPT()
    render()
  })

  signals.objectRemoved.add(function (object: any) {
    // 见 #14180：仅在导演视角恢复轨道控制。
    controls.enabled = editor.viewportCamera === editor.camera

    if (object === transformControls.object) {
      transformControls.detach()
    }
  })

  signals.materialChanged.add(function () {
    updatePTMaterials()
    render()
  })

  // 背景

  signals.sceneBackgroundChanged.add(function (
    backgroundType: any,
    backgroundColor: any,
    backgroundTexture: any,
    backgroundEquirectangularTexture: any,
    backgroundColorSpace: any,
    backgroundBlurriness: any,
    backgroundIntensity: any,
    backgroundRotation: any
  ) {
    editor.backgroundType = backgroundType

    scene.background = null

    switch (backgroundType) {
      case "Color":
        scene.background = new THREE.Color(backgroundColor)

        break

      case "Texture":
        if (backgroundTexture) {
          backgroundTexture.colorSpace = backgroundColorSpace
          backgroundTexture.needsUpdate = true

          scene.background = backgroundTexture
        }

        break

      case "Equirectangular":
        if (backgroundEquirectangularTexture) {
          backgroundEquirectangularTexture.mapping =
            THREE.EquirectangularReflectionMapping
          backgroundEquirectangularTexture.colorSpace = backgroundColorSpace
          backgroundEquirectangularTexture.needsUpdate = true

          scene.background = backgroundEquirectangularTexture
          scene.backgroundBlurriness = backgroundBlurriness
          scene.backgroundIntensity = backgroundIntensity
          scene.backgroundRotation.y =
            backgroundRotation * THREE.MathUtils.DEG2RAD
        }

        break
    }

    if (useBackgroundAsEnvironment) {
      signals.sceneEnvironmentChanged.dispatch(editor.environmentType)
    }

    updatePTBackground()
    render()
  })

  // 环境

  let useBackgroundAsEnvironment = false

  signals.sceneEnvironmentChanged.add(function (
    environmentType: any,
    environmentEquirectangularTexture: any
  ) {
    editor.environmentType = environmentType

    scene.environment = null

    useBackgroundAsEnvironment = false

    switch (environmentType) {
      case "Equirectangular":
        if (environmentEquirectangularTexture) {
          scene.environment = environmentEquirectangularTexture
          ;(scene.environment as any).mapping =
            THREE.EquirectangularReflectionMapping
        }

        break

      // 与背景**无关**的中性影棚光照：一间带柔光灯板的房间烘成 PMREM。
      // 'Default' 的语义是「拿背景当光源」，故背景是一支近黑的天空色时，
      // 得到的是一个均匀且几乎为零的环境——既没有方向差（所有法线拿到同一份
      // 辐照度，物体渲染成一整块纯色、没有明暗过渡与高光）又几乎不发光。
      // 舞台类场景（导演台）要的是「背景归背景、打光归打光」，故单列一档。
      case "Room":
        // renderer 尚未创建时 pmremGenerator 还是 null；rendererCreated 会带着
        // editor.environmentType（此刻已被上面记成 'Room'）再分发一次，故这里
        // 直接跳过即可，不必让调用方去关心创建时序。
        if (pmremGenerator !== null) {
          scene.environment = pmremGenerator.fromScene(
            new RoomEnvironment(),
            0.04
          ).texture
        }

        break

      case "Default": {
        useBackgroundAsEnvironment = true

        const background: any = scene.background

        if (background !== null) {
          if (background.isColor) {
            scene.environment = pmremGenerator.fromScene(
              new ColorEnvironment(background),
              0.04
            ).texture
          } else if (background.isTexture) {
            scene.environment = background
            ;(scene.environment as any).mapping =
              THREE.EquirectangularReflectionMapping
            scene.environmentRotation.y = scene.backgroundRotation.y
          }
        } else {
          scene.environment = pmremGenerator.fromScene(
            new RoomEnvironment(),
            0.04
          ).texture
        }

        break
      }
    }

    updatePTEnvironment()
    render()
  })

  // 雾效

  signals.sceneFogChanged.add(function (
    fogType: any,
    fogColor: any,
    fogNear: any,
    fogFar: any,
    fogDensity: any
  ) {
    switch (fogType) {
      case "None":
        scene.fog = null
        break
      case "Fog":
        scene.fog = new THREE.Fog(fogColor, fogNear, fogFar)
        break
      case "FogExp2":
        scene.fog = new THREE.FogExp2(fogColor, fogDensity)
        break
    }

    render()
  })

  signals.sceneFogSettingsChanged.add(function (
    fogType: any,
    fogColor: any,
    fogNear: any,
    fogFar: any,
    fogDensity: any
  ) {
    const fog: any = scene.fog

    switch (fogType) {
      case "Fog":
        fog.color.setHex(fogColor)
        fog.near = fogNear
        fog.far = fogFar
        break
      case "FogExp2":
        fog.color.setHex(fogColor)
        fog.density = fogDensity
        break
    }

    render()
  })

  signals.viewportCameraChanged.add(function () {
    const viewportCamera: any = editor.viewportCamera

    if (
      viewportCamera.isPerspectiveCamera ||
      viewportCamera.isOrthographicCamera
    ) {
      updateAspectRatio()
    }

    // 设置用户相机时禁用 EditorControls（机位视角下不通过轨道控制器移动相机，
    // 相机本身由属性面板编辑；选中对象的变换由 TransformControls 完成）。

    controls.enabled = viewportCamera === editor.camera

    // 拾取与变换 gizmo 都以实际渲染所用的视口相机为准，这样在机位视角下
    // 也能按所见的画面选中并拖拽对象。
    transformControls.camera = viewportCamera

    initPT()
    render()
  })

  signals.viewportShadingChanged.add(function () {
    const viewportShading = editor.viewportShading

    switch (viewportShading) {
      case "realistic":
        if (pathtracer) pathtracer.init(scene, editor.viewportCamera)
        break

      case "solid":
        scene.overrideMaterial = null
        break

      case "normals":
        scene.overrideMaterial = new THREE.MeshNormalMaterial()
        break

      case "wireframe":
        scene.overrideMaterial = new THREE.MeshBasicMaterial({
          color: 0x000000,
          wireframe: true
        })
        break
    }

    render()
  })

  //

  signals.windowResize.add(function () {
    updateAspectRatio()

    if (renderer === null) return

    renderer.setSize(container.offsetWidth, container.offsetHeight)
    if (pathtracer)
      pathtracer.setSize(container.offsetWidth, container.offsetHeight)

    // 尺寸变化这一条必须**同步**重绘，不能像其它信号那样只标记 renderRequested：
    // setSize 改写 canvas 的 width/height 会把 WebGL 绘制缓冲区清空，若把重绘推到
    // 下一帧的 setAnimationLoop，本帧就会被合成成一块空白。本监听器由
    // EditorViewport 的 ResizeObserver 触发，回调时机在布局之后、绘制之前，
    // 此处补一次渲染即可让本帧直接呈现新尺寸的画面——否则连续拖拽（导演台调整
    // 时间轴/面板高度、窗口缩放）会逐帧空白，表现为视口持续闪烁。
    flushRender()
  })

  // 就地画一帧（见 Editor.ts 的 renderNow 注释）：与 windowResize 那条同样走 flushRender，
  // 只是不必改尺寸。调用方要的是「这一句返回时画面已经在 canvas 上」，故这里**不能**降级成
  // render() 的标记位——那样它取到的是上一帧甚至一块空白。
  signals.renderNow.add(function () {
    if (renderer === null) return
    flushRender()
  })

  signals.showHelpersChanged.add(function (appearanceStates: any) {
    grid.visible = appearanceStates.gridHelper

    sceneHelpers.traverse(function (object: any) {
      switch (object.type) {
        case "CameraHelper": {
          object.visible = appearanceStates.cameraHelpers
          break
        }

        case "PointLightHelper":
        case "DirectionalLightHelper":
        case "SpotLightHelper":
        case "HemisphereLightHelper": {
          object.visible = appearanceStates.lightHelpers
          break
        }

        case "SkeletonHelper": {
          object.visible = appearanceStates.skeletonHelpers
          break
        }

        default: {
          // 不是辅助器，跳过。
        }
      }
    })

    render()
  })

  signals.cameraResetted.add(function () {
    if (camera !== editor.camera) {
      camera = editor.camera

      controls.setCamera(camera)
    }

    // 无论是否回退轨道相机，变换 gizmo 始终跟随当前视口相机。
    transformControls.camera = editor.viewportCamera

    updateAspectRatio()
    render()
  })

  // 动画

  let prevActionsInUse = 0

  const timer = new THREE.Timer() // 仅用于动画

  function animate() {
    timer.update()

    const mixer = editor.mixer
    const delta = timer.getDelta()

    let needsUpdate = false

    // 动画

    const actions = mixer.stats.actions

    if (actions.inUse > 0 || prevActionsInUse > 0) {
      prevActionsInUse = actions.inUse

      mixer.update(delta)
      needsUpdate = true

      if (editor.selected !== null) {
        editor.selected.updateWorldMatrix(false, true) // 避免某些蒙皮网格（如 Michelle.glb）的帧延迟效果
        // 选中框应反映当前动画状态，但**不在这里当场精确重算**：那是一次
        // 逐顶点蒙皮，且下方 flushRender 本就会再算一遍（同一帧算两次）。
        // 与 sceneAnimated 那条走同一条路——本帧廉价、停下后补精确。
        selectionBoxNeedsUpdate = true
        selectionBoxAnimating = true
      }

      signals.morphTargetsUpdated.dispatch()
    }

    if (renderer.xr.isPresenting === true) {
      needsUpdate = true
    }

    if (needsUpdate === true) renderRequested = true

    // 动画停下后的第一帧补一次精确包围盒：播放/拖播放头期间用的是廉价盒
    // （见 flushRender），停下来才把选中框收紧到真实轮廓上。判据是「这一帧
    // 没有再收到动画写回」，故不依赖时间轴那边有没有补派 objectChanged。
    if (selectionBoxAnimating === false && selectionBoxPreciseDirty === true) {
      selectionBoxPreciseDirty = false
      selectionBoxNeedsUpdate = true
      renderRequested = true
    }

    // 合并本帧内所有 render() 请求为一次真正渲染。选中框的（可能昂贵的）
    // 精确包围盒重算同样合并到此处，紧贴渲染前执行一次。
    if (renderRequested === true) flushRender()

    // 动画标记逐帧消费：本帧之后再来的 sceneAnimated 属于下一帧。
    selectionBoxAnimating = false

    updatePT()
  }

  // 兑现待渲染标记：消费 renderRequested，补齐紧贴渲染前的一次选中框重算，
  // 再真正绘制一帧。由 animate() 每帧调用，windowResize 亦直接调用（见那里的说明）。
  function flushRender() {
    renderRequested = false

    if (selectionBoxNeedsUpdate === true) {
      selectionBoxNeedsUpdate = false
      const selected: any = editor.selected
      if (selected !== null && selected !== scene && selected !== camera) {
        // 精确模式只留给「静止且没在拖」的那一次：拖拽与逐帧动画都用廉价盒，
        // 差额（蒙皮变形后的真实轮廓）在手松开/动画停下后的那一帧补回来。
        const precise = !transformControls.dragging && !selectionBoxAnimating
        box.setFromObject(selected, precise)
        if (!precise) selectionBoxPreciseDirty = true
      }
    }

    performRender()
  }

  function initPT() {
    if (pathtracer && editor.viewportShading === "realistic") {
      pathtracer.init(scene, editor.viewportCamera)
    }
  }

  function updatePTBackground() {
    if (pathtracer && editor.viewportShading === "realistic") {
      pathtracer.setBackground(scene.background, scene.backgroundBlurriness)
    }
  }

  function updatePTEnvironment() {
    if (pathtracer && editor.viewportShading === "realistic") {
      pathtracer.setEnvironment(scene.environment)
    }
  }

  function updatePTMaterials() {
    if (pathtracer && editor.viewportShading === "realistic") {
      pathtracer.updateMaterials()
    }
  }

  function updatePT() {
    if (pathtracer && editor.viewportShading === "realistic") {
      pathtracer.update()
      editor.signals.pathTracerUpdated.dispatch(pathtracer.getSamples())
    }
  }

  //

  let startTime = 0
  let endTime = 0

  // render() 曾在每个触发信号里同步执行完整渲染（含 container.offsetWidth
  // 强制布局读取）。轨道控制器的 change 事件随每个 pointermove 同步派发
  // （可达 120–250Hz，高于显示刷新率），姿势滑块等一次交互也常在同一帧内
  // 级联派发多个会触发 render() 的信号——同一帧内多次完整渲染是视口交互
  // 卡顿的直接来源。render() 因此降级为"标记待渲染"，由常驻的
  // setAnimationLoop（见 animate()）每帧最多真正渲染一次；对既有调用方
  // 语义不变（下一帧必然重绘），仅去掉了帧内重复。
  function render() {
    renderRequested = true
  }

  function performRender() {
    if (renderer === null) return

    startTime = performance.now()

    renderer.setViewport(0, 0, container.offsetWidth, container.offsetHeight)
    // `scene` 先渲染（而非 `backdrop`），因为使用平面 THREE.Color
    // 背景时，Three.js 在渲染带颜色背景的场景时会强制清除缓冲区，
    // 无论 autoClear 如何设置，所以在此处先于 scene 渲染的任何内容
    // 都会在 scene 渲染瞬间被清除。随后在关闭 autoClear 的情况下
    // 渲染 backdrop，使其能在未被其他内容覆盖之处绘制在该背景填充上，
    // 同时仍会在深度测试中输给更近的真实场景几何体。
    renderer.render(scene, editor.viewportCamera)

    renderer.autoClear = false

    // 全景球（editor.backdrop 中的网格）默认半径 30，且不随场景缩放/平移
    // 变换——它是固定的地平线背景。机位相机的 far（DIRECTOR_SHOT_FAR=2000）
    // 足够覆盖全景球（半径可达 500），全景始终落在视锥内，以视口相机直接
    // 渲染即可保留平移视差，与导演视角行为一致。
    renderer.render(backdrop, editor.viewportCamera)

    // 地面网格（grid 线 + 地面平面）属于舞台布置，而非纯编辑器辅助器，
    // 在机位视角下也应透过机位相机可见——并且地面平面的半透明填充需在
    // backdrop（全景）之后渲染，才能与全景像素正确混合（见上方注释）。
    // 因此用视口相机渲染 grid，独立于仅限编辑器相机的辅助器守卫。
    if (grid.visible === true) renderer.render(grid, editor.viewportCamera)

    // 编辑器辅助器仅在导演视角下显示，不进入机位画面。
    if (editor.viewportCamera === editor.camera) {
      if (sceneHelpers.visible === true)
        renderer.render(sceneHelpers, editor.viewportCamera)
    } else {
      // 机位视角：只渲染标记为「编辑必需」的辅助器——变换 gizmo 与姿势编辑
      // 叠加层（骨架线/关节手柄/关节 gizmo），使对象与姿势都能在机位画面中
      // 直接编辑；相机视锥、灯光辅助器等纯编辑器元素仍不进镜头。
      // 标记与逐帧隐藏/恢复的实现见 shotViewHelpers.ts。
      renderShotViewHelpers(renderer, sceneHelpers, editor.viewportCamera)
    }
    renderer.autoClear = true

    endTime = performance.now()
    editor.signals.sceneRendered.dispatch(endTime - startTime)
  }

  return container
}

function updateGridColors(
  grid1: any,
  grid2: any,
  colors: any,
  gridPlane: any,
  planeColor: any
) {
  grid1.material.color.setHex(colors[0])
  grid2.material.color.setHex(colors[1])
  if (gridPlane && planeColor !== undefined)
    gridPlane.material.color.setHex(planeColor)
}

export { Viewport }
