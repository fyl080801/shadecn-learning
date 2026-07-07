
import { Command } from "../Command"
import type { Editor } from "../Editor"

class SetMaterialValueCommand extends Command {
  object: any
  materialSlot: number
  attributeName: string
  oldValue: any
  newValue: any

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} [object=null]
   * @param {string} [attributeName='']
   * @param {number|string|boolean|Object|null} [newValue=null]
   * @param {number} [materialSlot=-1]
   * @constructor
   */
  constructor(
    editor: Editor,
    object: any = null,
    attributeName = "",
    newValue: any = null,
    materialSlot = -1
  ) {
    super(editor)

    this.type = "SetMaterialValueCommand"
    this.name =
      editor.strings.getKey("command/SetMaterialValue") + ": " + attributeName
    this.updatable = true

    this.object = object
    this.materialSlot = materialSlot

    const material =
      object !== null ? editor.getObjectMaterial(object, materialSlot) : null

    this.oldValue = material !== null ? material[attributeName] : null
    this.newValue = newValue

    this.attributeName = attributeName
  }

  execute() {
    const material = this.editor.getObjectMaterial(
      this.object,
      this.materialSlot
    )

    material[this.attributeName] = this.newValue
    material.needsUpdate = true

    this.editor.signals.objectChanged.dispatch(this.object)
    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  undo() {
    const material = this.editor.getObjectMaterial(
      this.object,
      this.materialSlot
    )

    material[this.attributeName] = this.oldValue
    material.needsUpdate = true

    this.editor.signals.objectChanged.dispatch(this.object)
    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  update(cmd: SetMaterialValueCommand) {
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

    this.attributeName = json.attributeName
    this.oldValue = json.oldValue
    this.newValue = json.newValue
    this.object = this.editor.objectByUuid(json.objectUuid)
    this.materialSlot = json.materialSlot
  }
}

export { SetMaterialValueCommand }
