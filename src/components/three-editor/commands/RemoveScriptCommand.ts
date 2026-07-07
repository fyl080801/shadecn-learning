
import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"

class RemoveScriptCommand extends Command {
  object: THREE.Object3D | null
  script: any
  index?: number

  /**
   * @param {Editor} editor
   * @param {THREE.Object3D|null} [object=null]
   * @param {string} [script='']
   * @constructor
   */
  constructor(editor: Editor, object: THREE.Object3D | null = null, script: any = "") {
    super(editor)

    this.type = "RemoveScriptCommand"
    this.name = editor.strings.getKey("command/RemoveScript")

    this.object = object
    this.script = script

    if (this.object !== null && this.script !== "") {
      this.index = this.editor.scripts[this.object.uuid]?.indexOf(this.script)
    }
  }

  execute() {
    if (this.editor.scripts[this.object!.uuid] === undefined) return

    if (this.index !== -1) {
      this.editor.scripts[this.object!.uuid]!.splice(this.index!, 1)
    }

    this.editor.signals.scriptRemoved.dispatch(this.script)
  }

  undo() {
    if (this.editor.scripts[this.object!.uuid] === undefined) {
      this.editor.scripts[this.object!.uuid] = []
    }

    this.editor.scripts[this.object!.uuid]!.splice(this.index!, 0, this.script)

    this.editor.signals.scriptAdded.dispatch(this.script)
  }

  toJSON() {
    const output = super.toJSON()

    output.objectUuid = this.object!.uuid
    output.script = this.script
    output.index = this.index

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.script = json.script
    this.index = json.index
    this.object = this.editor.objectByUuid(json.objectUuid)
  }
}

export { RemoveScriptCommand }
