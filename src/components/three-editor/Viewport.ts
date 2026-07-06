// @ts-nocheck
import * as THREE from "three"
import { PMREMGenerator } from "three/webgpu"

import { TransformControls } from "three/addons/controls/TransformControls.js"

import { EditorControls } from "./EditorControls"

import { ViewHelper } from "./Viewport.ViewHelper"
import { XR } from "./Viewport.XR"

import { SetPositionCommand } from "./commands/SetPositionCommand"
import { SetRotationCommand } from "./commands/SetRotationCommand"
import { SetScaleCommand } from "./commands/SetScaleCommand"

import { ColorEnvironment } from "three/addons/environments/ColorEnvironment.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { ViewportPathtracer } from "./Viewport.Pathtracer"

function Viewport(editor) {
  const selector = editor.selector
  const signals = editor.signals

  const container = document.createElement("div")
  container.id = "viewport"
  container.style.position = "absolute"

  //

  let renderer = null
  let pmremGenerator = null
  let pathtracer = null

  let camera = editor.camera
  const scene = editor.scene
  const sceneHelpers = editor.sceneHelpers

  // Rendered right after `scene` but before `grid`/`sceneHelpers` (see
  // render() below), so that anything drawn here is real background color
  // already sitting in the buffer by the time the ground plane's
  // translucent fill blends on top of it. Kept as its own scene rather than
  // living in sceneHelpers so it can render ahead of grid/gizmos without
  // them jumping the queue with it. Owned by Editor (see Editor.ts) so it
  // exists before this Viewport is ever constructed.
  const backdrop = editor.backdrop

  // helpers

  const GRID_COLORS_LIGHT = [0x999999, 0x777777]
  const GRID_COLORS_DARK = [0x555555, 0x888888]
  const GRID_PLANE_COLOR_LIGHT = 0x3b82f6
  const GRID_PLANE_COLOR_DARK = 0x60a5fa

  // Owned by Editor (see Editor.ts), not constructed here, for the same
  // reason as `backdrop` above.
  const grid = editor.grid
  const [grid1, grid2] = grid.children
  const gridPlane = editor.groundPlane

  const viewHelper = new ViewHelper(camera, container)

  //

  const box = new THREE.Box3()

  const selectionBox = new THREE.Box3Helper(box)
  selectionBox.material.depthTest = false
  selectionBox.material.transparent = true
  selectionBox.visible = false
  sceneHelpers.add(selectionBox)

  let objectPositionOnDown = null
  let objectRotationOnDown = null
  let objectScaleOnDown = null

  const transformControls = new TransformControls(camera)
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
          if (!objectPositionOnDown.equals(object.position)) {
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
          if (!objectRotationOnDown.equals(object.rotation)) {
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
          if (!objectScaleOnDown.equals(object.scale)) {
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

      // Drag frames used the cheap (non-precise) box for performance; true
      // up to a precise box now that dragging has stopped.
      if (editor.selected === object) {
        box.setFromObject(object, true)
      }
    }

    controls.enabled = true
  })

  sceneHelpers.add(transformControls.getHelper())

  //

  const xr = new XR(editor, transformControls) // eslint-disable-line no-unused-vars

  // events

  function updateAspectRatio() {
    for (const uuid in editor.cameras) {
      const camera = editor.cameras[uuid]

      const aspect = container.offsetWidth / container.offsetHeight

      if (camera.isPerspectiveCamera) {
        camera.aspect = aspect
      } else {
        const frustumHeight = camera.top - camera.bottom

        camera.left = (-frustumHeight * aspect) / 2
        camera.right = (frustumHeight * aspect) / 2
      }

      camera.updateProjectionMatrix()

      const cameraHelper = editor.helpers[camera.id]
      if (cameraHelper) cameraHelper.update()
    }
  }

  const onDownPosition = new THREE.Vector2()
  const onUpPosition = new THREE.Vector2()
  const onDoubleClickPosition = new THREE.Vector2()

  function getMousePosition(dom, x, y) {
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

  function onMouseDown(event) {
    // event.preventDefault();

    if (event.target !== renderer.domElement) return

    const array = getMousePosition(container, event.clientX, event.clientY)
    onDownPosition.fromArray(array)

    document.addEventListener("mouseup", onMouseUp)
  }

  function onMouseUp(event) {
    const array = getMousePosition(container, event.clientX, event.clientY)
    onUpPosition.fromArray(array)

    handleClick()

    document.removeEventListener("mouseup", onMouseUp)
  }

  function onTouchStart(event) {
    const touch = event.changedTouches[0]

    const array = getMousePosition(container, touch.clientX, touch.clientY)
    onDownPosition.fromArray(array)

    document.addEventListener("touchend", onTouchEnd)
  }

  function onTouchEnd(event) {
    const touch = event.changedTouches[0]

    const array = getMousePosition(container, touch.clientX, touch.clientY)
    onUpPosition.fromArray(array)

    handleClick()

    document.removeEventListener("touchend", onTouchEnd)
  }

  function onDoubleClick(event) {
    const array = getMousePosition(container, event.clientX, event.clientY)
    onDoubleClickPosition.fromArray(array)

    const intersects = selector.getPointerIntersects(
      onDoubleClickPosition,
      camera
    )

    if (intersects.length > 0) {
      const intersect = intersects[0]

      signals.objectFocused.dispatch(intersect.object)
    }
  }

  container.addEventListener("mousedown", onMouseDown)
  container.addEventListener("touchstart", onTouchStart, { passive: false })
  container.addEventListener("dblclick", onDoubleClick)

  // controls need to be added *after* main logic,
  // otherwise controls.enabled doesn't work.

  const controls = new EditorControls(camera)
  controls.addEventListener("change", function () {
    signals.cameraChanged.dispatch(camera)
    signals.refreshSidebarObject3D.dispatch(camera)
  })
  viewHelper.center = controls.center

  editor.controls = controls

  // signals

  signals.editorCleared.add(function () {
    controls.center.set(0, 0, 0)
    if (pathtracer) pathtracer.reset()

    initPT()

    signals.sceneEnvironmentChanged.dispatch(editor.environmentType)
  })

  signals.transformModeChanged.add(function (mode) {
    transformControls.setMode(mode)

    render()
  })

  signals.snapChanged.add(function (dist) {
    transformControls.setTranslationSnap(dist)
  })

  signals.spaceChanged.add(function (space) {
    transformControls.setSpace(space)

    render()
  })

  signals.rendererUpdated.add(function () {
    scene.traverse(function (child) {
      if (child.material !== undefined) {
        child.material.needsUpdate = true
      }
    })

    render()
  })

  signals.rendererCreated.add(function (newRenderer) {
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

      pathtracer = new ViewportPathtracer(renderer)
    } else {
      pmremGenerator = new PMREMGenerator(renderer)

      pathtracer = null
    }

    container.appendChild(renderer.domElement)

    signals.sceneEnvironmentChanged.dispatch(editor.environmentType)

    render()
  })

  signals.rendererDetectKTX2Support.add(function (ktx2Loader) {
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

  signals.objectSelected.add(function (object) {
    selectionBox.visible = false
    transformControls.detach()

    if (object !== null && object !== scene && object !== camera) {
      box.setFromObject(object, true)

      if (box.isEmpty() === false) {
        selectionBox.visible = true
      }

      transformControls.attach(object)

      // Bones only support rotation in this editor: translating/scaling a
      // bone would offset it from its parent and break the joint connection.
      if (object.isBone && transformControls.mode !== "rotate") {
        signals.transformModeChanged.dispatch("rotate")
      }
    }

    render()
  })

  signals.objectFocused.add(function (object) {
    controls.focus(object)
  })

  signals.geometryChanged.add(function (object) {
    if (object !== undefined) {
      box.setFromObject(object, true)
    }

    initPT()
    render()
  })

  signals.objectChanged.add(function (object) {
    if (editor.selected === object) {
      // Precise mode walks and transforms every vertex of every mesh in the
      // subtree, which for a skinned character (many bones + a dense mesh)
      // is expensive enough to visibly stutter a translate drag when redone
      // on every pointer-move. Fall back to the cheap (cached bounding box)
      // pass while actively dragging and only pay for a precise box once
      // the drag settles.
      box.setFromObject(object, !transformControls.dragging)
    }

    if (object.isPerspectiveCamera) {
      object.updateProjectionMatrix()
    }

    const helper = editor.helpers[object.id]

    if (helper !== undefined && helper.isSkeletonHelper !== true) {
      helper.update()
    }

    // update light helper when light target is changed

    for (const id in editor.helpers) {
      const helper = editor.helpers[id]

      if (helper.light && helper.light.target === object) {
        helper.update()
      }
    }

    initPT()
    render()
  })

  signals.objectRemoved.add(function (object) {
    controls.enabled = true // see #14180

    if (object === transformControls.object) {
      transformControls.detach()
    }
  })

  signals.materialChanged.add(function () {
    updatePTMaterials()
    render()
  })

  // background

  signals.sceneBackgroundChanged.add(
    function (
      backgroundType,
      backgroundColor,
      backgroundTexture,
      backgroundEquirectangularTexture,
      backgroundColorSpace,
      backgroundBlurriness,
      backgroundIntensity,
      backgroundRotation
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

  // environment

  let useBackgroundAsEnvironment = false

  signals.sceneEnvironmentChanged.add(
    function (environmentType, environmentEquirectangularTexture) {
      editor.environmentType = environmentType

      scene.environment = null

      useBackgroundAsEnvironment = false

      switch (environmentType) {
        case "Equirectangular":
          if (environmentEquirectangularTexture) {
            scene.environment = environmentEquirectangularTexture
            scene.environment.mapping = THREE.EquirectangularReflectionMapping
          }

          break

        case "Default":
          useBackgroundAsEnvironment = true

          if (scene.background !== null) {
            if (scene.background.isColor) {
              scene.environment = pmremGenerator.fromScene(
                new ColorEnvironment(scene.background),
                0.04
              ).texture
            } else if (scene.background.isTexture) {
              scene.environment = scene.background
              scene.environment.mapping = THREE.EquirectangularReflectionMapping
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

      updatePTEnvironment()
      render()
    }
  )

  // fog

  signals.sceneFogChanged.add(
    function (fogType, fogColor, fogNear, fogFar, fogDensity) {
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
    function (fogType, fogColor, fogNear, fogFar, fogDensity) {
      switch (fogType) {
        case "Fog":
          scene.fog.color.setHex(fogColor)
          scene.fog.near = fogNear
          scene.fog.far = fogFar
          break
        case "FogExp2":
          scene.fog.color.setHex(fogColor)
          scene.fog.density = fogDensity
          break
      }

      render()
    }
  )

  signals.viewportCameraChanged.add(function () {
    const viewportCamera = editor.viewportCamera

    if (
      viewportCamera.isPerspectiveCamera ||
      viewportCamera.isOrthographicCamera
    ) {
      updateAspectRatio()
    }

    // disable EditorControls when setting a user camera

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

  signals.showHelpersChanged.add(function (appearanceStates) {
    grid.visible = appearanceStates.gridHelper

    sceneHelpers.traverse(function (object) {
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
          // not a helper, skip.
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

  // animations

  let prevActionsInUse = 0

  const timer = new THREE.Timer() // only used for animations

  function animate() {
    timer.update()

    const mixer = editor.mixer
    const delta = timer.getDelta()

    let needsUpdate = false

    // Animations

    const actions = mixer.stats.actions

    if (actions.inUse > 0 || prevActionsInUse > 0) {
      prevActionsInUse = actions.inUse

      mixer.update(delta)
      needsUpdate = true

      if (editor.selected !== null) {
        editor.selected.updateWorldMatrix(false, true) // avoid frame late effect for certain skinned meshes (e.g. Michelle.glb)
        selectionBox.box.setFromObject(editor.selected, true) // selection box should reflect current animation state
      }

      signals.morphTargetsUpdated.dispatch()
    }

    // View Helper

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
    // `scene` goes first (not `backdrop`) because a flat THREE.Color
    // background makes Three.js force-clear the buffer whenever it renders
    // a scene with a Color background, regardless of autoClear, so anything
    // rendered *before* scene here would get wiped out the instant scene
    // renders. Rendering backdrop right after, with autoClear off, lets it
    // paint over that background fill wherever nothing else already drew,
    // while still losing the depth test to real scene geometry that's
    // nearer than it.
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

function updateGridColors(grid1, grid2, colors, gridPlane, planeColor) {
  grid1.material.color.setHex(colors[0])
  grid2.material.color.setHex(colors[1])
  if (gridPlane && planeColor !== undefined)
    gridPlane.material.color.setHex(planeColor)
}

export { Viewport }
