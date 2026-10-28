
import * as THREE from "three"
import { Command } from "../Command"
import type { Editor } from "../Editor"
import { SetUuidCommand } from "./SetUuidCommand"
import { SetValueCommand } from "./SetValueCommand"
import { AddObjectCommand } from "./AddObjectCommand"
import * as Commands from "./Commands"

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

    for (let i = 0; i < this.cmdArray.length; i++) {
      this.cmdArray[i]!.execute()
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
    for (let i = 0; i < this.cmdArray.length; i++) {
      cmds.push(this.cmdArray[i]!.toJSON())
    }

    output.cmds = cmds

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    const CommandsByType: Record<string, new (editor: Editor) => Command> =
      Commands as any

    const cmds = json.cmds
      for (let i = 0; i < cmds.length; i++) {
      const cmd = new CommandsByType[cmds[i].type]!(this.editor) // 创建一个 "json.type" 类型的新对象
      cmd.fromJSON(cmds[i])
      this.cmdArray.push(cmd)
    }
  }
}

export { SetSceneCommand }
