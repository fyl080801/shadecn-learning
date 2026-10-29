import * as THREE from "three"
import signals, { Signal } from "signals"

import { Config, type ConfigApi } from "./Config"
import { Loader } from "./Loader"
import { History as _History } from "./History"
import { Strings, type StringsApi } from "./Strings"
import { Storage as _Storage, type StorageApi } from "./Storage"
import { Selector } from "./Selector"
import { suspendEvaluated } from "./EvaluatedTransform"
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
  /**
   * 「**就地**画一帧，现在就画完」——派发返回时 canvas 的绘制缓冲区里已经是新画面。
   *
   * 与其余会触发重绘的信号（它们只置位 `renderRequested`，由 setAnimationLoop 每帧最多兑现
   * 一次）分工明确：那条路要等到下一次 rAF，而**逐帧导出**必须在同一个任务里画完就取帧
   * ——`preserveDrawingBuffer` 为 false 时绘制缓冲区在合成之后即被清空，中间让出一次事件
   * 循环，取到的就是一块空白。见 director/useDirectorMovieExport 的录制循环。
   *
   * 只给这类「画完立刻要读像素」的流程用。常规的「某某变了、该重绘了」一律走既有信号，
   * **不要**改派本条：帧内多次同步全量渲染正是当年 render() 降级为标记位要解决的问题。
   */
  renderNow: Signal
  /**
   * 「场景被逐帧驱动改写了一次」——动画播放这类高频写回的**唯一**广播，参数是当前时刻
   * （秒）。导演台由时间轴的落地入口派发（见 director/timeline/useDirectorTimeline 的
   * applyCurrentTime）。
   *
   * 与 `objectChanged` 的分工是本域的一条硬线，**不要**混用：
   *   · `objectChanged` = 「某个对象被改了」，扇出极宽（属性面板逐字段回填、场景面板整表
   *     重渲染、自动保存防抖、自动关键帧补帧），逐帧派发会直接把播放拖垮；
   *   · 本信号 = 「这一帧的场景已经落地」，只供**自己画一份场景、或跟着对象走的叠加层**
   *     刷新（视口重绘与选中框、机位预览、注视装置连线、FOV 视锥示意），**不做任何
   *     数值回填**。数值面板与自动保存在播放停下时由 settle() 补一次 objectChanged 对账。
   *
   * 新增「播放时也要跟着动」的东西一律订这条，**不要**再各自 `watch(timelineCurrentTime)`
   * 或借 `cameraChanged` 混用——那正是此前四条通道各自为政、机位预览播放时冻住的来源。
   */
  sceneAnimated: Signal
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

  /**
   * 当前渲染器（尚未创建时为 null）。由 `rendererCreated` 信号记入，供晚于该信号挂载
   * 的消费者取用——那个信号只广播一次，之后挂载的组件订阅了也收不到。
   */
  renderer: THREE.WebGLRenderer | null

  camera: EditorCamera
  scene: THREE.Scene
  sceneHelpers: THREE.Scene
  backdrop: THREE.Scene
  grid: THREE.Group
  groundPlane: THREE.Mesh
  // 地面填充的覆盖范围。`null` 表示默认与网格等大的方形填充
  // （three-editor 自身行为）；为数字时表示以该半径的圆形填充覆盖
  // 全景球的赤道切面（导演台行为）。由 `setGroundExtent` 切换。
  groundExtent: number | null
  // 中心 X/Z 坐标轴线（红/蓝，细条状 Mesh），长度随 groundExtent 同步
  // 延伸至地面填充边界，由 `setGroundExtent` 一并更新几何体。
  groundAxisLines: { x: THREE.Mesh; z: THREE.Mesh }

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
  // Viewport 构造时挂载的 TransformControls 实例（选中对象的变换 gizmo）。
  // 暴露到 editor 上，供机位视角的相机导航（director/useDirectorCameraControls）
  // 判定指针是否落在 gizmo 手柄上，从而与拖拽对象的手势区分：hover 到手柄时
  // transformControls.axis 非空，此时左键交给 gizmo，不触发相机旋转。
  transformControls?: any
  // Viewport 构造时挂上的视口拾取：把屏幕坐标解析成场景里的世界点（命中图形则取命中
  // 点，否则退回地面平面，都不成立时为 null）。相机导航据此标定手感——绕哪儿转、拖
  // 多快、朝哪儿推，两个视角各自的控制器（EditorControls.pickPoint 与
  // director/useDirectorCameraControls）都问它，**不要**再各自建一套射线。
  pickViewportPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null

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
  setGroundExtent(extent: number | null): void
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

