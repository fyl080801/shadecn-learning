import * as THREE from "three"

import { getObjectCenterNode } from "./directorObjectCenter"

// ————————————————————————————————————————————————————————————————
// 几何图形（工具栏创建的立方体/球体/圆柱…）的**材质单点源**。
//
// 导演台没有任何灯光对象，明暗全部来自 `scene.environment`（见 useDirectorSceneBackdrop
// 的 applyEnvironmentLighting）。环境接上中性影棚之后还差一半：MeshStandardMaterial 的
// 出厂值是 `roughness = 1`，完全漫反射——环境里的灯板被糊成一片均匀的漫射，物体照样没有
// 高光、只有一层极缓的明暗过渡，读起来仍是「一整块色」。故图形要在粗糙度上留出一点镜面
// 反射，光泽才出得来。
//
// 角色与机位模型走的是另一条路（MeshMatcapMaterial，见 characterPose 的
// applyUnlitCharacterMaterial）：它们的明暗烘在 matcap 贴图里、不吃环境，本文件不碰它们。
// ————————————————————————————————————————————————————————————————

/** 图形默认色（与属性面板颜色字段的兜底值一致）。 */
export const SHAPE_DEFAULT_COLOR = 0x9aa5b1

/**
 * 统一的表面参数。留一点镜面（roughness < 1）让环境里的灯板落成可辨的高光，再给一丝金属度
 * 加强反射的存在感——两者都刻意保守，再往下走图形会变成镜子、盖过它自己的颜色。
 */
export const SHAPE_SURFACE = {
  roughness: 0.38,
  metalness: 0.08,
  envMapIntensity: 1.15
} as const

/** 新建图形的材质。工具栏与任何将来的图形创建入口都走这里，不要再各自 new 一份。 */
export function createShapeMaterial(
  color: THREE.ColorRepresentation = SHAPE_DEFAULT_COLOR
) {
  return new THREE.MeshStandardMaterial({ color, ...SHAPE_SURFACE })
}

/**
 * 「这个对象的主体材质是哪一个」——与属性面板颜色字段的 shapeMesh 同一口径：内容是一个
 * 单独网格的才算（导入模型是一整棵子树、各节点自带作者调好的材质，不在此列）。
 */
function shapeMesh(object: any): any | null {
  const mesh = object?.isMesh ? object : getObjectCenterNode(object)
  return mesh?.isMesh && mesh.material && !Array.isArray(mesh.material)
    ? mesh
    : null
}

/**
 * 把一个已在场景里的图形的表面参数归一到 SHAPE_SURFACE。**只改表面参数、不碰颜色**——
 * 颜色是用户设的，随材质一起被 directorSceneCodec 序列化。
 *
 * @returns 是否真的改动了参数（用于决定要不要请求重绘）
 */
export function normalizeShapeMaterial(object: any): boolean {
  const mesh = shapeMesh(object)
  const material = mesh?.material
  if (!material?.isMeshStandardMaterial) return false

  let changed = false
  for (const [key, value] of Object.entries(SHAPE_SURFACE)) {
    if (material[key] === value) continue
    material[key] = value
    changed = true
  }
  if (changed) material.needsUpdate = true
  return changed
}
