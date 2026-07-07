
import { Command } from "../Command"
import type { Editor } from "../Editor"
import * as Commands from "./Commands"

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

export { MultiCmdsCommand }
