import * as Commands from "./commands/Commands"
import type { Editor } from "./Editor"
import type { Command } from "./Command"
import type { ConfigApi } from "./Config"

class History {
  editor: Editor
  undos: Command[]
  redos: Command[]
  lastCmdTime: number
  idCounter: number
  historyDisabled: boolean
  config: ConfigApi

  constructor(editor: Editor) {
    this.editor = editor
    this.undos = []
    this.redos = []
    this.lastCmdTime = Date.now()
    this.idCounter = 0

    this.historyDisabled = false
    this.config = editor.config

    // 信号

    const scope = this

    this.editor.signals.startPlayer.add(function () {
      scope.historyDisabled = true
    })

    this.editor.signals.stopPlayer.add(function () {
      scope.historyDisabled = false
    })
  }

  execute(cmd: Command, optionalName?: string) {
    const lastCmd = this.undos[this.undos.length - 1]
    const timeDifference = Date.now() - this.lastCmdTime

    const isUpdatableCmd =
      lastCmd &&
      lastCmd.updatable &&
      cmd.updatable &&
      lastCmd.object === cmd.object &&
      lastCmd.type === cmd.type &&
      lastCmd.script === cmd.script &&
      lastCmd.attributeName === cmd.attributeName

    if (isUpdatableCmd && cmd.type === "SetScriptValueCommand") {
      // 当 cmd.type 为 "SetScriptValueCommand" 时忽略 timeDifference

      lastCmd.update(cmd)
      cmd = lastCmd
    } else if (isUpdatableCmd && timeDifference < 500) {
      lastCmd.update(cmd)
      cmd = lastCmd
    } else {
      // 该命令不可更新，作为历史记录的新部分添加

      this.undos.push(cmd)
      cmd.id = ++this.idCounter
    }

    cmd.name = optionalName !== undefined ? optionalName : cmd.name
    cmd.execute()
    cmd.inMemory = true

    if (this.config.getKey("settings/history")) {
      cmd.json = cmd.toJSON() // 执行后立即序列化命令并将 json 附加到该命令
    }

    this.lastCmdTime = Date.now()

    // 清除所有重做命令

    this.redos = []
    this.editor.signals.historyChanged.dispatch(cmd)
  }

  undo() {
    if (this.historyDisabled) {
      alert(this.editor.strings.getKey("prompt/history/forbid"))
      return
    }

    let cmd: Command | undefined = undefined

    if (this.undos.length > 0) {
      cmd = this.undos.pop()

      if (cmd!.inMemory === false) {
        cmd!.fromJSON(cmd!.json)
      }
    }

    if (cmd !== undefined) {
      cmd.undo()
      this.redos.push(cmd)
      this.editor.signals.historyChanged.dispatch(cmd)
    }

    return cmd
  }

  redo() {
    if (this.historyDisabled) {
      alert(this.editor.strings.getKey("prompt/history/forbid"))
      return
    }

    let cmd: Command | undefined = undefined

    if (this.redos.length > 0) {
      cmd = this.redos.pop()

      if (cmd!.inMemory === false) {
        cmd!.fromJSON(cmd!.json)
      }
    }

    if (cmd !== undefined) {
      cmd.execute()
      this.undos.push(cmd)
      this.editor.signals.historyChanged.dispatch(cmd)
    }

    return cmd
  }

  toJSON() {
    const history: { undos: any[]; redos: any[] } = { undos: [], redos: [] }

    if (!this.config.getKey("settings/history")) {
      return history
    }

    // 将撤销命令追加到历史记录

    for (let i = 0; i < this.undos.length; i++) {
      if (this.undos[i]!.hasOwnProperty("json")) {
        history.undos.push(this.undos[i]!.json)
      }
    }

    // 将重做命令追加到历史记录

    for (let i = 0; i < this.redos.length; i++) {
      if (this.redos[i]!.hasOwnProperty("json")) {
        history.redos.push(this.redos[i]!.json)
      }
    }

    return history
  }

  fromJSON(json: any) {
    if (json === undefined) return

    const CommandsByType: Record<string, new (editor: Editor) => Command> =
      Commands as any

    for (let i = 0; i < json.undos.length; i++) {
      const cmdJSON = json.undos[i]
      const cmd = new CommandsByType[cmdJSON.type]!(this.editor) // 创建一个 "json.type" 类型的新对象
      cmd.json = cmdJSON
      cmd.id = cmdJSON.id
      cmd.name = cmdJSON.name
      this.undos.push(cmd)
      this.idCounter = cmdJSON.id > this.idCounter ? cmdJSON.id : this.idCounter // 设置最后使用的 idCounter
    }

    for (let i = 0; i < json.redos.length; i++) {
      const cmdJSON = json.redos[i]
      const cmd = new CommandsByType[cmdJSON.type]!(this.editor) // 创建一个 "json.type" 类型的新对象
      cmd.json = cmdJSON
      cmd.id = cmdJSON.id
      cmd.name = cmdJSON.name
      this.redos.push(cmd)
      this.idCounter = cmdJSON.id > this.idCounter ? cmdJSON.id : this.idCounter // 设置最后使用的 idCounter
    }

    // 选中最后执行的撤销命令
    this.editor.signals.historyChanged.dispatch(
      this.undos[this.undos.length - 1]
    )
  }

  clear() {
    this.undos = []
    this.redos = []
    this.idCounter = 0

    this.editor.signals.historyChanged.dispatch()
  }

  goToState(id: number) {
    if (this.historyDisabled) {
      alert(this.editor.strings.getKey("prompt/history/forbid"))
      return
    }

    this.editor.signals.sceneGraphChanged.active = false
    this.editor.signals.historyChanged.active = false

    let cmd =
      this.undos.length > 0 ? this.undos[this.undos.length - 1] : undefined // 下一个要弹出的命令

    if (cmd === undefined || id > cmd.id) {
      cmd = this.redo()
      while (cmd !== undefined && id > cmd.id) {
        cmd = this.redo()
      }
    } else {
      while (true) {
        cmd = this.undos[this.undos.length - 1] // 下一个要弹出的命令

        if (cmd === undefined || id === cmd.id) break

        this.undo()
      }
    }

    this.editor.signals.sceneGraphChanged.active = true
    this.editor.signals.historyChanged.active = true

    this.editor.signals.sceneGraphChanged.dispatch()
    this.editor.signals.historyChanged.dispatch(cmd)
  }

  enableSerialization(id: number) {
    /**
     * 因为 this.undos 和 this.redos 中可能存在尚未
     * 通过 .toJSON() 序列化的命令，所以我们回到最旧的命令，
     * 逐个重做，同时对其调用 .toJSON()。
     */

    this.goToState(-1)

    this.editor.signals.sceneGraphChanged.active = false
    this.editor.signals.historyChanged.active = false

    let cmd = this.redo()
    while (cmd !== undefined) {
      if (!cmd.hasOwnProperty("json")) {
        cmd.json = cmd.toJSON()
      }

      cmd = this.redo()
    }

    this.editor.signals.sceneGraphChanged.active = true
    this.editor.signals.historyChanged.active = true

    this.goToState(id)
  }
}

export { History }
