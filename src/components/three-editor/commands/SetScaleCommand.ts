
import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { Vector3 } from "three"

class SetScaleCommand extends Command {
  object: THREE.Object3D | null
  oldScale?: THREE.Vector3
  newScale?: THREE.Vector3

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {THREE.Vector3|null} newScale
   * @param {THREE.Vector3|null} optionalOldScale
   * @constructor
   */
  constructor(
    editor: Editor,
    object: THREE.Object3D | null = null,
    newScale: THREE.Vector3 | null = null,
    optionalOldScale: THREE.Vector3 | null = null
  ) {
    super(editor)

    this.type = "SetScaleCommand"
    this.name = editor.strings.getKey("command/SetScale")
    this.updatable = true

    this.object = object

    if (object !== null && newScale !== null) {
      this.oldScale = object.scale.clone()
      this.newScale = newScale.clone()
    }

    if (optionalOldScale !== null) {
      this.oldScale = optionalOldScale.clone()
    }
  }

  execute() {
    this.object!.scale.copy(this.newScale!)
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    this.object!.scale.copy(this.oldScale!)
    this.object!.updateMatrixWorld(true)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(command: SetScaleCommand) {
    this.newScale!.copy(command.newScale!)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object!.uuid
    output.oldScale = this.oldScale!.toArray()
    output.newScale = this.newScale!.toArray()

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldScale = new Vector3().fromArray(json.oldScale)
    this.newScale = new Vector3().fromArray(json.newScale)
  }
}

export { SetScaleCommand }
