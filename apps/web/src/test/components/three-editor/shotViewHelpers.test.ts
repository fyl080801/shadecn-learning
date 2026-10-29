import { describe, expect, it, vi } from "vitest"
import * as THREE from "three"

import {
  isShotViewHelper,
  markShotViewHelper,
  renderShotViewHelpers
} from "@/components/three-editor/shotViewHelpers"

function createSceneHelpers(children: THREE.Object3D[]): THREE.Group {
  const group = new THREE.Group()
  for (const child of children) group.add(child)
  return group
}

/** 渲染期间的可见性快照——机位画面里到底出现了哪些辅助器，只能在 render 那一刻看。 */
function createRecordingRenderer() {
  const visibleAtRender: string[] = []
  return {
    visibleAtRender,
    render: vi.fn((root: THREE.Object3D) => {
      for (const child of root.children) {
        if (child.visible) visibleAtRender.push(child.name)
      }
    })
  }
}

describe("renderShotViewHelpers —— 机位视角只渲染「编辑必需」的辅助器", () => {
  it("标记过的子节点进画面，未标记的被隐藏且渲染后原样恢复", () => {
    const gizmo = markShotViewHelper(new THREE.Object3D())
    gizmo.name = "gizmo"
    const skeleton = markShotViewHelper(new THREE.Object3D())
    skeleton.name = "skeletonLines"
    const frustum = new THREE.Object3D()
    frustum.name = "cameraHelper"

    const sceneHelpers = createSceneHelpers([gizmo, skeleton, frustum])
    const renderer = createRecordingRenderer()

    renderShotViewHelpers(renderer, sceneHelpers, new THREE.PerspectiveCamera())

    expect(renderer.visibleAtRender).toEqual(["gizmo", "skeletonLines"])
    // 隐藏只在渲染那一帧内生效，不能留下持久的可见性改动（骨架线显隐由姿势页签维护）。
    expect(frustum.visible).toBe(true)
  })

  it("原本不可见的子节点渲染后仍不可见，不被误开", () => {
    const hiddenSkeleton = markShotViewHelper(new THREE.Object3D())
    hiddenSkeleton.name = "skeletonLines"
    // 姿势页签未激活时骨架线自身 visible = false，机位视角同样不该显示。
    hiddenSkeleton.visible = false
    const hiddenHelper = new THREE.Object3D()
    hiddenHelper.name = "cameraHelper"
    hiddenHelper.visible = false

    const sceneHelpers = createSceneHelpers([hiddenSkeleton, hiddenHelper])
    const renderer = createRecordingRenderer()

    renderShotViewHelpers(renderer, sceneHelpers, new THREE.PerspectiveCamera())

    expect(renderer.visibleAtRender).toEqual([])
    expect(hiddenSkeleton.visible).toBe(false)
    expect(hiddenHelper.visible).toBe(false)
  })

  it("整组隐藏时（影片录制）什么都不渲染", () => {
    const gizmo = markShotViewHelper(new THREE.Object3D())
    const sceneHelpers = createSceneHelpers([gizmo])
    sceneHelpers.visible = false
    const renderer = createRecordingRenderer()

    renderShotViewHelpers(renderer, sceneHelpers, new THREE.PerspectiveCamera())

    expect(renderer.render).not.toHaveBeenCalled()
    expect(gizmo.visible).toBe(true)
  })

  it("标记只认 userData，不认对象类型", () => {
    expect(isShotViewHelper(new THREE.Object3D())).toBe(false)
    expect(isShotViewHelper(markShotViewHelper(new THREE.Object3D()))).toBe(
      true
    )
    expect(isShotViewHelper(null)).toBe(false)
  })
})
