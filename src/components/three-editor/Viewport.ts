
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

    controls.enabled = true
  })

  sceneHelpers.add(transformControls.getHelper())

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
      const intersects = selector.getPointerIntersects(onUpPosition, camera)
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
      camera
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
    controls.enabled = true // 见 #14180

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

    // 设置用户相机时禁用 EditorControls

    controls.enabled = viewportCamera === editor.camera

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
      transformControls.camera = camera
      viewHelper.camera = camera
    }

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
    renderer.render(backdrop, editor.viewportCamera)

    if (camera === editor.viewportCamera) {
      if (grid.visible === true) renderer.render(grid, camera)
      if (sceneHelpers.visible === true) renderer.render(sceneHelpers, camera)
      if (renderer.xr.isPresenting !== true) viewHelper.render(renderer)
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
