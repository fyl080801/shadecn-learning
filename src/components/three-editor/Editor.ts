import * as THREE from "three"
import signals, { Signal } from "signals"

import { Config, type ConfigApi } from "./Config"
import { Loader } from "./Loader"
import { History as _History } from "./History"
import { Strings, type StringsApi } from "./Strings"
import { Storage as _Storage, type StorageApi } from "./Storage"
import { Selector } from "./Selector"
import type { Command } from "./Command"
import type { EditorControls } from "./EditorControls"

type EditorCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

interface EditorSignals {
  editScript: Signal
  startPlayer: Signal
  stopPlayer: Signal
  enterXR: Signal
  offerXR: Signal
  leaveXR: Signal
  editorCleared: Signal
  savingStarted: Signal
  savingFinished: Signal
  transformModeChanged: Signal
  snapChanged: Signal
  spaceChanged: Signal
  rendererCreated: Signal
  rendererUpdated: Signal
  rendererDetectKTX2Support: Signal
  sceneBackgroundChanged: Signal
  sceneEnvironmentChanged: Signal
  sceneFogChanged: Signal
  sceneFogSettingsChanged: Signal
  sceneGraphChanged: Signal
  sceneRendered: Signal
  cameraChanged: Signal
  cameraResetted: Signal
  geometryChanged: Signal
  objectSelected: Signal
  objectFocused: Signal
  objectAdded: Signal
  objectChanged: Signal
  objectRemoved: Signal
  cameraAdded: Signal
  cameraRemoved: Signal
  helperAdded: Signal
  helperRemoved: Signal
  materialAdded: Signal
  materialChanged: Signal
  materialRemoved: Signal
  scriptAdded: Signal
  scriptChanged: Signal
  scriptRemoved: Signal
  windowResize: Signal
  showHelpersChanged: Signal
  refreshSidebarObject3D: Signal
  historyChanged: Signal
  viewportCameraChanged: Signal
  viewportShadingChanged: Signal
  intersectionsDetected: Signal
  pathTracerUpdated: Signal
  animationPanelChanged: Signal
  morphTargetsUpdated: Signal
}

interface Editor {
  signals: EditorSignals
  config: ConfigApi
  history: _History
  selector: Selector
  storage: StorageApi
  strings: StringsApi
  loader: Loader

  camera: EditorCamera
  scene: THREE.Scene
  sceneHelpers: THREE.Scene
  backdrop: THREE.Scene
  grid: THREE.Group
  groundPlane: THREE.Mesh

  backgroundType: string
  environmentType: string

  object: Record<string, any>
  geometries: Record<string, THREE.BufferGeometry>
  materials: Record<string, THREE.Material>
  textures: Record<string, THREE.Texture>
  scripts: Record<string, any[]>
  animations: Record<string, any>

  materialsRefCounter: Map<THREE.Material, number>

  mixer: THREE.AnimationMixer

  selected: THREE.Object3D | null
  helpers: Record<string, THREE.Object3D>

  cameras: Record<string, THREE.Object3D>

  viewportCamera: THREE.Object3D
  viewportShading: string
  viewportColor: THREE.Color

  controls?: EditorControls

  setScene(scene: THREE.Scene): void
  addObject(
    object: THREE.Object3D,
    parent?: THREE.Object3D,
    index?: number
  ): void
  nameObject(object: THREE.Object3D, name: string): void
  removeObject(object: THREE.Object3D): void
  addGeometry(geometry: THREE.BufferGeometry): void
  setGeometryName(geometry: THREE.BufferGeometry, name: string): void
  addMaterial(material: THREE.Material | THREE.Material[]): void
  addMaterialToRefCounter(material: THREE.Material): void
  removeMaterial(material: THREE.Material | THREE.Material[]): void
  removeMaterialFromRefCounter(material: THREE.Material): void
  getMaterialById(id: number): THREE.Material | undefined
  setMaterialName(material: THREE.Material, name: string): void
  addTexture(texture: THREE.Texture): void
  addCamera(camera: THREE.Object3D): void
  removeCamera(camera: THREE.Object3D): void
  addHelper(object: THREE.Object3D, helper?: THREE.Object3D): void
  removeHelper(object: THREE.Object3D): void
  addScript(object: THREE.Object3D, script: any): void
  removeScript(object: THREE.Object3D, script: any): void
  getObjectMaterial(object: any, slot?: number): any
  setObjectMaterial(
    object: any,
    slot: number | undefined,
    newMaterial: any
  ): void
  setCameraType(type: string): void
  setViewportCamera(uuid: string): void
  setViewportShading(value: string): void
  select(object: THREE.Object3D | null): void
  selectById(id: number): void
  selectByUuid(uuid: string): void
  deselect(): void
  focus(object?: THREE.Object3D): void
  focusById(id: number): void
  clear(): void
  fromJSON(json: any): Promise<void>
  toJSON(): any
  objectByUuid(uuid: string): THREE.Object3D | null
  execute(cmd: Command, optionalName?: string): void
  undo(): void
  redo(): void

