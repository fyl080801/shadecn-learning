/**
 * `definePlugin` 是一个轻量的恒等辅助函数，用于编写 prompt-input 插件
 * 并获得完整的类型推断。它还会填充约定俗成的默认值，使调用方的插件
 * 定义保持简洁：
 *
 *   const mention = definePlugin({
 *     name: 'mention',
 *     trigger: { key: '@' },
 *     // inline.type 默认为插件名
 *     // commit 默认行为：用 createInline(type, data) 替换触发范围
 *   })
 *
 *   const { editor, addPlugin } = createEditor()
 *   addPlugin(mention)
 */
import type { PromptPlugin } from "./types"
import { Transforms } from "./operations"
import { createInline } from "./operations"

export const definePlugin = (plugin: PromptPlugin): PromptPlugin => {
  const filled: PromptPlugin = {
    ...plugin,
    inline: {
      type: plugin.inline?.type ?? plugin.name,
      isVoid: plugin.inline?.isVoid ?? true,
      isInline: plugin.inline?.isInline ?? true
    }
  }
  // 提供合理的默认 `commit`：用一个携带所选 `data` 载荷的 inline-void 节点
  // 替换触发范围。
  if (!plugin.commit) {
    const type = filled.inline!.type!
    filled.commit = (editor, { range, data }) => {
      Transforms.select(editor, range)
      Transforms.insertNodes(editor, createInline(type, data))
    }
  }
  return filled
}

/**
 * 构建默认的触发模式：`^{escape(key)}(\S*)$` —— 捕获触发键之后、到下一个
 * 空白字符为止的搜索词。
 *
 * 注意：`key` 是插件作者定义的配置（非用户输入），且已通过下方的
 * `replace(...)` 完整转义，因此 `new RegExp` 调用是安全的。
 */
export const defaultTriggerPattern = (key: string): RegExp => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${escaped}(\\S*)$`)
}

/**
 * 解析插件实际生效的触发模式，当 `pattern` 省略时回退到默认模式。
 */
export const getTriggerPattern = (plugin: PromptPlugin): RegExp | null => {
  if (!plugin.trigger) return null
  return plugin.trigger.pattern ?? defaultTriggerPattern(plugin.trigger.key)
}
