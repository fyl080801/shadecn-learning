import * as THREE from "three"
import { registerEditorProperty } from "@/components/three-editor/commands/SetEditorPropertyCommand"

// 导演台场景属性面板各控件的可撤销属性注册。
// scenePanelFields.ts 的字段通过 SetEditorPropertyCommand 以这些 key
// 派发变更，进入 editor.history，可撤销/重做。
// grid（editor.grid）不是 scene 的子节点（Viewport.ts 独立通道渲染），
// 必须与 scene 的变换同步驱动，联动规则与面板中"场景变换"一节的注释一致。

export interface Vector3Like {
  x: number
  y: number
  z: number
}

export const DIRECTOR_SCENE_SCALE = "director/sceneScale"
export const DIRECTOR_SCENE_POSITION = "director/scenePosition"
export const DIRECTOR_SCENE_ROTATION = "director/sceneRotation"
export const DIRECTOR_SKY_COLOR = "director/skyColor"
export const DIRECTOR_PANORAMA_ROTATION = "director/panoramaRotation"
export const DIRECTOR_PANORAMA_RADIUS = "director/panoramaRadius"
export const DIRECTOR_GROUND_HEIGHT = "director/groundHeight"
export const DIRECTOR_GROUND_OPACITY = "director/groundOpacity"

// 全景球由面板的 ensureSphere 创建并挂在 editor.backdrop 下，handler 按名字查找，
// 面板与此处共用该常量。
export const PANORAMA_SPHERE_NAME = "全景背景"

function panoramaSphere(editor: { backdrop: THREE.Scene }) {
  return editor.backdrop.getObjectByName(PANORAMA_SPHERE_NAME) as
    | THREE.Mesh
    | undefined
}

// 地面高度是纯派生量（grid.y = scene.y + height），three 侧没有可回读的独立宿主，
// 而从 grid/scene 反推偏移在"场景恢复直接改写 scene 变换"时会得到错误值，
// 因此以模块级状态作为单点源：撤销/重做经 handler 改写它，场景平移 handler 与
// 面板的 applyGridPosition 都从这里取值。每次导演台挂载（全新 Editor 实例）时
// 由面板调用 resetDirectorSceneSession() 复位对齐。
let groundHeight = 0

export function currentGroundHeight() {
  return groundHeight
}

export function resetDirectorSceneSession() {
  groundHeight = 0
}

registerEditorProperty<number>(DIRECTOR_SCENE_SCALE, {
  label: "场景缩放",
  get: (editor) => editor.scene.scale.x,
  set: (editor, scale) => {
    editor.scene.scale.set(scale, scale, scale)
    editor.grid.scale.set(scale, scale, scale)
  }
})

registerEditorProperty<Vector3Like>(DIRECTOR_SCENE_POSITION, {
  label: "场景平移",
  get: (editor) => {
    const { x, y, z } = editor.scene.position
    return { x, y, z }
  },
  set: (editor, { x, y, z }) => {
    // 地面网格在场景 y 之上叠加"地面高度"偏移（grid.y = scene.y + groundHeight），
    // 该偏移不属于本属性，取单点源原样保留。
    editor.scene.position.set(x, y, z)
    editor.grid.position.set(x, y + groundHeight, z)
  }
})

// 值为弧度制欧拉角，面板负责与展示用的角度制互转。
registerEditorProperty<Vector3Like>(DIRECTOR_SCENE_ROTATION, {
  label: "场景旋转",
  get: (editor) => {
    const { x, y, z } = editor.scene.rotation
    return { x, y, z }
  },
  set: (editor, { x, y, z }) => {
    editor.scene.rotation.set(x, y, z)
    editor.grid.rotation.copy(editor.scene.rotation)
  }
})

// 值为 '#rrggbb'。面板的不变式是 scene.background 始终为 skyColor 驱动的平面
// Color（见面板"全景背景"一节注释），应用走与面板相同的 sceneBackgroundChanged
// 信号（Viewport.ts 的监听器同步改写 scene.background）。get 的兜底 '#c2c2c2'
// 仅覆盖背景尚未成为 Color 的窗口期（面板挂载即推送默认色，命令构造发生在其后），
// 与面板默认值一致。
registerEditorProperty<string>(DIRECTOR_SKY_COLOR, {
  label: "天空颜色",
  get: (editor) => {
    const background = editor.scene.background as THREE.Color | null
    return background && (background as any).isColor
      ? "#" + background.getHexString()
      : "#c2c2c2"
  },
  set: (editor, hex) => {
    editor.signals.sceneBackgroundChanged.dispatch(
      "Color",
      hex,
      null,
      null,
      THREE.NoColorSpace,
      0,
      1,
      0
    )
  }
})

// 值为弧度。全景球在面板挂载时创建（ensureSphere），命令只会在其后产生；
// 查找不到时静默跳过而非兜底创建——球体的材质/贴图装配属于面板。
registerEditorProperty<number>(DIRECTOR_PANORAMA_ROTATION, {
  label: "全景水平旋转",
  get: (editor) => panoramaSphere(editor)?.rotation.y ?? 0,
  set: (editor, radians) => {
    const sphere = panoramaSphere(editor)
    if (sphere) sphere.rotation.y = radians
  }
})

registerEditorProperty<number>(DIRECTOR_PANORAMA_RADIUS, {
  label: "全景球半径",
  get: (editor) => {
    const sphere = panoramaSphere(editor)
    return sphere
      ? (sphere.geometry as THREE.SphereGeometry).parameters.radius
      : 30
  },
  set: (editor, radius) => {
    const sphere = panoramaSphere(editor)
    if (!sphere) return
    sphere.geometry.dispose()
    sphere.geometry = new THREE.SphereGeometry(radius, 48, 32)
    // 地面填充随全景球半径扩展，覆盖到全景球的赤道切面（与面板原逻辑一致）
    editor.setGroundExtent(radius)
  }
})

registerEditorProperty<number>(DIRECTOR_GROUND_HEIGHT, {
  label: "地面高度",
  get: () => groundHeight,
  set: (editor, height) => {
    groundHeight = height
    editor.grid.position.y = editor.scene.position.y + height
  }
})

registerEditorProperty<number>(DIRECTOR_GROUND_OPACITY, {
  label: "地面透明度",
  // groundPlane 由 Editor.ts 以单个 MeshBasicMaterial 构造，收窄掉 Material[] 分支
  get: (editor) => (editor.groundPlane.material as THREE.Material).opacity,
  set: (editor, opacity) => {
    // 仅影响地面平面网格的填充材质；网格线辅助器不受影响（与面板原逻辑一致）
    const material = editor.groundPlane.material as THREE.Material
    material.opacity = opacity
    material.needsUpdate = true
  }
})
