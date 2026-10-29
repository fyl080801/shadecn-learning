import { Command } from "../Command"
import type { Editor } from "../Editor"
import { createCommandByType } from "./registry"

class MultiCmdsCommand extends Command {
  cmdArray: Command[]

  /**
   * @param {Editor} editor
   * @param {Array<Command>} [cmdArray=[]]
   * @constructor
   */
  constructor(editor: Editor, cmdArray: Command[] = []) {
    super(editor)

    this.type = "MultiCmdsCommand"
    this.name = editor.strings.getKey("command/MultiCmds")

    this.cmdArray = cmdArray
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

export { MultiCmdsCommand }
