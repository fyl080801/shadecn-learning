import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { readAuthored, writeAuthored } from "../EvaluatedTransform"
import {
  applyCameraLookAt,
  cloneCameraLookAt,
  ensureCameraLookAt,
  type CameraLookAtState
} from "@/components/director/cameraLookAt"

// 机位「平移」手势的历史命令：位置与注视目标一并变更、原子撤销。
//
// 机位视角右键平移在移动 position 的同时，把手动注视点沿相同世界位移平移，
// 使视线偏移（target - position）保持不变、朝向不变（见 useDirectorCameraControls
// 的 updatePan）。因此撤销/重做必须同时复原 position 与 lookAt，否则二者错位会
// 让后续旋转以过期注视点为中心、起手瞬间猛拉朝向（视图跳变）。
//
// 为何不用 MultiCmdsCommand 组合 SetPositionCommand + SetCameraLookAtCommand：
// 后者在 apply 时立即 applyCameraLookAt 重新对准，而 MultiCmds 顺序执行子命令，
// 无论位置/注视谁先应用，都会出现「一个是新值、另一个还是旧值」的中间态，lookAt
// 依据错位的位置对准，最终朝向错误。此命令先把 position 与 lookAt 都写成同一侧
// 的值，再统一对准一次，从根上避免错位。
//
// updatable：平移手势在指针抬起时一次性提交（false）；滚轮第一人称漫游逐格提交、
// 靠 History 500ms 窗口合并为一条（true，见 useDirectorCameraControls.onWheel）。

class SetCameraPoseCommand extends Command {
  object: any
  oldPosition: THREE.Vector3
  newPosition: THREE.Vector3
  oldState: CameraLookAtState
  newState: CameraLookAtState

  constructor(
    editor: Editor,
    camera: any = null,
    newPosition: THREE.Vector3 | null = null,
    newState: CameraLookAtState | null = null,
    optionalOldPosition: THREE.Vector3 | null = null,
    optionalOldState: CameraLookAtState | null = null,
    updatable = false
  ) {
    super(editor)

    this.type = "SetCameraPoseCommand"
    this.name = "移动机位"
    this.updatable = updatable

    this.object = camera

    this.oldPosition =
      optionalOldPosition !== null
        ? optionalOldPosition.clone()
        : camera !== null
          ? // authored（用户摆的站位）而不是节点上的合成值：机位也能放轨迹片段，
            // 照合成值记再写回去就把派生量固化成了站位（同 SetPositionCommand）。
            new THREE.Vector3().fromArray(readAuthored(camera, "position"))
          : new THREE.Vector3()
    this.newPosition =
      newPosition !== null ? newPosition.clone() : this.oldPosition.clone()

    this.oldState =
      optionalOldState !== null
        ? cloneCameraLookAt(optionalOldState)
        : camera !== null
          ? cloneCameraLookAt(ensureCameraLookAt(camera))
          : { mode: "free", targetUuid: null, target: { x: 0, y: 0, z: 0 } }
    this.newState =
      newState !== null ? cloneCameraLookAt(newState) : this.oldState
  }

  // 先写 position + lookAt 数据，再统一 applyCameraLookAt 对准一次，
  // 保证对准时二者一致；写入克隆避免命令持有的快照被就地污染。
  private apply(position: THREE.Vector3, state: CameraLookAtState) {
    writeAuthored(this.object, "position", position.toArray())
    this.object.userData.lookAt = cloneCameraLookAt(state)
    this.object.updateMatrixWorld(true)
    applyCameraLookAt(this.editor, this.object)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  execute() {
    this.apply(this.newPosition, this.newState)
  }

  undo() {
    this.apply(this.oldPosition, this.oldState)
  }

  // 合并同一机位的连续漫游：只更新目标（new）值，保留初次的起点（old）值，
  // 使整段滚动撤销一步回到漫游前。
  update(command: SetCameraPoseCommand) {
    this.newPosition.copy(command.newPosition)
    this.newState = cloneCameraLookAt(command.newState)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.oldPosition = this.oldPosition.toArray()
    output.newPosition = this.newPosition.toArray()
    output.oldState = this.oldState
    output.newState = this.newState

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldPosition = new THREE.Vector3().fromArray(json.oldPosition)
    this.newPosition = new THREE.Vector3().fromArray(json.newPosition)
    this.oldState = json.oldState
    this.newState = json.newState
  }
}

export { SetCameraPoseCommand }
