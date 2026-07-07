
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetColorCommand extends Command {
  object: any
  attributeName: string
  oldValue: number | null
  newValue: number | null

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} [object=null]
   * @param {string} attributeName
   * @param {?number} [newValue=null] Integer representing a hex color value
   * @constructor
   */
  constructor(
    editor: Editor,
    object: any = null,
    attributeName = "",
    newValue: number | null = null
  ) {
    super(editor)

    this.type = "SetColorCommand"
    this.name = editor.strings.getKey("command/SetColor") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.attributeName = attributeName
    this.oldValue =
      object !== null ? this.object[this.attributeName].getHex() : null
    this.newValue = newValue
  }

  execute() {
    this.object[this.attributeName].setHex(this.newValue)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  undo() {
    this.object[this.attributeName].setHex(this.oldValue)
    this.editor.signals.objectChanged.dispatch(this.object)
  }

  update(cmd: SetColorCommand) {
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

export { SetColorCommand }
