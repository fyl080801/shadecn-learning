import type * as THREE from "three"

import type { DirectorTransformCommit } from "@/composables/flow/useDirectorNode"
import { directorIdOf } from "./directorProjection"

/** three 的 TransformControls 里这里用得到的那几样（测试里换成一个 EventDispatcher） */
export interface GizmoControlsLike {
  object?: THREE.Object3D | null
  getMode(): string
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface GizmoCommitHandlers {
  /** 按下手柄：这个投影对象开始被本地拖动（草稿占着屏幕） */
  onStart(object: THREE.Object3D, id: string): void
  /** 松手且确实动了：提交一次（存储单位：米、弧度） */
  onCommit(id: string, change: DirectorTransformCommit): void
  /** 松手（动没动都调）：草稿结束 */
  onEnd(object: THREE.Object3D, id: string): void
}

type Snapshot = { position: number[]; rotation: number[]; scale: number[] }

function snapshot(object: THREE.Object3D): Snapshot {
  return {
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray()
  }
}

const same = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - (b[i] ?? 0)) < 1e-9)

/**
 * 把对象 gizmo 的一次拖动变成**一次**提交（REQ-CANVAS §3.7.2 的「有松手」那一类）：
 * 拖动期间 TransformControls 直接改投影对象（本地草稿），一个字节不写 doc；`mouseUp` 时按当前模式取出那一项
 * （移动 → position、旋转 → rotation、缩放 → scale），和按下时比，变了才提交。
 *
 * 只认投影出来的对象（`userData.directorId`）。引擎自己的 mouseUp 还会往 `editor.history` 里记一条命令 ——
 * 那份历史在导演台里**不是数据源**（docs/07 §7.6），没人读它，撤销走 Y 的撤销栈。
 *
 * 返回解绑函数。
 */
export function bindDirectorGizmoCommit(controls: GizmoControlsLike, handlers: GizmoCommitHandlers): () => void {
  let dragging: { object: THREE.Object3D; id: string; before: Snapshot } | null = null

  function onMouseDown() {
    const object = controls.object ?? null
    const id = directorIdOf(object)
    if (!object || !id) return
    dragging = { object, id, before: snapshot(object) }
    handlers.onStart(object, id)
  }

  function onMouseUp() {
    const current = dragging
    dragging = null
    if (!current) return
    try {
      const after = snapshot(current.object)
      const mode = controls.getMode()
      const change: DirectorTransformCommit = {}
      if (mode === "translate" && !same(after.position, current.before.position)) {
        change.position = after.position as [number, number, number]
      } else if (mode === "rotate" && !same(after.rotation, current.before.rotation)) {
        change.rotation = after.rotation as [number, number, number]
      } else if (mode === "scale" && !same(after.scale, current.before.scale)) {
        change.scale = after.scale as [number, number, number]
      }
      if (Object.keys(change).length > 0) handlers.onCommit(current.id, change)
    } finally {
      handlers.onEnd(current.object, current.id)
    }
  }

  controls.addEventListener("mouseDown", onMouseDown)
  controls.addEventListener("mouseUp", onMouseUp)
  return () => {
    controls.removeEventListener("mouseDown", onMouseDown)
    controls.removeEventListener("mouseUp", onMouseUp)
  }
}
