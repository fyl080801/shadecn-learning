/**
 * `definePlugin` is a thin identity helper used to author prompt-input
 * plugins with full type inference.  It also fills in conventional
 * defaults so callers can keep plugin definitions terse:
 *
 *   const mention = definePlugin({
 *     name: 'mention',
 *     trigger: { key: '@' },
 *     // inline.type defaults to plugin name
 *     // commit defaults to: replace trigger range with createInline(type, data)
 *   })
 *
 *   const { editor, addPlugin } = createEditor()
 *   addPlugin(mention)
 */
import type { PromptPlugin } from './types'
import { Transforms } from './operations'
import { createInline } from './operations'

export const definePlugin = (plugin: PromptPlugin): PromptPlugin => {
  const filled: PromptPlugin = {
    ...plugin,
    inline: {
      type: plugin.inline?.type ?? plugin.name,
      isVoid: plugin.inline?.isVoid ?? true,
      isInline: plugin.inline?.isInline ?? true
    }
  }
  // Provide a sensible default `commit`: replace the trigger range with an
  // inline-void node carrying the picked `data` payload.
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
 * Build the default trigger pattern: `^{escape(key)}(\S*)$` — captures the
 * search term that follows the trigger key up to the next whitespace.
 *
 * Note: `key` is plugin-author-defined configuration (not user input) and is
 * fully escaped via `replace(...)` below, so the `new RegExp` call is safe.
 */
export const defaultTriggerPattern = (key: string): RegExp => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${escaped}(\\S*)$`)
}

/**
 * Resolve a plugin's effective trigger pattern, falling back to the
 * default if `pattern` is omitted.
 */
export const getTriggerPattern = (plugin: PromptPlugin): RegExp | null => {
  if (!plugin.trigger) return null
  return plugin.trigger.pattern ?? defaultTriggerPattern(plugin.trigger.key)
}