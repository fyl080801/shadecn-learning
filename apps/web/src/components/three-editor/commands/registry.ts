import type { Command } from "../Command"
import type { Editor } from "../Editor"

/**
 * 命令类型注册表：按 `cmd.type` 反序列化命令。
 *
 * 叶子模块 —— 上面两条都是 `import type`，编译后一条 import 都不剩。
 * 组合命令（`MultiCmdsCommand`、`SetSceneCommand`）要按类型新建任意一种命令，
 * 包括它自己；以前它们直接 `import * as Commands from "./Commands"`，而 `Commands.ts`
 * 又 re-export 它们，于是成环。现在它们只引这里，由 `Commands.ts` 把全部命令登记进来。
 */
type CommandClass = new (editor: Editor) => Command

const commandClasses = new Map<string, CommandClass>()

function registerCommandClasses(classes: Record<string, CommandClass>) {
  for (const [type, CommandClass] of Object.entries(classes)) {
    commandClasses.set(type, CommandClass)
  }
}

/** 创建一个 `type` 类型的空命令，字段由随后的 `fromJSON` 恢复 */
function createCommandByType(editor: Editor, type: string): Command {
  const CommandClass = commandClasses.get(type)
  if (!CommandClass) throw new Error(`[three-editor] 未知的命令类型：${type}`)
  return new CommandClass(editor)
}

export { registerCommandClasses, createCommandByType }
