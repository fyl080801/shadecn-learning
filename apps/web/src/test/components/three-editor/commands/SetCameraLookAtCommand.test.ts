import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { SetCameraLookAtCommand } from "@/components/three-editor/commands/SetCameraLookAtCommand"
import type { CameraLookAtState } from "@/components/director/cameraLookAt"

/**
 * 命令合并时 **old 侧那半份也要接上**。
 *
 * 这条命令是 updatable 的：500ms 窗口内对同一台机位的连续注视编辑会被 History 并成一条
 * （`update()`）。而它记的是**两样**东西——注视状态，以及换模式时换算出来的 authored 朝向。
 * 后者只在真要改朝向的那次编辑里才带上，故合并串里第一条不碰朝向时（拖注视点、拧角度步进
 * 器）这条命令的 `oldRotation` 一直是 null：execute 把换算后的朝向写下去了，undo 却走
 * `apply(oldState, null)` 整个跳过朝向，撤销之后机位的 authored 停在新含义上、
 * `userData.lookAt` 却回到了旧模式——同一份数据被两套约定解释。
 */

function stubEditor(): any {
  return {
    strings: { getKey: () => "command" },
    signals: { objectChanged: { dispatch: () => {} } }
  }
}

function stubCamera(): any {
  const camera = new THREE.PerspectiveCamera()
  camera.rotation.set(0, Math.PI / 4, 0)
  return camera
}

const state = (mode: CameraLookAtState["mode"], x: number): CameraLookAtState =>
  ({ mode, targetUuid: null, target: { x, y: 0, z: 0 } }) as CameraLookAtState

describe("SetCameraLookAtCommand 的合并", () => {
  it("前一条不碰朝向时，old 侧的朝向由后一条补上", () => {
    const editor = stubEditor()
    const camera = stubCamera()

    // 第一条：只挪注视点，不碰朝向（oldRotation 因此是 null）。
    const first = new SetCameraLookAtCommand(
      editor,
      camera,
      state("point", 1),
      state("point", 0)
    )
    expect(first.oldRotation).toBeNull()
    expect(first.newRotation).toBeNull()

    // 第二条：换模式，带上换算后的 authored 朝向。
    const converted = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, 0.3))
      .toArray()
    const second = new SetCameraLookAtCommand(
      editor,
      camera,
      state("free", 1),
      state("point", 1),
      converted
    )
    expect(second.oldRotation).not.toBeNull()

    first.update(second)

    // 合并后这条命令要能一次性走完「朝向也变了」这一半，两端都得有值。
    expect(first.newRotation).toEqual(converted)
    expect(first.oldRotation).toEqual(second.oldRotation)
  })

  it("前一条已经带了朝向时不被后一条的 old 覆盖（撤销要回到整串之前）", () => {
    const editor = stubEditor()
    const camera = stubCamera()

    const firstRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, 0.1)
    )
    const first = new SetCameraLookAtCommand(
      editor,
      camera,
      state("free", 1),
      state("point", 0),
      firstRotation.toArray()
    )
    const startedFrom = first.oldRotation
    expect(startedFrom).not.toBeNull()

    // 中间这一条把 authored 改掉了，故它构造时抄下的 old 已经不是整串之前那一份。
    camera.quaternion.copy(firstRotation)
    const second = new SetCameraLookAtCommand(
      editor,
      camera,
      state("point", 2),
      state("free", 1),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.2)).toArray()
    )

    first.update(second)

    expect(first.oldRotation).toEqual(startedFrom)
  })

  it("后一条不碰朝向时，前一条换算出来的那份原样保留", () => {
    const editor = stubEditor()
    const camera = stubCamera()

    const converted = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0, 0, 0.3))
      .toArray()
    const first = new SetCameraLookAtCommand(
      editor,
      camera,
      state("free", 1),
      state("point", 0),
      converted
    )
    const second = new SetCameraLookAtCommand(
      editor,
      camera,
      state("free", 2),
      state("free", 1)
    )

    first.update(second)

    expect(first.newRotation).toEqual(converted)
    expect(first.newState.target.x).toBe(2)
  })
})