  utils: {
    save: (blob: Blob, filename?: string) => void
    saveArrayBuffer: (buffer: ArrayBuffer, filename?: string) => void
    saveString: (text: string, filename?: string) => void
    formatNumber: (number: number) => string
  }
}

const _DEFAULT_CAMERA = new THREE.PerspectiveCamera(50, 1, 0.001, 1e10)
_DEFAULT_CAMERA.name = "Camera"
_DEFAULT_CAMERA.position.set(0, 5, 10)
_DEFAULT_CAMERA.lookAt(new THREE.Vector3())
const _ORTHOGRAPHIC_FRUSTUM_SIZE = 100

function Editor(this: Editor, namespace?: string) {
  const Signal = signals.Signal

  this.signals = {
    // 脚本

    editScript: new Signal(),

    // 播放器

    startPlayer: new Signal(),
    stopPlayer: new Signal(),

    // XR

    enterXR: new Signal(),
    offerXR: new Signal(),
    leaveXR: new Signal(),

    // 通知

    editorCleared: new Signal(),

    savingStarted: new Signal(),
    savingFinished: new Signal(),

    transformModeChanged: new Signal(),
    snapChanged: new Signal(),
    spaceChanged: new Signal(),
    rendererCreated: new Signal(),
    rendererUpdated: new Signal(),
    rendererDetectKTX2Support: new Signal(),

    sceneBackgroundChanged: new Signal(),
    sceneEnvironmentChanged: new Signal(),
    sceneFogChanged: new Signal(),
    sceneFogSettingsChanged: new Signal(),
    sceneGraphChanged: new Signal(),
    sceneRendered: new Signal(),

    cameraChanged: new Signal(),
    cameraResetted: new Signal(),

    geometryChanged: new Signal(),

    objectSelected: new Signal(),
    objectFocused: new Signal(),

    objectAdded: new Signal(),
    objectChanged: new Signal(),
    objectRemoved: new Signal(),

    cameraAdded: new Signal(),
    cameraRemoved: new Signal(),

    helperAdded: new Signal(),
    helperRemoved: new Signal(),

    materialAdded: new Signal(),
    materialChanged: new Signal(),
    materialRemoved: new Signal(),

    scriptAdded: new Signal(),
    scriptChanged: new Signal(),
    scriptRemoved: new Signal(),

    windowResize: new Signal(),

    showHelpersChanged: new Signal(),
    refreshSidebarObject3D: new Signal(),
    historyChanged: new Signal(),

    viewportCameraChanged: new Signal(),
    viewportShadingChanged: new Signal(),

    intersectionsDetected: new Signal(),

    pathTracerUpdated: new Signal(),

    animationPanelChanged: new Signal(),

    morphTargetsUpdated: new Signal()
  }

  this.config = Config(namespace)
  this.history = new _History(this)
  this.selector = new Selector(this)
  this.storage = _Storage(namespace)
  this.strings = Strings(this.config)

  this.loader = new (Loader as unknown as new (editor: Editor) => Loader)(this)

  this.camera = _DEFAULT_CAMERA.clone()

  this.scene = new THREE.Scene()
  this.scene.name = "Scene"

  this.sceneHelpers = new THREE.Scene()
  this.sceneHelpers.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2))

  // 一个同级场景，由 Viewport 在自己的渲染通道中以相同相机渲染。
  // 添加到这里的任何内容（如固定的背景网格）都会获得普通的
  // 相机相关视差/缩放，不像 `scene.background`，Three.js 会将其
  // 渲染在无限远处，且仅随相机*旋转*重新定向。
  // 保留在 `scene` 之外，使其不受 scene.scale/position/rotation 影响，
  // 同时保留在 `sceneHelpers` 之外，使其不会被 Selector 的射线拾取。
  this.backdrop = new THREE.Scene()

  // 地面参考网格及其半透明填充平面。保留在 `scene` 之外，
  // 使其不属于创作的场景图（自动保存、导出、场景面板），
  // 同时仍能与其同步变换。
  // 在此构造（而非由 Viewport 构造），以便一旦 Editor 存在，
  // 这些对象就始终存在，无论视口是否/何时挂载。
  this.grid = new THREE.Group()

  const grid1 = new THREE.GridHelper(30, 30)
  grid1.material.color.setHex(0x999999)
  grid1.material.vertexColors = false
  this.grid.add(grid1)

  const grid2 = new THREE.GridHelper(30, 6)
  grid2.material.color.setHex(0x777777)
  grid2.material.vertexColors = false
  this.grid.add(grid2)

  this.groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  )
  this.groundPlane.rotation.x = -Math.PI / 2
  this.groundPlane.position.y = -0.001
  this.grid.add(this.groundPlane)

  this.backgroundType = "Default"
  this.environmentType = "Default"

  this.object = {}
  this.geometries = {}
  this.materials = {}
  this.textures = {}
  this.scripts = {}

  this.materialsRefCounter = new Map() // 跟踪材质被 3D 对象使用的次数

  this.mixer = new THREE.AnimationMixer(this.scene)

  this.selected = null
  this.helpers = {}

  this.cameras = {}

  this.viewportCamera = this.camera
  this.viewportShading = "default"
  this.viewportColor = new THREE.Color()

  this.addCamera(this.camera)
}