// 默认地面填充的边长，与 GridHelper 的尺寸保持一致。
const GROUND_DEFAULT_SIZE = 30

// 根据填充范围构建地面平面几何体：
// - `null`：与地面网格等大的方形（three-editor 默认行为）。
// - 数字：以该值为半径的圆形，用于覆盖全景球的赤道切面（导演台行为）。
function createGroundGeometry(extent: number | null): THREE.BufferGeometry {
  if (extent === null) {
    return new THREE.PlaneGeometry(GROUND_DEFAULT_SIZE, GROUND_DEFAULT_SIZE)
  }
  return new THREE.CircleGeometry(extent, 64)
}

// 地面填充范围对应的半边长/半径：与 createGroundGeometry 的形状规则一致，
// 供中心 X/Z 坐标轴线复用，使轴线长度始终延伸到地面填充边界。
function groundHalfExtent(extent: number | null): number {
  return extent === null ? GROUND_DEFAULT_SIZE / 2 : extent
}

// 中心坐标轴线极小的 y 偏移，避免与网格线共面产生 z-fighting
// （同一手法见 groundPlane 的 -0.001 偏移）。
const AXIS_LINE_Y = 0.001

// 轴线用细条状 Mesh（而非 1px 的 THREE.Line）绘制，使其在视口中更醒目；
// 宽度为世界单位下的固定值。
const AXIS_LINE_WIDTH = 0.01

