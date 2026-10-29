import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { SetUuidCommand } from "./SetUuidCommand"
import { SetValueCommand } from "./SetValueCommand"
import { AddObjectCommand } from "./AddObjectCommand"
import { createCommandByType } from "./registry"

class SetSceneCommand extends Command {
  cmdArray: Command[]

  /**
   * @param {Editor} editor
   * @param {THREE.Scene|null} [scene=null]
   * @constructor
   */
  constructor(editor: Editor, scene: THREE.Scene | null = null) {
    super(editor)

    this.type = "SetSceneCommand"
    this.name = editor.strings.getKey("command/SetScene")

    this.cmdArray = []

    if (scene !== null) {
      this.cmdArray.push(
        new SetUuidCommand(this.editor, this.editor.scene, scene.uuid)
      )
      this.cmdArray.push(
        new SetValueCommand(this.editor, this.editor.scene, "name", scene.name)
      )
      this.cmdArray.push(
        new SetValueCommand(
          this.editor,
          this.editor.scene,
          "userData",
          JSON.parse(JSON.stringify(scene.userData))
        )
      )
      this.cmdArray.push(
        new SetValueCommand(
          this.editor,
          this.editor.scene,
          "animations",
          scene.animations
        )
      )

      while (scene.children.length > 0) {
        const child = scene.children.pop()
        this.cmdArray.push(new AddObjectCommand(this.editor, child ?? null))
      }
    }
  }

  execute() {
    this.editor.signals.sceneGraphChanged.active = false

    for (const cmd of this.cmdArray) {
      cmd.execute()
    }

    this.editor.signals.sceneGraphChanged.active = true
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  undo() {
    this.editor.signals.sceneGraphChanged.active = false

    for (let i = this.cmdArray.length - 1; i >= 0; i--) {
      this.cmdArray[i]!.undo()
    }

    this.editor.signals.sceneGraphChanged.active = true
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  toJSON() {
    const output = super.toJSON()

    const cmds = []
    for (const cmd of this.cmdArray) {
      cmds.push(cmd.toJSON())
    }

    output.cmds = cmds

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    const cmds = json.cmds
    for (const cmdJSON of cmds) {
      const cmd = createCommandByType(this.editor, cmdJSON.type)
      cmd.fromJSON(cmdJSON)
      this.cmdArray.push(cmd)
    }
  }
}

export { SetSceneCommand }