Editor.prototype = {
  setScene: function (scene: THREE.Scene) {
    this.scene.uuid = scene.uuid
    this.scene.name = scene.name

    this.scene.background = scene.background
    this.scene.environment = scene.environment
    this.scene.fog = scene.fog
    this.scene.backgroundBlurriness = scene.backgroundBlurriness
    this.scene.backgroundIntensity = scene.backgroundIntensity

    this.scene.userData = JSON.parse(JSON.stringify(scene.userData))

    // 避免逐对象渲染

    this.signals.sceneGraphChanged.active = false

    while (scene.children.length > 0) {
      this.addObject(scene.children[0])
    }

    this.signals.sceneGraphChanged.active = true
    this.signals.sceneGraphChanged.dispatch()

    this.signals.sceneEnvironmentChanged.dispatch(
      this.environmentType,
      scene.environment
    )
  },

  //

  addObject: function (
    object: THREE.Object3D,
    parent?: THREE.Object3D,
    index?: number
  ) {
    const scope = this

    object.traverse(function (child: any) {
      if (child.geometry !== undefined) scope.addGeometry(child.geometry)
      if (child.material !== undefined) scope.addMaterial(child.material)

      scope.addCamera(child)
      scope.addHelper(child)
    })

    if (parent === undefined) {
      this.scene.add(object)
    } else {
      parent.children.splice(index ?? 0, 0, object)
      object.parent = parent
    }

    this.signals.objectAdded.dispatch(object)
    this.signals.sceneGraphChanged.dispatch()
  },

  nameObject: function (object: THREE.Object3D, name: string) {
    object.name = name
    this.signals.sceneGraphChanged.dispatch()
  },

  removeObject: function (object: THREE.Object3D) {
    if (object.parent === null) return // 避免删除相机或场景

    const scope = this

    object.traverse(function (child: any) {
      scope.removeCamera(child)
      scope.removeHelper(child)

      if (child.material !== undefined) scope.removeMaterial(child.material)
    })

    object.parent!.remove(object)

    this.signals.objectRemoved.dispatch(object)
    this.signals.sceneGraphChanged.dispatch()
  },

  addGeometry: function (geometry: THREE.BufferGeometry) {
    this.geometries[geometry.uuid] = geometry
  },

  setGeometryName: function (geometry: THREE.BufferGeometry, name: string) {
    geometry.name = name
    this.signals.sceneGraphChanged.dispatch()
  },

  addMaterial: function (material: THREE.Material | THREE.Material[]) {
    if (Array.isArray(material)) {
      for (let i = 0, l = material.length; i < l; i++) {
        this.addMaterialToRefCounter(material[i])
      }
    } else {
      this.addMaterialToRefCounter(material)
    }

    this.signals.materialAdded.dispatch()
  },

  addMaterialToRefCounter: function (material: THREE.Material) {
    const materialsRefCounter = this.materialsRefCounter

    let count = materialsRefCounter.get(material)

    if (count === undefined) {
      materialsRefCounter.set(material, 1)
      this.materials[material.uuid] = material
    } else {
      count++
      materialsRefCounter.set(material, count)
    }
  },

  removeMaterial: function (material: THREE.Material | THREE.Material[]) {
    if (Array.isArray(material)) {
      for (let i = 0, l = material.length; i < l; i++) {
        this.removeMaterialFromRefCounter(material[i])
      }
    } else {
      this.removeMaterialFromRefCounter(material)
    }

    this.signals.materialRemoved.dispatch()
  },

  removeMaterialFromRefCounter: function (material: THREE.Material) {
    const materialsRefCounter = this.materialsRefCounter

    let count = materialsRefCounter.get(material)!
    count--

    if (count === 0) {
      materialsRefCounter.delete(material)
      delete this.materials[material.uuid]
    } else {
      materialsRefCounter.set(material, count)
    }
  },

  getMaterialById: function (id: number) {
    let material: THREE.Material | undefined
    const materialsMap: Record<string, THREE.Material> = this.materials
    const materials = Object.values(materialsMap)

    for (let i = 0; i < materials.length; i++) {
      if ((materials[i] as any).id === id) {
        material = materials[i]
        break
      }
    }

    return material
  },

  setMaterialName: function (material: THREE.Material, name: string) {
    material.name = name
    this.signals.sceneGraphChanged.dispatch()
  },

  addTexture: function (texture: THREE.Texture) {
    this.textures[texture.uuid] = texture
  },

  //

  addCamera: function (camera: THREE.Object3D) {
    if ((camera as any).isCamera) {
      this.cameras[camera.uuid] = camera

      this.signals.cameraAdded.dispatch(camera)
    }
  },

  removeCamera: function (camera: THREE.Object3D) {
    if (this.cameras[camera.uuid] !== undefined) {
      delete this.cameras[camera.uuid]

      this.signals.cameraRemoved.dispatch(camera)
    }
  },

  //

  addHelper: (function () {
    const geometry = new THREE.SphereGeometry(2, 4, 2)
    const material = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      visible: false
    })

    return function (this: Editor, object: any, helper?: any) {
      if (helper === undefined) {
        if (object.isCamera) {
          helper = new THREE.CameraHelper(object)
        } else if (object.isPointLight) {
          helper = new THREE.PointLightHelper(object, 1)

          helper.matrix = new THREE.Matrix4()
          helper.matrixAutoUpdate = true

          const light = object
          const editor = this

          helper.updateMatrixWorld = function (this: any) {
            light.getWorldPosition(this.position)

            const distance = editor.viewportCamera.position.distanceTo(
              this.position
            )
            this.scale.setScalar(distance / 30)

            this.updateMatrix()
            this.matrixWorld.copy(this.matrix)

            const children = this.children

            for (let i = 0, l = children.length; i < l; i++) {
              children[i].updateMatrixWorld()
            }
          }
        } else if (object.isDirectionalLight) {
          helper = new THREE.DirectionalLightHelper(object, 1)
        } else if (object.isSpotLight) {
          helper = new THREE.SpotLightHelper(object)
        } else if (object.isHemisphereLight) {
          helper = new THREE.HemisphereLightHelper(object, 1)
        } else if (object.isSkinnedMesh) {
          helper = new THREE.SkeletonHelper(object.skeleton.bones[0])
        } else if (
          object.isBone === true &&
          object.parent &&
          object.parent.isBone !== true
        ) {
          helper = new THREE.SkeletonHelper(object)
        } else {
          // 此对象类型没有辅助器
          return
        }

        const picker = new THREE.Mesh(geometry, material)
        picker.name = "picker"
        picker.userData.object = object
        helper.add(picker)
      }

      this.sceneHelpers.add(helper)
      this.helpers[object.id] = helper

      this.signals.helperAdded.dispatch(helper)
    }
  })(),

  removeHelper: function (object: THREE.Object3D) {
    if (this.helpers[object.id] !== undefined) {
      const helper: any = this.helpers[object.id]
      helper.parent.remove(helper)
      helper.dispose()

      delete this.helpers[object.id]

      this.signals.helperRemoved.dispatch(helper)
    }
  },

  //

  addScript: function (object: THREE.Object3D, script: any) {
    if (this.scripts[object.uuid] === undefined) {
      this.scripts[object.uuid] = []
    }

    this.scripts[object.uuid].push(script)

    this.signals.scriptAdded.dispatch(script)
  },

  removeScript: function (object: THREE.Object3D, script: any) {
    if (this.scripts[object.uuid] === undefined) return

    const index = this.scripts[object.uuid].indexOf(script)

    if (index !== -1) {
      this.scripts[object.uuid].splice(index, 1)
    }

    this.signals.scriptRemoved.dispatch(script)
  },

  getObjectMaterial: function (object: any, slot?: number) {
    let material = object.material

    if (Array.isArray(material) && slot !== undefined) {
      material = material[slot]
    }

    return material
  },

  setObjectMaterial: function (
    object: any,
    slot: number | undefined,
    newMaterial: any
  ) {
    if (Array.isArray(object.material) && slot !== undefined) {
      object.material[slot] = newMaterial
    } else {
      object.material = newMaterial
    }
  },

  setCameraType: function (type: string) {
    const oldCamera = this.camera

    const isOrthographic = (oldCamera as any).isOrthographicCamera === true

    if (
      (type === "orthographic" && isOrthographic) ||
      (type === "perspective" && !isOrthographic)
    )
      return

    // 取景时应围绕的轨道点

    const center = this.controls ? this.controls.center : new THREE.Vector3()
    const distance = oldCamera.position.distanceTo(center)

    let newCamera: THREE.OrthographicCamera | THREE.PerspectiveCamera

    if (type === "orthographic") {
      const halfSize = _ORTHOGRAPHIC_FRUSTUM_SIZE / 2
      newCamera = new THREE.OrthographicCamera(
        -halfSize,
        halfSize,
        halfSize,
        -halfSize,
        0,
        10000
      )
      newCamera.position.copy(oldCamera.position)
      newCamera.quaternion.copy(oldCamera.quaternion)

      // 推导缩放值，使正交取景与轨道中心处的透视视图一致

      const halfFOV = (THREE.MathUtils.DEG2RAD * oldCamera.fov) / 2
      newCamera.zoom =
        (newCamera.top - newCamera.bottom) /
        (2 * Math.max(distance, 0.0001) * Math.tan(halfFOV))
    } else {
      newCamera = new THREE.PerspectiveCamera(50, 1, 0.001, 1e10)
      newCamera.quaternion.copy(oldCamera.quaternion)

      // 沿视线方向重新定位，使透视取景与正交视图一致

      const halfFOV = (THREE.MathUtils.DEG2RAD * newCamera.fov) / 2
      const targetDistance =
        (oldCamera.top - oldCamera.bottom) /
        (2 * oldCamera.zoom * Math.tan(halfFOV))

      const offset = new THREE.Vector3().subVectors(oldCamera.position, center)
      if (offset.lengthSq() === 0)
        offset.set(0, 0, 1).applyQuaternion(oldCamera.quaternion)
      offset.normalize().multiplyScalar(targetDistance)

      newCamera.position.copy(center).add(offset)
    }

    newCamera.name = oldCamera.name
    newCamera.uuid = oldCamera.uuid
    newCamera.updateProjectionMatrix()

    this.camera = newCamera
    this.cameras[newCamera.uuid] = newCamera

    if (this.viewportCamera === oldCamera) this.viewportCamera = newCamera

    this.signals.cameraResetted.dispatch()

    // 保持选中对象（以及侧边栏）与新相机实例同步

    if (this.selected === oldCamera) this.select(newCamera)
  },

  setViewportCamera: function (uuid: string) {
    this.viewportCamera = this.cameras[uuid] || this.camera
    this.signals.viewportCameraChanged.dispatch()
  },

  setViewportShading: function (value: string) {
    this.viewportShading = value
    this.signals.viewportShadingChanged.dispatch()
  },

  //

  select: function (object: THREE.Object3D | null) {
    this.selector.select(object)
  },

  selectById: function (id: number) {
    if (id === this.camera.id) {
      this.select(this.camera)
      return
    }

    this.select(this.scene.getObjectById(id) ?? null)
  },

  selectByUuid: function (uuid: string) {
    const scope = this

    this.scene.traverse(function (child: THREE.Object3D) {
      if (child.uuid === uuid) {
        scope.select(child)
      }
    })
  },

  deselect: function () {
    this.selector.deselect()
  },

  focus: function (object?: THREE.Object3D) {
    if (object !== undefined) {
      this.signals.objectFocused.dispatch(object)
    }
  },

  focusById: function (id: number) {
    this.focus(this.scene.getObjectById(id))
  },

  clear: function () {
    this.history.clear()
    this.storage.clear()

    this.setCameraType("perspective")
    this.camera.copy(_DEFAULT_CAMERA)
    this.signals.cameraResetted.dispatch()

    this.scene.name = "Scene"
    this.scene.userData = {}
    this.scene.background = null
    this.scene.environment = null
    this.scene.fog = null

    const objects = this.scene.children

    this.signals.sceneGraphChanged.active = false

    while (objects.length > 0) {
      this.removeObject(objects[0]!)
    }

    this.signals.sceneGraphChanged.active = true

    this.geometries = {}
    this.materials = {}
    this.textures = {}
    this.scripts = {}

    this.materialsRefCounter.clear()

    this.animations = {}
    this.mixer.stopAllAction()

    this.deselect()

    this.backgroundType = "Default"
    this.environmentType = "Default"

    this.signals.editorCleared.dispatch()
  },

  //

  fromJSON: async function (json: any) {
    const loader = new THREE.ObjectLoader()
    const camera: any = await loader.parseAsync(json.camera)

    this.setCameraType(
      camera.isOrthographicCamera ? "orthographic" : "perspective"
    )

    const existingUuid = this.camera.uuid
    const incomingUuid = camera.uuid

    // 复制所有属性，包括 uuid
    this.camera.copy(camera)
    this.camera.uuid = incomingUuid

    delete this.cameras[existingUuid] // 移除旧条目 [existingUuid, this.camera]
    this.cameras[incomingUuid] = this.camera // 添加新条目 [incomingUuid, this.camera]

    if (json.controls !== undefined) {
      this.controls!.fromJSON(json.controls)
    }

    this.signals.cameraResetted.dispatch()

    this.history.fromJSON(json.history)
    this.scripts = json.scripts

    const scene = (await loader.parseAsync(
      json.scene
    )) as unknown as THREE.Scene

    this.backgroundType = json.backgroundType || "Default"
    this.environmentType = json.environmentType || "Default"

    this.setScene(scene)
  },

  toJSON: function () {
    // 脚本清理

    const scene = this.scene
    const scripts = this.scripts

    for (const key in scripts) {
      const script = scripts[key]!

      if (
        script.length === 0 ||
        scene.getObjectByProperty("uuid", key) === undefined
      ) {
        delete scripts[key]
      }
    }

    return {
      metadata: {},
      project: {
        renderer: this.config.getKey("project/renderer/type"),
        shadows: this.config.getKey("project/renderer/shadows"),
        shadowType: this.config.getKey("project/renderer/shadowType"),
        toneMapping: this.config.getKey("project/renderer/toneMapping"),
        toneMappingExposure: this.config.getKey(
          "project/renderer/toneMappingExposure"
        )
      },
      camera: this.viewportCamera.toJSON(),
      controls: this.controls!.toJSON(),
      scene: this.scene.toJSON(),
      scripts: this.scripts,
      history: this.history.toJSON(),
      backgroundType: this.backgroundType,
      environmentType: this.environmentType
    }
  },

  objectByUuid: function (uuid: string) {
    return this.scene.getObjectByProperty("uuid", uuid, true) ?? null
  },

  execute: function (cmd: Command, optionalName?: string) {
    this.history.execute(cmd, optionalName)
  },

  undo: function () {
    this.history.undo()
  },

  redo: function () {
    this.history.redo()
  },

  utils: {
    save: save,
    saveArrayBuffer: saveArrayBuffer,
    saveString: saveString,
    formatNumber: formatNumber
  }
}

const link = document.createElement("a")

function save(blob: Blob, filename?: string) {
  if (link.href) {
    URL.revokeObjectURL(link.href)
  }

  link.href = URL.createObjectURL(blob)
  link.download = filename || "data.json"
  link.dispatchEvent(new MouseEvent("click"))
}

function saveArrayBuffer(buffer: ArrayBuffer, filename?: string) {
  save(new Blob([buffer], { type: "application/octet-stream" }), filename)
}

function saveString(text: string, filename?: string) {
  save(new Blob([text], { type: "text/plain" }), filename)
}

function formatNumber(number: number) {
  return new Intl.NumberFormat("en-us", { useGrouping: true }).format(number)
}

export { Editor }
