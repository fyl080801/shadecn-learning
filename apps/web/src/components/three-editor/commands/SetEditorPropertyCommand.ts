import { Command } from "../Command"
import type { Editor } from "../Editor"

/**
 * 编辑器级属性的通用历史命令。
 *
 * 现有 Set*Command 均以单个 THREE.Object3D 的某个属性为目标；而"编辑器级"
 * 属性（如导演台的舞台变换：scene 与地面网格 grid 联动）没有唯一的宿主对象，
 * 应用逻辑属于各消费方（three-editor / director）自己的领域知识。这里把
 * "如何读写"外置为按 key 注册的 handler，命令本身只负责 old/new 值的快照、
 * 连续编辑合并（History 按 attributeName 做可更新合并）与撤销/重做，
 * 二次开发方新增可撤销属性时注册一个 handler 即可，无需再新建命令类。
 *
 * 约束：value 必须是可 JSON 序列化的普通数据（number/string/plain object），
 * 以兼容 History 的 toJSON/fromJSON 持久化；不要传 THREE 对象引用。
 */
export interface EditorPropertyHandler<T = any> {
  /** 历史条目显示名（撤销菜单等场景），缺省使用 key */
  label?: string
  /** 读取当前值，作为命令构造时的 oldValue 快照 */
  get(editor: Editor): T
  /** 应用值；sceneGraphChanged 由命令统一派发，如需其它信号在此自行派发 */
  set(editor: Editor, value: T): void
}

// 模块级注册表：handler 是无状态的读写胶水（editor 由调用时传入），
// 无需按 Editor 实例隔离；同 key 重复注册以最后一次为准（HMR 安全）。
const handlers = new Map<string, EditorPropertyHandler>()

export function registerEditorProperty<T>(
  key: string,
  handler: EditorPropertyHandler<T>
) {
  handlers.set(key, handler)
}

function resolveHandler(key: string): EditorPropertyHandler {
  const handler = handlers.get(key)
  if (!handler) {
    throw new Error(
      `SetEditorPropertyCommand: 属性 "${key}" 未注册，请先调用 registerEditorProperty`
    )
  }
  return handler
}

class SetEditorPropertyCommand extends Command {
  propertyKey: string
  oldValue: any
  newValue: any

  /**
   * @param editor
   * @param propertyKey 已通过 registerEditorProperty 注册的属性 key
   * @param newValue 可 JSON 序列化的新值
   * @param optionalOldValue 缺省时取 handler.get(editor) 的当前值
   */
  constructor(
    editor: Editor,
    propertyKey = "",
    newValue: any = null,
    optionalOldValue: any = null
  ) {
    super(editor)

    this.type = "SetEditorPropertyCommand"
    this.updatable = true

    this.propertyKey = propertyKey
    // History.execute 的可更新合并按 attributeName 鸭子类型匹配，
    // 复用该字段使同一属性的连续编辑（滑杆拖动）合并为一条历史。
    this.attributeName = propertyKey

    // structuredClone 隔离调用方后续对同一引用的改写，保证快照不被污染
    this.newValue = structuredClone(newValue)

    // History.fromJSON 反序列化时以无参形式构造（propertyKey 为空），
    // 此时跳过 handler 解析，字段由随后的 fromJSON 恢复。
    if (propertyKey !== "") {
      const handler = resolveHandler(propertyKey)
      this.name = handler.label ?? propertyKey
      this.oldValue =
        optionalOldValue !== null
          ? structuredClone(optionalOldValue)
          : structuredClone(handler.get(editor))
    }
  }

  execute() {
    resolveHandler(this.propertyKey).set(this.editor, this.newValue)
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  undo() {
    resolveHandler(this.propertyKey).set(this.editor, this.oldValue)
    this.editor.signals.sceneGraphChanged.dispatch()
  }

  update(command: SetEditorPropertyCommand) {
    this.newValue = structuredClone(command.newValue)
  }

  toJSON() {
    const output = super.toJSON()

    output.propertyKey = this.propertyKey
    output.oldValue = this.oldValue
    output.newValue = this.newValue

    return output
  }

  fromJSON(json: any) {
    super.fromJSON(json)

    this.propertyKey = json.propertyKey
    this.attributeName = json.propertyKey
    this.oldValue = json.oldValue
    this.newValue = json.newValue
  }
}

export { SetEditorPropertyCommand }
