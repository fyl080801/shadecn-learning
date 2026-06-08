<script setup lang="ts">
/**
 * PromptInput — generic Slate-style contenteditable editor with a plugin
 * system for inline-void elements and trigger popovers.
 *
 * Slot summary (all are scoped):
 *   - `#element:<name>`     { element, attributes }      inline node renderer
 *   - `#element`            { element, attributes }      fallback renderer
 *   - `#portal:<name>`      { trigger, commit, close, editor }  popover content
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  useSlots
} from "vue"
import {
  Transforms,
  Editor,
  Range,
  initializeEditor,
  getText
} from "./operations"
import { getTriggerPattern } from "./definePlugin"
import { readModelRange, applyDOMRange, toDOMRange } from "./selection"
import type {
  Descendant,
  Editor as EditorT,
  Paragraph,
  CustomInline,
  PromptPlugin,
  Range as RangeType,
  TriggerContext
} from "./types"

const props = withDefaults(
  defineProps<{
    editor: EditorT
    initialValue: Descendant[]
    placeholder?: string
  }>(),
  { placeholder: "输入触发字符（如 @）打开菜单…" }
)

const emit = defineEmits<{
  (e: "change", value: Descendant[]): void
  (e: "keydown", event: KeyboardEvent): void
  (e: "select", range: RangeType | null): void
  (e: "focus"): void
  (e: "blur"): void
  (e: "trigger-open", ctx: TriggerContext): void
  (e: "trigger-search", ctx: TriggerContext): void
  (e: "trigger-close"): void
}>()

const slots = useSlots()

const rootEl = ref<HTMLElement | null>(null)
const composing = ref(false)
const isUpdatingSelection = ref(false)
const isFocused = ref(false)

// --- plugin helpers ----------------------------------------------------

const plugins = computed<PromptPlugin[]>(() => {
  const reg = props.editor.__plugins
  return reg ? Array.from(reg.values()) : []
})

const pluginByInlineType = (type: string | undefined): PromptPlugin | null => {
  if (!type) return null
  for (const p of plugins.value) {
    if ((p.inline?.type ?? p.name) === type) return p
  }
  return null
}

// --- selection bridge --------------------------------------------------

const applyModelSelectionToDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  isUpdatingSelection.value = true
  applyDOMRange(root, props.editor.selection)
  setTimeout(() => {
    isUpdatingSelection.value = false
  }, 0)
}

const sameRange = (a: RangeType | null, b: RangeType | null): boolean => {
  if (!a || !b) return a === b
  return (
    a.anchor.offset === b.anchor.offset &&
    a.focus.offset === b.focus.offset &&
    a.anchor.path.length === b.anchor.path.length &&
    a.anchor.path.every((v, i) => v === b.anchor.path[i]) &&
    a.focus.path.length === b.focus.path.length &&
    a.focus.path.every((v, i) => v === b.focus.path[i])
  )
}

const flushSelectionFromDOM = (): void => {
  if (isUpdatingSelection.value || composing.value) return
  if (!isFocused.value) return
  const root = rootEl.value
  if (!root) return
  const range = readModelRange(root)
  if (!range) return
  if (!sameRange(props.editor.selection, range)) {
    props.editor.selection = range
    emit("select", range)
  }
}

// --- trigger detection -------------------------------------------------

const activeTrigger = ref<TriggerContext | null>(null)
const popupStyle = ref<{ top: string; left: string }>({
  top: "-9999px",
  left: "-9999px"
})

const detectTrigger = (): void => {
  const editor = props.editor
  const sel = editor.selection
  if (!sel || !Range.isCollapsed(sel)) {
    closeTrigger()
    return
  }
  const [start] = Range.edges(sel)
  const wordBefore = Editor.before(editor, start, { unit: "word" })
  const before = wordBefore && Editor.before(editor, wordBefore)
  const beforeRange = before && Editor.range(editor, before, start)
  const beforeText = beforeRange && Editor.string(editor, beforeRange)
  const after = Editor.after(editor, start)
  const afterRange = Editor.range(editor, start, after)
  const afterText = Editor.string(editor, afterRange)
  if (!afterText.match(/^(\s|$)/)) {
    closeTrigger()
    return
  }
  if (!beforeText || !beforeRange) {
    closeTrigger()
    return
  }
  // Try each plugin's trigger pattern; first match wins.
  for (const plugin of plugins.value) {
    const pattern = getTriggerPattern(plugin)
    if (!pattern) continue
    const m = beforeText.match(pattern)
    if (m) {
      const search = m[1] ?? ""
      const ctx: TriggerContext = {
        name: plugin.name,
        search,
        range: beforeRange
      }
      const wasOpen = activeTrigger.value?.name === plugin.name
      activeTrigger.value = ctx
      if (wasOpen) emit("trigger-search", ctx)
      else emit("trigger-open", ctx)
      return
    }
  }
  closeTrigger()
}

const closeTrigger = (): void => {
  if (activeTrigger.value) {
    activeTrigger.value = null
    emit("trigger-close")
  }
}

// Re-position popover after every render where a trigger is active.
const positionPopover = async (): Promise<void> => {
  await nextTick()
  const trigger = activeTrigger.value
  const root = rootEl.value
  if (!trigger || !root) return
  const dom = toDOMRange(root, trigger.range)
  if (!dom) return
  const rect = dom.getBoundingClientRect()
  popupStyle.value = {
    top: `${rect.top + window.pageYOffset + 24}px`,
    left: `${rect.left + window.pageXOffset}px`
  }
}

watch(activeTrigger, () => {
  positionPopover()
})

// --- mount / unmount ---------------------------------------------------

let onDocumentSelectionChange: (() => void) | null = null

onMounted(() => {
  initializeEditor(props.editor, props.initialValue)
  onDocumentSelectionChange = () => {
    if (!isFocused.value) return
    flushSelectionFromDOM()
  }
  document.addEventListener("selectionchange", onDocumentSelectionChange)
  nextTick(() => {
    if (rootEl.value) applyDOMRange(rootEl.value, props.editor.selection)
  })
})

onBeforeUnmount(() => {
  if (onDocumentSelectionChange) {
    document.removeEventListener("selectionchange", onDocumentSelectionChange)
  }
})

// Sync model -> DOM on every revision bump and run trigger detection.
watch(
  () => props.editor.revision,
  () => {
    nextTick(() => {
      applyModelSelectionToDOM()
      emit("change", props.editor.children)
      detectTrigger()
      positionPopover()
    })
  }
)

// --- focus / blur ------------------------------------------------------

const onFocus = (): void => {
  isFocused.value = true
  if (rootEl.value && props.editor.selection) {
    applyModelSelectionToDOM()
  }
  emit("focus")
}

const onBlur = (): void => {
  isFocused.value = false
  emit("blur")
}

const onClick = (): void => {
  nextTick(() => {
    flushSelectionFromDOM()
    detectTrigger()
  })
}

// --- beforeinput -------------------------------------------------------

const onBeforeInput = (event: InputEvent): void => {
  if (composing.value) return
  flushSelectionFromDOM()

  const type = event.inputType
  const data = event.data ?? ""

  switch (type) {
    case "insertText":
      event.preventDefault()
      Transforms.insertText(props.editor, data)
      break
    case "insertCompositionText":
      break
    case "deleteContentBackward":
    case "deleteWordBackward":
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      event.preventDefault()
      Transforms.delete(props.editor, { reverse: true })
      break
    case "deleteContentForward":
    case "deleteWordForward":
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      event.preventDefault()
      Transforms.delete(props.editor, { reverse: false })
      break
    case "insertParagraph":
    case "insertLineBreak":
      event.preventDefault()
      Transforms.splitBlock(props.editor)
      break
    case "insertFromPaste":
      event.preventDefault()
      break
    default:
      break
  }
}

// --- IME composition ---------------------------------------------------

const onCompositionStart = (): void => {
  composing.value = true
}

const onCompositionEnd = (event: CompositionEvent): void => {
  composing.value = false
  if (event.data) {
    Transforms.insertText(props.editor, event.data)
  } else {
    syncCurrentLeafFromDOM()
  }
}

const syncCurrentLeafFromDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const dom = sel.getRangeAt(0)
  if (!root.contains(dom.startContainer)) return
  let el: Node | null = dom.startContainer
  if (el.nodeType === Node.TEXT_NODE) el = el.parentNode
  let cur: HTMLElement | null = el as HTMLElement | null
  while (cur && cur !== root) {
    const pathAttr = cur.getAttribute("data-leaf-path")
    if (pathAttr) {
      const path = JSON.parse(pathAttr) as number[]
      const stringEl = cur.querySelector<HTMLElement>("[data-slate-string]")
      const textNode = stringEl?.firstChild
      if (textNode && textNode.textContent != null) {
        const leaf = getText(props.editor, path)
        if (leaf && leaf.text !== textNode.textContent) {
          leaf.text = textNode.textContent
          props.editor.apply()
        }
      }
      return
    }
    cur = cur.parentElement
  }
}

// --- keyboard ----------------------------------------------------------

const onKeydown = (e: KeyboardEvent): void => {
  // Let the active plugin intercept first.
  const trigger = activeTrigger.value
  if (trigger) {
    const plugin = plugins.value.find((p) => p.name === trigger.name)
    if (plugin?.onKeyDown && plugin.onKeyDown(e, trigger)) {
      return
    }
    // Default: Escape closes popover.
    if (e.key === "Escape") {
      e.preventDefault()
      closeTrigger()
      return
    }
  }
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === "z" || e.key === "Z")) {
    if (props.editor.undo) {
      e.preventDefault()
      if (e.shiftKey) props.editor.redo?.()
      else props.editor.undo()
      return
    }
  }
  if (mod && (e.key === "y" || e.key === "Y") && props.editor.redo) {
    e.preventDefault()
    props.editor.redo()
    return
  }
  emit("keydown", e)
}

const onPaste = (e: ClipboardEvent): void => {
  if (composing.value) return
  const text = e.clipboardData?.getData("text/plain")
  if (text == null) return
  e.preventDefault()
  flushSelectionFromDOM()
  Transforms.insertFragmentText(props.editor, text)
}

// --- rendering helpers -------------------------------------------------

const isInline = (n: Descendant): n is CustomInline =>
  "children" in n &&
  (n as { type?: string }).type !== undefined &&
  (n as { type?: string }).type !== "paragraph"

const isParaEmpty = (block: Paragraph): boolean => {
  const c = block.children
  if (c.length === 1) {
    const only = c[0]
    return (
      !!only && !("children" in only) && (only as { text: string }).text === ""
    )
  }
  return false
}

const elementAttrs = (path: number[]) => ({
  "data-slate-node": "element",
  "data-slate-inline": "true",
  "data-slate-void": "true",
  "data-void-path": JSON.stringify(path)
})

const slotForElement = (el: CustomInline): string => {
  const plugin = pluginByInlineType(el.type)
  return plugin ? `element:${plugin.name}` : "element"
}

const isDocumentEmpty = computed(() => {
  const c = props.editor.children
  if (c.length === 0) return true
  if (c.length > 1) return false
  const block = c[0]
  if (!block || !("children" in block)) return false
  const p = block as Paragraph
  return isParaEmpty(p)
})

// --- popover commit helper exposed to slot -----------------------------

const commitForActive = (
  payload: { range?: RangeType; data: unknown }
): void => {
  const trigger = activeTrigger.value
  if (!trigger) return
  const plugin = plugins.value.find((p) => p.name === trigger.name)
  if (!plugin?.commit) return
  plugin.commit(props.editor, {
    range: payload.range ?? trigger.range,
    data: payload.data
  })
  closeTrigger()
}

defineExpose({
  editor: props.editor,
  toDOMRange: (range: RangeType) =>
    rootEl.value ? toDOMRange(rootEl.value, range) : null,
  closeTrigger
})
</script>

<template>
  <div
    ref="rootEl"
    contenteditable="true"
    spellcheck="false"
    data-cy="prompt-input"
    data-slate-editor="true"
    data-slate-node="value"
    :data-placeholder="placeholder"
    :class="[
      'min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm leading-7',
      'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
      'whitespace-pre-wrap',
      isDocumentEmpty &&
        'before:content-[attr(data-placeholder)] before:text-muted-foreground before:pointer-events-none'
    ]"
    @beforeinput="onBeforeInput"
    @keydown="onKeydown"
    @click="onClick"
    @focus="onFocus"
    @blur="onBlur"
    @paste="onPaste"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
  >
    <div
      v-for="(block, bi) in editor.children"
      :key="`block-${bi}`"
      :data-block-path="JSON.stringify([bi])"
      data-slate-node="element"
      class="my-0"
    >
      <template
        v-for="(child, ci) in (block as Paragraph).children"
        :key="`child-${bi}-${ci}`"
      >
        <!-- inline-void element: route to `#element:<plugin>` slot -->
        <slot
          v-if="isInline(child)"
          :name="slotForElement(child as CustomInline)"
          :attributes="elementAttrs([bi, ci])"
          :element="child"
        >
          <!-- generic fallback if neither named slot nor `#element` exists -->
          <slot
            name="element"
            :attributes="elementAttrs([bi, ci])"
            :element="child"
          >
            <span
              v-bind="elementAttrs([bi, ci])"
              contenteditable="false"
              class="px-1 mx-0.5 rounded bg-muted text-xs"
            >
              [{{ (child as CustomInline).type }}]
            </span>
          </slot>
        </slot>
        <!-- text leaf -->
        <span v-else data-slate-node="text">
          <span
            data-slate-leaf="true"
            :data-leaf-path="JSON.stringify([bi, ci])"
          >
            <template v-if="(child as { text: string }).text === ''">
              <span
                v-if="isParaEmpty(block as Paragraph)"
                data-slate-zero-width="n"
                data-slate-length="0"
              >&#xFEFF;<br /></span>
              <span
                v-else
                data-slate-zero-width="z"
                data-slate-length="0"
              >&#xFEFF;</span>
            </template>
            <span
              v-else
              data-slate-string="true"
              style="white-space: pre-wrap;"
            >{{ (child as { text: string }).text }}</span>
          </span>
        </span>
      </template>
    </div>
  </div>

  <!-- Popover portals: one Teleport per plugin that owns the active trigger.
       Only the active plugin's slot actually renders content. -->
  <Teleport
    v-if="activeTrigger && slots[`portal:${activeTrigger.name}`]"
    to="body"
  >
    <div
      data-cy="prompt-portal"
      :style="{
        position: 'absolute',
        top: popupStyle.top,
        left: popupStyle.left,
        zIndex: 1000
      }"
      @mousedown.prevent
    >
      <slot
        :name="`portal:${activeTrigger.name}`"
        :trigger="activeTrigger"
        :commit="commitForActive"
        :close="closeTrigger"
        :editor="editor"
      />
    </div>
  </Teleport>
</template>