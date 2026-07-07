
import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { Euler } from "three"

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
      this.oldRotation = object.rotation.clone()
      this.newRotation = newRotation.clone()
    }

    if (optionalOldRotation !== null) {
      this.oldRotation = optionalOldRotation.clone()
    }
  }

  execute() {
    this.object!.rotation.copy(this.newRotation!)
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    this.object!.rotation.copy(this.oldRotation!)
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
