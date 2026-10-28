
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetShadowValueCommand extends Command {
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
    object: any = null,
    attributeName = "",
    newValue: any = null
  ) {
    super(editor)

    this.type = "SetShadowValueCommand"
    this.name =
      editor.strings.getKey("command/SetShadowValue") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.attributeName = attributeName
    this.oldValue = object !== null ? object.shadow[attributeName] : null
    this.newValue = newValue
  }

  execute() {
    this.object.shadow[this.attributeName] = this.newValue
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    this.object.shadow[this.attributeName] = this.oldValue
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(cmd: SetShadowValueCommand) {
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

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.attributeName = json.attributeName
    this.oldValue = json.oldValue
    this.newValue = json.newValue
  }
}

export { SetShadowValueCommand }
