import type { Editor } from "./Editor"

abstract class Command {
  id: number
  inMemory: boolean
  updatable: boolean
  type: string
  name: string
  editor: Editor
  json?: any
  // 由 History 进行鸭子类型检测，用于跨任意子类的更新合并；
  // 并非每个命令都会用到全部三个属性。
  object?: any
  script?: any
  attributeName?: string

  /**
   * @param {Editor} editor 指向主编辑器对象的指针，用于初始化
   *        每个命令对象，使其持有编辑器的引用
   * @constructor
   */
  constructor(editor: Editor) {
    this.id = -1
    this.inMemory = false
    this.updatable = false
    this.type = ""
    this.name = ""
    this.editor = editor
  }

  abstract execute(): void
  abstract undo(): void
  update(_cmd: Command): void {}

  toJSON(): any {
    const output: any = {}
    output.type = this.type
    output.id = this.id
    output.name = this.name
    return output
  }

  fromJSON(json: any) {
    this.inMemory = true
    this.type = json.type
    this.id = json.id
    this.name = json.name
  }
}

export { Command }
