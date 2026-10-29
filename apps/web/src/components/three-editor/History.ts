// 只为副作用：登记全部命令类型，fromJSON 才能按 type 新建（见 commands/registry.ts）
import "./commands/Commands"
import { createCommandByType } from "./commands/registry"
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
  /**
   * 此刻正在 `execute()` 里的那条命令（不在执行中即 null）。
   *
   * 给「跑在命令派发的信号里、要认出宿主命令是谁」的消费方用——时间轴的自动补帧挂在
   * `objectChanged` 上，而那个信号正是各命令在 execute 里派发的（见
   * directorTimeline.flushAutoKeyHistory）。
   *
   * 此前那一侧是靠 `undos[last].inMemory === false` 反推的：push 之后、置 inMemory 之前
   * 确实只有这个窗口。但**合并**那条路（updatable 命令在 500ms 窗口内并进上一条）走的是
   * `cmd = lastCmd` 再 execute 一次，那时 inMemory 早已是 true，反推不出来——于是那一侧
   * 又补了一条「这个条目已经挂过快照就直接前移」的分支绕过判据，而那条分支对**已经执行完
   * 的**栈顶同样成立：下一次不相干的编辑在它自己的命令出现之前，补出来的帧会被塞进上一条
   * 命令的 redo 侧。两个窗口合在一起才是「宿主命令正在执行」，故直接记下来，不再反推。
   */
  executing: Command | null

  constructor(editor: Editor) {
    this.editor = editor
    this.undos = []
    this.redos = []
    this.lastCmdTime = Date.now()
    this.idCounter = 0
    this.executing = null

    this.historyDisabled = false
    this.config = editor.config

    // 信号

    this.editor.signals.startPlayer.add(() => {
      this.historyDisabled = true
    })

    this.editor.signals.stopPlayer.add(() => {
      this.historyDisabled = false
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
    // finally：命令抛出时也要交还，否则此后每一次补帧都以为自己还在这条命令的执行窗口里。
    this.executing = cmd
    try {
      cmd.execute()
    } finally {
      this.executing = null
    }
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

    for (const undo of this.undos) {
      if (Object.prototype.hasOwnProperty.call(undo, "json")) {
        history.undos.push(undo.json)
      }
    }

    // 将重做命令追加到历史记录

    for (const redo of this.redos) {
      if (Object.prototype.hasOwnProperty.call(redo, "json")) {
        history.redos.push(redo.json)
      }
    }

    return history
  }

  fromJSON(json: any) {
    if (json === undefined) return

    for (const cmdJSON of json.undos) {
      const cmd = createCommandByType(this.editor, cmdJSON.type)
      cmd.json = cmdJSON
      cmd.id = cmdJSON.id
      cmd.name = cmdJSON.name
      this.undos.push(cmd)
      this.idCounter = cmdJSON.id > this.idCounter ? cmdJSON.id : this.idCounter // 设置最后使用的 idCounter
    }

    for (const cmdJSON of json.redos) {
      const cmd = createCommandByType(this.editor, cmdJSON.type)
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
      if (!Object.prototype.hasOwnProperty.call(cmd, "json")) {
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
