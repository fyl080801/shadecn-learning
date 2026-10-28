
import * as THREE from "three"
import { PMREMGenerator } from "three/webgpu"

import { TransformControls } from "three/addons/controls/TransformControls.js"

import { EditorControls } from "./EditorControls"

import { ViewHelper, type ViewHelperOffset } from "./Viewport.ViewHelper"
import { XR } from "./Viewport.XR"

import { SetPositionCommand } from "./commands/SetPositionCommand"
import { SetRotationCommand } from "./commands/SetRotationCommand"
import { SetScaleCommand } from "./commands/SetScaleCommand"

import { ColorEnvironment } from "three/addons/environments/ColorEnvironment.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { ViewportPathtracer } from "./Viewport.Pathtracer"
import type { Editor } from "./Editor"

function Viewport(
  editor: Editor,
  options?: { viewHelperOffset?: ViewHelperOffset }
): HTMLDivElement {
  const selector = editor.selector
  const signals = editor.signals

  const container = document.createElement("div")
  container.id = "viewport"
  container.style.position = "absolute"

  //

  let renderer: any = null
  let pmremGenerator: any = null
  let pathtracer: any = null

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

  const viewHelper = new ViewHelper(camera, container, options?.viewHelperOffset)

  //

  const box = new THREE.Box3()

  // 全景 backdrop 在机位视角下重对齐到相机时使用的临时量（见 render()）。
  const _backdropVec = new THREE.Vector3()
  const _backdropPrevPos = new THREE.Vector3()
  const _backdropPrevScale = new THREE.Vector3()

  const selectionBox: any = new THREE.Box3Helper(box)
  selectionBox.material.depthTest = false
  selectionBox.material.transparent = true
  selectionBox.visible = false

  let objectPositionOnDown: THREE.Vector3 | null = null
  let objectRotationOnDown: THREE.Euler | null = null
  let objectScaleOnDown: THREE.Vector3 | null = null

  const transformControls: any = new TransformControls(camera)
  transformControls.addEventListener("axis-changed", function () {
    if (editor.viewportShading !== "realistic") render()
  })
  transformControls.addEventListener("objectChange", function () {
    signals.objectChanged.dispatch(transformControls.object)
  })
  transformControls.addEventListener("mouseDown", function () {
    const object = transformControls.object

    objectPositionOnDown = object.position.clone()
    objectRotationOnDown = object.rotation.clone()
    objectScaleOnDown = object.scale.clone()

    controls.enabled = false
  })
  transformControls.addEventListener("mouseUp", function () {
    const object = transformControls.object

    if (object !== undefined) {
      switch (transformControls.getMode()) {
        case "translate":
          if (!objectPositionOnDown!.equals(object.position)) {
            editor.execute(
              new SetPositionCommand(
                editor,
                object,
                object.position,
                objectPositionOnDown
              )
            )
          }

          break

        case "rotate":
          if (!objectRotationOnDown!.equals(object.rotation)) {
            editor.execute(
              new SetRotationCommand(
                editor,
                object,
                object.rotation,
                objectRotationOnDown
              )
            )
          }

          break

        case "scale":
          if (!objectScaleOnDown!.equals(object.scale)) {
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
      }
    }

    // 仅在导演视角恢复轨道控制；机位视角下轨道控制器始终关闭。
    controls.enabled = editor.viewportCamera === editor.camera
  })

  // 变换 gizmo：在导演视角随 sceneHelpers 一同渲染；机位视角下单独渲染
  // （见 render()），使机位视角也能选中并拖拽编辑对象。
  const transformHelper = transformControls.getHelper()
  sceneHelpers.add(transformHelper)

  //

  new XR(editor, transformControls)

  // 事件

  function updateAspectRatio() {
    for (const uuid in editor.cameras) {
      const camera: any = editor.cameras[uuid]

      const aspect = container.offsetWidth / container.offsetHeight

      if (camera.isPerspectiveCamera) {
        camera.aspect = aspect
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

      signals.objectFocused.dispatch(intersect.object)
    }
  }

  container.addEventListener("mousedown", onMouseDown)
  container.addEventListener("touchstart", onTouchStart, { passive: false })
  container.addEventListener("dblclick", onDoubleClick)

  // 控制器需要在主逻辑*之后*添加，
  // 否则 controls.enabled 不起作用。

  const controls = new EditorControls(camera)
  controls.addEventListener("change", function () {
    signals.cameraChanged.dispatch(camera)
    signals.refreshSidebarObject3D.dispatch(camera)
  })
  viewHelper.center = controls.center

  editor.controls = controls

  // 信号

  signals.editorCleared.add(function () {
    controls.center.set(0, 0, 0)
    if (pathtracer) pathtracer.reset()

    initPT()

    signals.sceneEnvironmentChanged.dispatch(editor.environmentType)
  })

  signals.transformModeChanged.add(function (mode: any) {
    transformControls.setMode(mode)

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

    render()
  })

  signals.objectFocused.add(function (object: any) {
    controls.focus(object)
  })

  signals.geometryChanged.add(function (object: any) {
    if (object !== undefined) {
      box.setFromObject(object, true)
    }

    initPT()
    render()
  })

  signals.objectChanged.add(function (object: any) {
    if (editor.selected === object) {
      // 精确模式会遍历并变换子树中每个网格的每个顶点，对于蒙皮角色
      // （大量骨骼 + 密集网格）来说，在每个 pointer-move 上重复执行
      // 会导致明显的拖拽卡顿。拖拽进行时回退到廉价（缓存包围盒）
      // 方式，仅在拖拽结束后才计算精确包围盒。
      box.setFromObject(object, !transformControls.dragging)
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

  signals.sceneBackgroundChanged.add(
    function (
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
    }
  )

  // 环境

  let useBackgroundAsEnvironment = false

  signals.sceneEnvironmentChanged.add(
    function (environmentType: any, environmentEquirectangularTexture: any) {
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
    }
  )

  // 雾效

  signals.sceneFogChanged.add(
    function (fogType: any, fogColor: any, fogNear: any, fogFar: any, fogDensity: any) {
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
    }
  )

  signals.sceneFogSettingsChanged.add(
    function (fogType: any, fogColor: any, fogNear: any, fogFar: any, fogDensity: any) {
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
    }
  )

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

    render()
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
      viewHelper.camera = camera
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
        selectionBox.box.setFromObject(editor.selected, true) // 选中框应反映当前动画状态
      }

      signals.morphTargetsUpdated.dispatch()
    }

    // 视图辅助器

    if (viewHelper.animating === true) {
      viewHelper.update(delta)
      needsUpdate = true
    }

    if (renderer.xr.isPresenting === true) {
      needsUpdate = true
    }

    if (needsUpdate === true) render()

    updatePT()
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

  function render() {
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
    // 变换——它是固定的地平线背景。导演视角下编辑器轨道相机 far 足够大
    // （见 Editor.ts 的 _DEFAULT_CAMERA，far=1e10），可直接用视口相机渲染，
    // 并保留相机平移带来的真实视差。
    //
    // 但机位视角下用户相机的 far 被刻意调小（见 DirectorToolbar 的
    // addCameraWithModel，为缩短 CameraHelper 视锥线而设为 15），半径 30 的
    // 全景球已落在 far 平面之外被整体裁剪，因此看不到贴图。这里在机位
    // 视角下临时把 backdrop 平移到相机位置并缩放至恰好落入视锥内再渲染，
    // 随后还原——等价于让全景球作为 skybox 跟随相机。仍以同一相机（同一
    // near/far 投影）渲染，深度与场景几何体保持同一尺度，全景仍被近处
    // 几何体正确遮挡；仅损失机位视角下的视差（对远场地平线可忽略）。
    const viewportCamera: any = editor.viewportCamera
    if (viewportCamera !== editor.camera) {
      let panoramaRadius = 0
      backdrop.traverse(function (child: any) {
        if (child.isMesh && child.visible && child.geometry) {
          if (child.geometry.boundingSphere === null)
            child.geometry.computeBoundingSphere()
          const r = child.geometry.boundingSphere?.radius ?? 0
          if (r > panoramaRadius) panoramaRadius = r
        }
      })
      if (
        panoramaRadius > 0 &&
        viewportCamera.far > viewportCamera.near
      ) {
        viewportCamera.getWorldPosition(_backdropVec)
        _backdropPrevPos.copy(backdrop.position)
        _backdropPrevScale.copy(backdrop.scale)
        backdrop.position.copy(_backdropVec)
        backdrop.scale.setScalar(
          (viewportCamera.far * 0.9) / panoramaRadius
        )
        renderer.render(backdrop, viewportCamera)
        backdrop.position.copy(_backdropPrevPos)
        backdrop.scale.copy(_backdropPrevScale)
      } else {
        renderer.render(backdrop, viewportCamera)
      }
    } else {
      renderer.render(backdrop, editor.viewportCamera)
    }

    // 地面网格（grid 线 + 地面平面）属于舞台布置，而非纯编辑器辅助器，
    // 在机位视角下也应透过机位相机可见——并且地面平面的半透明填充需在
    // backdrop（全景）之后渲染，才能与全景像素正确混合（见上方注释）。
    // 因此用视口相机渲染 grid，独立于仅限编辑器相机的辅助器守卫。
    if (grid.visible === true) renderer.render(grid, editor.viewportCamera)

    // 编辑器辅助器与 viewHelper（轴向罗盘）仅在导演视角下显示，不进入机位画面。
    if (editor.viewportCamera === editor.camera) {
      if (sceneHelpers.visible === true)
        renderer.render(sceneHelpers, editor.viewportCamera)
      if (renderer.xr.isPresenting !== true) viewHelper.render(renderer)
    } else {
      // 机位视角：仅渲染变换 gizmo（随 sceneHelpers 之外单独渲染），
      // 使选中对象可在机位画面中拖拽编辑，而不带入相机/灯光/骨架等编辑器辅助器。
      if (transformHelper.visible === true)
        renderer.render(transformHelper, editor.viewportCamera)
    }
    renderer.autoClear = true

    endTime = performance.now()
    editor.signals.sceneRendered.dispatch(endTime - startTime)
  }

  return container
}

function updateGridColors(grid1: any, grid2: any, colors: any, gridPlane: any, planeColor: any) {
  grid1.material.color.setHex(colors[0])
  grid2.material.color.setHex(colors[1])
  if (gridPlane && planeColor !== undefined)
    gridPlane.material.color.setHex(planeColor)
}

export { Viewport }
