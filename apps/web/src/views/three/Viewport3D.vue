<script setup lang="ts">
/**
 * 3D 视口（/3d-viewport）：导演台的「中心视口」单独成页。
 *
 * 只有 three-editor 的渲染核心（ThreeEditor 上下文 + EditorViewport）和导演台的视口
 * 叠加层 / composable，没有顶栏、工具栏、面板、时间轴，也不做场景持久化——每次打开都是
 * 下面 buildDefaultScene 搭的那一份默认场景。
 *
 * 编辑器实例随页面创建、随页面卸载销毁（EditorViewport 卸载时 dispose renderer），
 * 故反复进出不会累积 WebGL 上下文。
 */
import { onMounted } from "vue"
import * as THREE from "three"

import {
  createEditor,
  EditorViewport,
  ThreeEditor
} from "@/components/three-editor"
import {
  aspectRatio,
  createShapeContainer,
  createShapeMaterial,
  DIRECTOR_SHOT_FAR,
  DirectorAspectRatioOverlay,
  DirectorTransformControls,
  DirectorViewHelper,
  resetDirectorGizmoOwner,
  resetDirectorSelection,
  useCameraFrustumFootprint,
  useCameraLookAt,
  useCameraModelVisibility,
  useDirectorCameraControls,
  useDirectorCameraRig,
  useDirectorDeleteShortcut,
  useDirectorObjectGizmo,
  useDirectorRenderer,
  useDirectorSceneBackdrop,
  useDirectorSelection,
  useDirectorShapeMaterial
} from "@/components/director"

// 独立 namespace：Config 按它把渲染设置等写进 localStorage，不与别的编辑器实例串。
const editor = createEditor("3d-viewport")

// 选区与调节器归属是跨 Editor 实例存活的模块级单例：上一次进来时停在某个对象上的话，
// 那个 uuid 在新场景里不存在，而 gizmo 归属据它派生——不复位对象自己的 gizmo 就不出现。
resetDirectorSelection()
resetDirectorGizmoOwner()
// 源项目新建场景时画幅为 auto（不显示取景框）。这一页没有工具栏可以切画幅，
// 故默认给 16:9，让取景框叠加层与相机分辨率闸门一打开就有效果。
aspectRatio.value = "16:9"

// 挂载顺序与源项目 DirectorConsoleModal 一致（去掉了时间轴、轨迹、角色、复制粘贴、
// 播放快捷键这些没有迁移的部分）。
useDirectorSelection(editor)
useDirectorObjectGizmo(editor)
useDirectorDeleteShortcut(editor)
useDirectorShapeMaterial(editor)
useCameraModelVisibility(editor)
useCameraLookAt(editor)
useDirectorCameraRig(editor)
useDirectorSceneBackdrop(editor)
useCameraFrustumFootprint(editor)
useDirectorCameraControls(editor)

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

function buildDefaultScene() {
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

onMounted(() => {
  // 渲染器在微任务里创建（见 useDirectorRenderer），默认场景排在它之后入场，
  // 与源项目「先建渲染器再恢复场景」的顺序一致。
  useDirectorRenderer(editor)
  queueMicrotask(buildDefaultScene)
})
</script>

<template>
  <ThreeEditor :editor="editor">
    <div class="relative h-full w-full overflow-hidden">
      <EditorViewport class="absolute inset-0" />
      <!-- 画幅取景框与周边模糊，纯 CSS 叠加层，不进入视口渲染 -->
      <DirectorAspectRatioOverlay />
      <!-- 罗盘停靠右上角；其下的变换按钮列（DirectorTransformControls）按同一 right 值对齐 -->
      <DirectorViewHelper
        class="absolute top-4 right-4 z-10 rounded-full bg-black/50"
        :size="72"
      />
      <DirectorTransformControls />
    </div>
  </ThreeEditor>
</template>