// 轴线用一条细长 PlaneGeometry 表示，长边沿 axis 方向延伸至 halfExtent 边界；
// 由调用方旋转铺平（rotation.x = -Math.PI / 2，与 groundPlane 手法一致）。
function createAxisLineGeometry(
  halfExtent: number,
  axis: "x" | "z"
): THREE.PlaneGeometry {
  const length = halfExtent * 2
  return axis === "x"
    ? new THREE.PlaneGeometry(length, AXIS_LINE_WIDTH)
    : new THREE.PlaneGeometry(AXIS_LINE_WIDTH, length)
}

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
    renderNow: new Signal(),
    sceneAnimated: new Signal(),

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

  // 当前渲染器。`rendererCreated` 是**一次性**广播（渲染器在视口挂载后随即创建，
  // 见 SidebarProject / useDirectorRenderer），晚于那一刻挂载的消费者永远收不到它——
  // 表现是「某个后来才出现的面板里，用共享渲染器画的东西一直空白」。故在此记一份，
  // 让消费者先从 editor.renderer 取，再订阅信号以覆盖后续重建。
  this.renderer = null
  this.signals.rendererCreated.add((renderer: THREE.WebGLRenderer) => {
    this.renderer = renderer
  })

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

  // 中心 X/Z 坐标轴线：颜色与 director 罗盘（DirectorViewHelper 复用的
  // three/addons/helpers/ViewHelper.js）的 X/Z 轴颜色保持一致，使地面
  // 网格中心线与罗盘指向直观对应。长度随 groundExtent 延伸到地面填充
  // 边界（见 groundHalfExtent），由 `setGroundExtent` 一并更新几何体。
  const xAxisLine = new THREE.Mesh(
    createAxisLineGeometry(groundHalfExtent(null), "x"),
    new THREE.MeshBasicMaterial({
      color: 0xff4466,
      toneMapped: false,
      side: THREE.DoubleSide
    })
  )
  xAxisLine.rotation.x = -Math.PI / 2
  xAxisLine.position.y = AXIS_LINE_Y
  this.grid.add(xAxisLine)

  const zAxisLine = new THREE.Mesh(
    createAxisLineGeometry(groundHalfExtent(null), "z"),
    new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      toneMapped: false,
      side: THREE.DoubleSide
    })
  )
  zAxisLine.rotation.x = -Math.PI / 2
  zAxisLine.position.y = AXIS_LINE_Y
  this.grid.add(zAxisLine)

  this.groundAxisLines = { x: xAxisLine, z: zAxisLine }

  this.groundPlane = new THREE.Mesh(
    createGroundGeometry(null),
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

  // 默认与网格等大的方形填充；导演台通过 `setGroundExtent` 切换为
  // 覆盖全景球赤道切面的圆形填充。
  this.groundExtent = null

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
    object.traverse((child: any) => {
      if (child.geometry !== undefined) this.addGeometry(child.geometry)
      if (child.material !== undefined) this.addMaterial(child.material)

      this.addCamera(child)
      this.addHelper(child)
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

    object.traverse((child: any) => {
      this.removeCamera(child)
      this.removeHelper(child)

      if (child.material !== undefined) this.removeMaterial(child.material)
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

    for (const m of materials) {
      if ((m as any).id === id) {
        material = m
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
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- updateMatrixWorld 是带自身 this 的 function（this 指向 helper），无法改为箭头函数，只能通过别名访问编辑器
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

        // 机位（PerspectiveCamera）不附加通用 picker 球体：该球体半径为 2，
        // 远大于实际代表机位的 camera.glb 模型（约 0.3m），会让机位图形
        // 附近很大范围都可被点击选中。机位在视口中只能通过点击其摄像机
        // 模型图形选中（见 Selector.ts 对 isCamera 的向上解析）；
        // 无模型的极端加载失败场景仍可经场景面板（DirectorScenePanel）选中。
        if (!object.isCamera) {
          const picker = new THREE.Mesh(geometry, material)
          picker.name = "picker"
          picker.userData.object = object
          helper.add(picker)
        }
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

  // 切换地面平面填充的覆盖范围（见 `groundExtent`）。`null` 还原为与网格
  // 等大的默认方形填充；数字则构建该半径的圆形填充以覆盖全景球赤道切面。
  // 仅替换几何体，颜色/透明度等材质属性保持不变（包括 Viewport.ts 随明暗
  // 主题应用的 GRID_PLANE_COLOR）。
  setGroundExtent: function (extent: number | null) {
    this.groundExtent = extent
    const plane = this.groundPlane
    plane.geometry.dispose()
    plane.geometry = createGroundGeometry(extent)

    // 红蓝中心轴线随地面填充范围同步延伸，始终覆盖到当前边界。
    const halfExtent = groundHalfExtent(extent)
    const { x: xAxisLine, z: zAxisLine } = this.groundAxisLines
    xAxisLine.geometry.dispose()
    xAxisLine.geometry = createAxisLineGeometry(halfExtent, "x")
    zAxisLine.geometry.dispose()
    zAxisLine.geometry = createAxisLineGeometry(halfExtent, "z")

    this.signals.sceneGraphChanged.dispatch()
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
    this.scene.traverse((child: THREE.Object3D) => {
      if (child.uuid === uuid) {
        this.select(child)
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

    // 派生变换（约束/轨迹/动作算出来的那一份）不进存档：它们是「时刻 → 值」的纯函数，
    // 存下来重新落地时会在自己之上再叠一遍，每存一次歪一点。整场一次性还原成 authored
    // 再序列化，收尾时装回去（见 EvaluatedTransform 的 suspendEvaluated）。
    const restoreEvaluated = suspendEvaluated(this.scene)
    try {
      return this.serializeProject()
    } finally {
      restoreEvaluated()
    }
  },

  serializeProject: function () {
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
      // 始终保存编辑器轨道相机（this.camera），而非当前视口相机。
      // 机位视角下 viewportCamera 是场景中的用户相机，若保存它，刷新后
      // fromJSON 会把该用户相机的 uuid 复制到 editor.camera 上，与场景里
      // 同一台相机产生 uuid 冲突——editor.cameras[uuid] 最终指向场景相机，
      // 导致导演视角下 setViewportCamera(editor.camera.uuid) 解析到场景相机，
      // 轨道控制器被禁用、画面无法移动。保存轨道相机可避免冲突，并使刷新后
      // 始终回到导演视角（activeView 默认即 "director"）。
      camera: this.camera.toJSON(),
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
