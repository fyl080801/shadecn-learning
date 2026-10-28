
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetScriptValueCommand extends Command {
  object: any
  script: any
  attributeName: string
  oldValue: any
  newValue: any

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {string} script
   * @param {string} attributeName
   * @param {string} newValue
   * @constructor
   */
  constructor(
    editor: Editor,
    object: any = null,
    script: any = "",
    attributeName = "",
    newValue: any = null
  ) {
    super(editor)

    this.type = "SetScriptValueCommand"
    this.name =
      editor.strings.getKey("command/SetScriptValue") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.script = script

    this.attributeName = attributeName
    this.oldValue = script !== "" ? script[this.attributeName] : null
    this.newValue = newValue
  }

  execute() {
    this.script[this.attributeName] = this.newValue

    this.editor.signals.scriptChanged.dispatch(this.script)
  }

  undo() {
    this.script[this.attributeName] = this.oldValue

    this.editor.signals.scriptChanged.dispatch(this.script)
  }

  update(cmd: SetScriptValueCommand) {
    this.newValue = cmd.newValue
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.index = this.editor.scripts[this.object.uuid]!.indexOf(this.script)
    output.attributeName = this.attributeName
    output.oldValue = this.oldValue
    output.newValue = this.newValue

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.oldValue = json.oldValue
    this.newValue = json.newValue
    this.attributeName = json.attributeName
    this.object = this.editor.objectByUuid(json.objectUuid)
    this.script = this.editor.scripts[json.objectUuid]![json.index]
  }
}

export { SetScriptValueCommand }
