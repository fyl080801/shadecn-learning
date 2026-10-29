import * as THREE from "three"
import { Command } from "../Command"
import { readAuthored, writeAuthored } from "../EvaluatedTransform"
import type { Editor } from "../Editor"
import { Euler } from "three"

const _quat = new THREE.Quaternion()

/** 节点的 authored 角度，按它自己的 Euler 顺序读出（群众分组等用非默认顺序）。 */
function authoredRotation(object: THREE.Object3D): THREE.Euler {
  return new Euler().setFromQuaternion(
    _quat.fromArray(readAuthored(object, "quaternion")),
    object.rotation.order
  )
}

function applyAuthoredRotation(
  object: THREE.Object3D,
  rotation: THREE.Euler
): void {
  // 经 Euler.copy 把轴序一并带上，再换成四元数交给求值层（它按通道记账，只认四元数）。
  writeAuthored(object, "quaternion", _quat.setFromEuler(rotation).toArray())
}

class SetRotationCommand extends Command {
  object: THREE.Object3D | null
  oldRotation?: THREE.Euler
  newRotation?: THREE.Euler

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {THREE.Euler|null} newRotation
   * @param {THREE.Euler|null} optionalOldRotation
   * @constructor
   */
  constructor(
    editor: Editor,
    object: THREE.Object3D | null = null,
    newRotation: THREE.Euler | null = null,
    optionalOldRotation: THREE.Euler | null = null
  ) {
    super(editor)

    this.type = "SetRotationCommand"
    this.name = editor.strings.getKey("command/SetRotation")
    this.updatable = true

    this.object = object

    if (object !== null && newRotation !== null) {
      // 读 **authored**：节点上此刻的角度可能含派生量（轨迹的切线朝向算出来的那一份），
      // 把它当成 old 存进历史，撤销就会把切线角固化成作者数据（见 EvaluatedTransform）。
      this.oldRotation = authoredRotation(object)
      this.newRotation = newRotation.clone()
    }

    if (optionalOldRotation !== null) {
      this.oldRotation = optionalOldRotation.clone()
    }
  }

  execute() {
    applyAuthoredRotation(this.object!, this.newRotation!)
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    applyAuthoredRotation(this.object!, this.oldRotation!)
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(command: SetRotationCommand) {
    this.newRotation!.copy(command.newRotation!)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object!.uuid
    output.oldRotation = this.oldRotation!.toArray()
    output.newRotation = this.newRotation!.toArray()

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldRotation = new Euler().fromArray(json.oldRotation)
    this.newRotation = new Euler().fromArray(json.newRotation)
  }
}

export { SetRotationCommand }
