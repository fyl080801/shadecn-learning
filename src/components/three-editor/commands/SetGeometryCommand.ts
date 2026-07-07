
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { ObjectLoader } from "three"

class SetGeometryCommand extends Command {
  object: any
  oldGeometry: any
  newGeometry: any

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} [object=null]
   * @param {THREE.Geometry|null} [newGeometry=null]
   * @constructor
   */
  constructor(editor: Editor, object: any = null, newGeometry: any = null) {
    super(editor)

    this.type = "SetGeometryCommand"
    this.name = editor.strings.getKey("command/SetGeometry")
    this.updatable = true

    this.object = object
    this.oldGeometry = object !== null ? object.geometry : null
    this.newGeometry = newGeometry
  }

  execute() {
    this.object.geometry.dispose()
    this.object.geometry = this.newGeometry
    this.object.geometry.computeBoundingSphere()

    this.editor.signals.geometryChanged.dispatch(this.object)
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  undo() {
    this.object.geometry.dispose()
    this.object.geometry = this.oldGeometry
    this.object.geometry.computeBoundingSphere()

    this.editor.signals.geometryChanged.dispatch(this.object)
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  update(cmd: SetGeometryCommand) {
    this.newGeometry = cmd.newGeometry
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object.uuid
    output.oldGeometry = this.oldGeometry.toJSON()
    output.newGeometry = this.newGeometry.toJSON()

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.object = this.editor.objectByUuid(json.objectUuid)

    this.oldGeometry = parseGeometry(json.oldGeometry)
    this.newGeometry = parseGeometry(json.newGeometry)

    function parseGeometry(data: any) {
      const loader = new ObjectLoader()
      return loader.parseGeometries([data])[data.uuid]
    }
  }
}

export { SetGeometryCommand }
