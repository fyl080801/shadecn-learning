import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { SetPositionCommand } from "@/components/three-editor/commands/SetPositionCommand"
import { SetRotationCommand } from "@/components/three-editor/commands/SetRotationCommand"
import {
  readAuthored,
  setEvaluated
} from "@/components/three-editor/EvaluatedTransform"

// 变换命令读写的必须是 **authored**（作者写的那一份），不是节点上此刻的合成值——后者可能
// 含派生量（约束/轨迹算出来的那一份）。照合成值记 old、照合成值写回，撤销就会把派生量固化
// 成作者数据：用户撤销一步，切线角就变成了他自己的旋转，下一帧再复合一次，角度一路滚。

function stubEditor(): any {
  return {
    strings: { getKey: () => "command" },
    signals: { objectChanged: { dispatch: () => {} } }
  }
}

/** 一个正被轨迹切线朝向驱动着的对象：authored 是 30°，节点上是「切线 90° · authored」。 */
function drivenObject(): THREE.Object3D {
  const object = new THREE.Object3D()
  object.rotation.set(0, THREE.MathUtils.degToRad(30), 0)
  object.position.set(1, 0, 0)
  setEvaluated(
    object,
    "motionTangent",
    "quaternion",
    new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
      .toArray()
  )
  return object
}

/**
 * 绕 Y 转过的角度（度）——**按方向量**，不读欧拉分量：XYZ 轴序下 y 是经 asin 取出来的，
 * 值域只有 ±90°，120° 的 Y 旋转会表示成等价的 (180°, 60°, 180°)，照分量断言必然错判。
 */
function yawDeg(quaternion: THREE.Quaternion): number {
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  return Math.round(THREE.MathUtils.radToDeg(Math.atan2(front.x, front.z)))
}

function authoredYawDeg(object: THREE.Object3D): number {
  return yawDeg(
    new THREE.Quaternion().fromArray(readAuthored(object, "quaternion"))
  )
}

describe("SetRotationCommand —— 只动 authored", () => {
  it("记下的 old 是 authored，而不是节点上的合成值", () => {
    const object = drivenObject()
    // 节点上此刻是 120°（切线 90° + authored 30°），authored 是 30°。
    expect(yawDeg(object.quaternion)).toBe(120)

    const command = new SetRotationCommand(
      stubEditor(),
      object,
      new THREE.Euler(0, THREE.MathUtils.degToRad(45), 0)
    )

    expect(
      yawDeg(new THREE.Quaternion().setFromEuler(command.oldRotation!))
    ).toBe(30)
  })

  it("execute/undo 改的是 authored，派生量原样保留", () => {
    const object = drivenObject()
    const command = new SetRotationCommand(
      stubEditor(),
      object,
      new THREE.Euler(0, THREE.MathUtils.degToRad(45), 0)
    )

    command.execute()
    expect(authoredYawDeg(object)).toBe(45)
    // 节点上仍带着切线那 90°：45 + 90 = 135。
    expect(yawDeg(object.quaternion)).toBe(135)

    command.undo()
    expect(authoredYawDeg(object)).toBe(30)
    expect(yawDeg(object.quaternion)).toBe(120)
  })

  it("没有派生量时就是一次普通的旋转写入（既有行为不变）", () => {
    const object = new THREE.Object3D()
    object.rotation.set(0, 0.5, 0)
    const command = new SetRotationCommand(
      stubEditor(),
      object,
      new THREE.Euler(0.1, 0.2, 0.3)
    )

    command.execute()
    expect(object.rotation.x).toBeCloseTo(0.1, 10)
    expect(object.rotation.y).toBeCloseTo(0.2, 10)
    expect(object.rotation.z).toBeCloseTo(0.3, 10)
    command.undo()
    expect(object.rotation.y).toBeCloseTo(0.5, 10)
  })
})

describe("SetPositionCommand —— 只动 authored", () => {
  it("记下的 old 是 authored，execute/undo 之后派生位移仍在", () => {
    const object = new THREE.Object3D()
    object.position.set(1, 0, 0)
    setEvaluated(object, "rootMotion", "position", [0, 0, 2]) // 动作走出去 2m

    const command = new SetPositionCommand(
      stubEditor(),
      object,
      new THREE.Vector3(5, 0, 0)
    )
    expect(command.oldPosition!.toArray()).toEqual([1, 0, 0])

    command.execute()
    expect(readAuthored(object, "position")).toEqual([5, 0, 0])
    expect(object.position.toArray()).toEqual([5, 0, 2])

    command.undo()
    expect(object.position.toArray()).toEqual([1, 0, 2])
  })

  it("没有派生量时就是一次普通的位置写入（既有行为不变）", () => {
    const object = new THREE.Object3D()
    object.position.set(1, 2, 3)
    const command = new SetPositionCommand(
      stubEditor(),
      object,
      new THREE.Vector3(4, 5, 6)
    )

    command.execute()
    expect(object.position.toArray()).toEqual([4, 5, 6])
    command.undo()
    expect(object.position.toArray()).toEqual([1, 2, 3])
  })
})
