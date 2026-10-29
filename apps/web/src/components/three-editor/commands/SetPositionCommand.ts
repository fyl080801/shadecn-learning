import * as THREE from "three"
import { Command } from "../Command"
import { readAuthored, writeAuthored } from "../EvaluatedTransform"
import type { Editor } from "../Editor"
import { Vector3 } from "three"

class SetPositionCommand extends Command {
  object: THREE.Object3D | null
  oldPosition?: THREE.Vector3
  newPosition?: THREE.Vector3

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {THREE.Vector3|null} newPosition
   * @param {THREE.Vector3|null} optionalOldPosition
   * @constructor
   */
  constructor(
    editor: Editor,
    object: THREE.Object3D | null = null,
    newPosition: THREE.Vector3 | null = null,
    optionalOldPosition: THREE.Vector3 | null = null
  ) {
    super(editor)

    this.type = "SetPositionCommand"
    this.name = editor.strings.getKey("command/SetPosition")
    this.updatable = true

    this.object = object

    if (object !== null && newPosition !== null) {
      // 读 **authored**：节点上此刻的位置可能含派生量（约束/轨迹算出来的那一份），
      // 把它当成 old 存进历史，撤销就会把派生量固化成作者数据（见 EvaluatedTransform）。
      this.oldPosition = new THREE.Vector3().fromArray(
        readAuthored(object, "position")
      )
      this.newPosition = newPosition.clone()
    }

    if (optionalOldPosition !== null) {
      this.oldPosition = optionalOldPosition.clone()
    }
  }

  execute() {
    writeAuthored(this.object!, "position", this.newPosition!.toArray())
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    writeAuthored(this.object!, "position", this.oldPosition!.toArray())
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(command: SetPositionCommand) {
    this.newPosition!.copy(command.newPosition!)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object!.uuid
    output.oldPosition = this.oldPosition!.toArray()
    output.newPosition = this.newPosition!.toArray()

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldPosition = new Vector3().fromArray(json.oldPosition)
    this.newPosition = new Vector3().fromArray(json.newPosition)
  }
}

export { SetPositionCommand }
