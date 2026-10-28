
import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetValueCommand extends Command {
  object: any
  attributeName: string
  oldValue: any
  newValue: any

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {string} attributeName
   * @param {number|string|boolean|Object|null} newValue
   * @constructor
   */
  constructor(
    editor: Editor,
    object: THREE.Object3D | null = null,
    attributeName = "",
    newValue: any = null
  ) {
    super(editor)

    this.type = "SetValueCommand"
    this.name = editor.strings.getKey("command/SetValue") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.attributeName = attributeName
    this.oldValue = object !== null ? (object as any)[attributeName] : null
    this.newValue = newValue
  }

  execute() {
    this.object[this.attributeName] = this.newValue
    this.editor.signals.objectChanged.dispatch(this.object)
    // this.editor.signals.sceneGraphChanged.dispatch();
  }

  undo() {
    this.object[this.attributeName] = this.oldValue
    this.editor.signals.objectChanged.dispatch(this.object)
    // this.editor.signals.sceneGraphChanged.dispatch();
  }

  update(cmd: SetValueCommand) {
    this.newValue = cmd.newValue
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.attributeName = this.attributeName
    output.oldValue = this.oldValue
    output.newValue = this.newValue

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.attributeName = json.attributeName
    this.oldValue = json.oldValue
    this.newValue = json.newValue
    this.object = this.editor.objectByUuid(json.objectUuid)
  }
}

export { SetValueCommand }
