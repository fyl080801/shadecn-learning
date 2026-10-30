import * as THREE from "three"
import {
  DEFAULT_DIRECTOR_CAMERA,
  type DirectorObject,
  type DirectorScene
} from "@shadecn/shared/director-doc"
import { objectStateAt, type DirectorTimeline } from "@shadecn/shared/director-eval"

import { createShapeContainer, getObjectCenterNode } from "./directorObjectCenter"
import { createShapeMaterial, SHAPE_DEFAULT_COLOR } from "./directorShapeMaterial"

// ————————————————————————————————————————————————————————————————
// 「Y.Doc → three 场景」的投影（docs/07 §7.6）：导演台节点 `data` 里的 `dc.obj.*` 是唯一的事实源，
// 视口里的 Object3D 只是它的投影 —— 和画布节点由 store 投影出来是同一个关系。
//
// 两步，分工固定：
//
// 1. **对账**（`reconcile`）：按对象 id 增量创建 / 更新 / 删除 Object3D。比较的是对象**除变换以外**的那部分
//    （种类、名字、几何、材质、机位、灯光参数），没变的对象一个字段都不碰（保持同一个 Object3D —— 选区、
//    gizmo 都挂在它上面）。种类变了才重建。
// 2. **求值**（`applyStateAt`）：位置 / 旋转 / 缩放 / fov 一律来自 `@shadecn/shared/director-eval` 的
//    `objectStateAt`，不论有没有关键帧。播放、拖播放头、数据变了，都只是换一个时刻重新求值；
//    **不用 AnimationMixer**（它的 smooth 是三次样条，和这里按段 smoothstep 的定义不同，量出来的会和看到的对不上）。
//
// 求值只改投影出来的对象，**从不写 doc** —— 播放和拖播放头都是本地的事。
//
// 几何与 three 的约定见 `director-doc.ts` 文件头：几何体以中心为原点、高沿 Y；平面铺在 XZ 面、法线朝 +Y、
// 没有厚度（`PlaneGeometry(w, d).rotateX(-π/2)`）；圆柱上下同径；机位朝本地 -Z，fov 竖直、以度存。
// ————————————————————————————————————————————————————————————————

/** 投影出来的 Object3D 上记着它是哪个导演台对象（`userData.directorId`） */
export const DIRECTOR_ID_KEY = "directorId"

/** 对账时宿主（编辑器）要做的三件事；测试里换成假的 */
export interface DirectorProjectionHost {
  /** 新对象入场（编辑器：`editor.addObject`） */
  add(object: THREE.Object3D): void
  /** 对象离场（编辑器：`editor.removeObject`） */
  remove(object: THREE.Object3D): void
  /** 对象的非变换部分改了（编辑器：派发 `objectChanged`，让 helper / 视锥跟上） */
  changed(object: THREE.Object3D): void
}

export interface DirectorReconcileResult {
  added: string[]
  updated: string[]
  removed: string[]
}

interface Entry {
  object: THREE.Object3D
  kind: DirectorObject["kind"]
  /** 非变换部分的指纹 */
  signature: string
}

/** 读出投影对象对应的导演台对象 id；不是投影出来的返回 null */
export function directorIdOf(object: THREE.Object3D | null | undefined): string | null {
  const id = object?.userData?.[DIRECTOR_ID_KEY]
  return typeof id === "string" ? id : null
}

/** 对象除变换以外的部分 —— 只有这部分变了才需要动 Object3D 本身（变换由求值写） */
function signatureOf(object: DirectorObject): string {
  /* eslint-disable @typescript-eslint/no-unused-vars -- 解构出来就是为了丢掉变换 */
  const { position, rotation, scale, ...rest } = object
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return JSON.stringify(rest)
}

// —— 建对象 ——

function shapeGeometry(object: Extract<DirectorObject, { geometry: unknown }>): THREE.BufferGeometry {
  switch (object.kind) {
    case "box":
      return new THREE.BoxGeometry(object.geometry.width, object.geometry.height, object.geometry.depth)
    case "sphere":
      return new THREE.SphereGeometry(object.geometry.radius, 32, 16)
    case "cone":
      return new THREE.ConeGeometry(object.geometry.radius, object.geometry.height, 32)
    case "cylinder":
      return new THREE.CylinderGeometry(object.geometry.radius, object.geometry.radius, object.geometry.height, 32)
    case "plane":
      // three 的 PlaneGeometry 立在 XY 面上；导演台的平面是水平的（XZ 面、法线朝 +Y）
      return new THREE.PlaneGeometry(object.geometry.width, object.geometry.depth).rotateX(-Math.PI / 2)
  }
}

function applyShapeMaterial(material: THREE.MeshStandardMaterial, object: Extract<DirectorObject, { geometry: unknown }>) {
  const spec = object.material ?? {}
  material.color.set(spec.color ?? SHAPE_DEFAULT_COLOR)
  const opacity = spec.opacity ?? 1
  material.opacity = opacity
  material.transparent = opacity < 1
  // 只覆盖数据里给了的；没给的保持统一表面参数（useDirectorShapeMaterial 的口径）
  if (spec.roughness !== undefined) material.roughness = spec.roughness
  if (spec.metalness !== undefined) material.metalness = spec.metalness
  // 平面没有厚度，从下面看也要看得见
  material.side = object.kind === "plane" ? THREE.DoubleSide : THREE.FrontSide
  material.needsUpdate = true
}

/** 机位没有实体模型（camera.glb 不在本仓库）：挂一个小机身当抓手，点它选中机位；机位视角下隐藏（isCameraModel） */
function cameraBody(): THREE.Mesh {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.16, 0.32),
    new THREE.MeshBasicMaterial({ color: 0x6ba3ff })
  )
  body.position.set(0, 0, 0.16)
  body.userData.isCameraModel = true
  return body
}

