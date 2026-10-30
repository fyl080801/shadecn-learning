import * as THREE from "three"

import { DIRECTOR_SHOT_FAR } from "./cameraFrustum"
import { createShapeContainer } from "./directorObjectCenter"
import { createShapeMaterial } from "./directorShapeMaterial"

/** 默认场景里的几何体：与源项目工具栏「添加图形」同一套装配（容器三层 + 统一表面参数）。 */
const DEFAULT_SHAPES: {
  name: string
  geometry: () => THREE.BufferGeometry
  color: THREE.ColorRepresentation
  x: number
}[] = [
  {
    name: "立方体1",
    geometry: () => new THREE.BoxGeometry(1, 1, 1),
    color: 0x6b8cce,
    x: -1.6
  },
  {
    name: "球体1",
    geometry: () => new THREE.SphereGeometry(0.5, 32, 16),
    color: 0xd98c5f,
    x: 0
  },
  {
    name: "圆锥1",
    geometry: () => new THREE.ConeGeometry(0.5, 1, 32),
    color: 0x7fb77e,
    x: 1.6
  }
]

/**
 * 往编辑器里放一份默认场景：立方体、球体、圆锥各一，加一个机位。
 * `/3d-viewport` 和画布上的导演台共用这一份（都还没有场景持久化）。
 */
export function buildDirectorDefaultScene(editor: any) {
  for (const shape of DEFAULT_SHAPES) {
    const mesh = new THREE.Mesh(
      shape.geometry(),
      createShapeMaterial(shape.color)
    )
    mesh.name = shape.name
    const object = createShapeContainer(mesh)
    // 几何体以自身中心为原点、高 1：抬高半个身位，正好立在地面网格上。
    object.position.set(shape.x, 0.5, 0)
    editor.addObject(object)
  }

  // 一个机位：视锥示意（useCameraFrustumFootprint）与注视装置（useDirectorCameraRig）
  // 都只认 userData.isDirectorShot 的透视相机。源项目的机位实体模型（camera.glb）来自后端
  // 资源索引，这里没有，只显示视锥线框。
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, DIRECTOR_SHOT_FAR)
  camera.name = "机位1"
  camera.userData.isDirectorShot = true
  camera.position.set(4, 2.5, 6)
  camera.lookAt(0, 0.5, 0)
  editor.addObject(camera)
}
