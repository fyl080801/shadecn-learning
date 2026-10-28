
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetMaterialColorCommand extends Command {
  object: any
  materialSlot: number
  attributeName: string
  oldValue: number | null
  newValue: number | null

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} [object=null]
   * @param {string} attributeName
   * @param {?number} [newValue=null] Integer representing a hex color value
   * @param {number} [materialSlot=-1]
   * @constructor
   */
  constructor(
    editor: Editor,
    object: any = null,
    attributeName = "",
    newValue: number | null = null,
    materialSlot = -1
  ) {
    super(editor)

    this.type = "SetMaterialColorCommand"
    this.name =
      editor.strings.getKey("command/SetMaterialColor") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.materialSlot = materialSlot

    const material =
      object !== null ? editor.getObjectMaterial(object, materialSlot) : null

    this.oldValue = material !== null ? material[attributeName].getHex() : null
    this.newValue = newValue

    this.attributeName = attributeName
  }

  execute() {
    const material = this.editor.getObjectMaterial(
      this.object,
      this.materialSlot
    )

    material[this.attributeName].setHex(this.newValue)

    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  undo() {
    const material = this.editor.getObjectMaterial(
      this.object,
      this.materialSlot
    )

    material[this.attributeName].setHex(this.oldValue)

    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  update(cmd: SetMaterialColorCommand) {
    this.newValue = cmd.newValue
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.attributeName = this.attributeName
    output.oldValue = this.oldValue
    output.newValue = this.newValue
    output.materialSlot = this.materialSlot

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.attributeName = json.attributeName
    this.oldValue = json.oldValue
    this.newValue = json.newValue
    this.materialSlot = json.materialSlot
  }
}

export { SetMaterialColorCommand }