/** 灯光没有体积：挂一个小球当抓手（`userData.object` 让拾取解析回灯光本身，见 Selector 的 resolveClickTarget） */
function lightMarker(light: THREE.Light): THREE.Mesh {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd36b })
  )
  marker.userData.object = light
  return marker
}

function createLight(object: Extract<DirectorObject, { kind: "light" }>): THREE.Light {
  switch (object.light.type) {
    case "ambient":
      return new THREE.AmbientLight()
    case "directional":
      return new THREE.DirectionalLight()
    case "spot":
      return new THREE.SpotLight()
    case "point":
      return new THREE.PointLight()
  }
}

function build(object: DirectorObject): THREE.Object3D {
  let built: THREE.Object3D
  if (object.kind === "camera") {
    const camera = new THREE.PerspectiveCamera(object.camera.fov, 16 / 9, object.camera.near, object.camera.far)
    camera.userData.isDirectorShot = true
    camera.add(cameraBody())
    built = camera
  } else if (object.kind === "light") {
    const light = createLight(object)
    light.add(lightMarker(light))
    built = light
  } else {
    const mesh = new THREE.Mesh(shapeGeometry(object), createShapeMaterial())
    mesh.name = object.name
    built = createShapeContainer(mesh)
  }
  built.userData[DIRECTOR_ID_KEY] = object.id
  update(built, object, null)
  return built
}

/** 原地改非变换部分；`previous` 为 null 表示刚建好 */
function update(target: THREE.Object3D, object: DirectorObject, previous: DirectorObject | null) {
  target.name = object.name
  if (object.kind === "camera") {
    const camera = target as THREE.PerspectiveCamera
    const spec = { ...DEFAULT_DIRECTOR_CAMERA, ...object.camera }
    camera.fov = spec.fov
    camera.near = spec.near
    camera.far = spec.far
    camera.updateProjectionMatrix()
    return
  }
  if (object.kind === "light") {
    const light = target as THREE.Light
    light.intensity = object.light.intensity
    light.color.set(object.light.color)
    return
  }
  const mesh = getObjectCenterNode(target) as THREE.Mesh | null
  if (!mesh) return
  mesh.name = object.name
  const geometryChanged =
    !previous || !("geometry" in previous) || JSON.stringify(previous.geometry) !== JSON.stringify(object.geometry)
  if (geometryChanged && previous) {
    mesh.geometry.dispose()
    mesh.geometry = shapeGeometry(object)
  }
  applyShapeMaterial(mesh.material as THREE.MeshStandardMaterial, object)
}

function dispose(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose?.()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material?.dispose?.()
  })
}

/**
 * 建一个投影器。一个导演台全屏层一个，随它销毁。
 */
export function createDirectorProjection(host: DirectorProjectionHost) {
  const entries = new Map<string, Entry>()
  /** 上一轮对账时的对象（更新几何时要和它比） */
  const lastObjects = new Map<string, DirectorObject>()

  /** 按场景增量对账，返回这一轮动了哪些 id */
  function reconcile(scene: DirectorScene): DirectorReconcileResult {
    const result: DirectorReconcileResult = { added: [], updated: [], removed: [] }
    for (const [id, entry] of entries) {
      const next = scene.objects.get(id)
      if (next && next.kind === entry.kind) continue
      host.remove(entry.object)
      dispose(entry.object)
      entries.delete(id)
      lastObjects.delete(id)
      // 种类变了 = 删了重建，算作删 + 加
      result.removed.push(id)
    }
    for (const [id, object] of scene.objects) {
      const signature = signatureOf(object)
      const entry = entries.get(id)
      if (!entry) {
        const built = build(object)
        entries.set(id, { object: built, kind: object.kind, signature })
        lastObjects.set(id, object)
        host.add(built)
        result.added.push(id)
        continue
      }
      if (entry.signature === signature) {
        lastObjects.set(id, object)
        continue
      }
      update(entry.object, object, lastObjects.get(id) ?? null)
      entry.signature = signature
      lastObjects.set(id, object)
      host.changed(entry.object)
      result.updated.push(id)
    }
    return result
  }

  /**
   * 把时刻 `t`（毫秒）的状态写到投影对象上。`skip` 里的对象不写 —— 正被本地 gizmo 拖着的那个，
   * 它此刻显示的是本地草稿（同画布拖节点：草稿占着屏幕，松手才提交）。
   */
  function applyStateAt(timeline: DirectorTimeline, t: number, skip?: ReadonlySet<THREE.Object3D>) {
    for (const [id, entry] of entries) {
      if (skip?.has(entry.object)) continue
      const state = objectStateAt(timeline, id, t)
      if (!state) continue
      const object = entry.object
      object.position.fromArray(state.position)
      object.quaternion.fromArray(state.quaternion)
      object.scale.fromArray(state.scale)
      if (state.fov !== undefined && (object as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const camera = object as THREE.PerspectiveCamera
        if (camera.fov !== state.fov) {
          camera.fov = state.fov
          camera.updateProjectionMatrix()
        }
      }
      object.updateMatrixWorld(true)
    }
  }

  function objectOf(id: string): THREE.Object3D | null {
    return entries.get(id)?.object ?? null
  }

  function ids(): string[] {
    return [...entries.keys()]
  }

  /** 全部离场（全屏层关掉时） */
  function clear() {
    for (const entry of entries.values()) {
      host.remove(entry.object)
      dispose(entry.object)
    }
    entries.clear()
    lastObjects.clear()
  }

  return { reconcile, applyStateAt, objectOf, ids, clear }
}

export type DirectorProjection = ReturnType<typeof createDirectorProjection>
