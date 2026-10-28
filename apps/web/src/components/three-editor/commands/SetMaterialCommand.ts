
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { ObjectLoader } from "three"

class SetMaterialCommand extends Command {
  object: any
  materialSlot: number
  oldMaterial: any
  newMaterial: any

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} object
   * @param {THREE.Material|null} newMaterial
   * @param {number} [materialSlot=-1]
   * @constructor
   */
  constructor(
    editor: Editor,
    object: any = null,
    newMaterial: any = null,
    materialSlot = -1
  ) {
    super(editor)

    this.type = "SetMaterialCommand"
    this.name = editor.strings.getKey("command/SetMaterial")

    this.object = object
    this.materialSlot = materialSlot

    this.oldMaterial =
      object !== null ? editor.getObjectMaterial(object, materialSlot) : null
    this.newMaterial = newMaterial
  }

  execute() {
    this.editor.setObjectMaterial(
      this.object,
      this.materialSlot,
      this.newMaterial
    )

    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  undo() {
    this.editor.setObjectMaterial(
      this.object,
      this.materialSlot,
      this.oldMaterial
    )

    this.editor.signals.materialChanged.dispatch(this.object, this.materialSlot)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.oldMaterial = this.oldMaterial.toJSON()
    output.newMaterial = this.newMaterial.toJSON()
    output.materialSlot = this.materialSlot

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)
    this.oldMaterial = parseMaterial(json.oldMaterial)
    this.newMaterial = parseMaterial(json.newMaterial)
    this.materialSlot = json.materialSlot

    function parseMaterial(json: any) {
      const loader = new ObjectLoader()
      const images = loader.parseImages(json.images)
      const textures = loader.parseTextures(json.textures, images)
      const materials = loader.parseMaterials([json], textures)
      return materials[json.uuid]
    }
  }
}

export { SetMaterialCommand }
