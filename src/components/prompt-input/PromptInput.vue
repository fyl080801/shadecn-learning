<script setup lang="ts">
/**
 * PromptInput — generic Slate-style contenteditable editor with a plugin
 * system for inline-void elements and trigger popovers.
 *
 * Slot summary (all are scoped):
 *   - `#element:<name>`     { element, attributes }      inline node renderer
 *   - `#element`            { element, attributes }      fallback renderer
 *   - `#portal:<name>`      { trigger, commit, close, editor }  popover content
 *   - `#footer-action`                                  footer action area
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  useSlots,
  useAttrs,
  Comment
} from "vue"
import {
  Transforms,
  Editor,
  Range,
  initializeEditor,
  getText,
  pointsEqual
} from "./operations"
import { getTriggerPattern } from "./definePlugin"
import { readModelRange, applyDOMRange, toDOMRange } from "./selection"
import { modelToText, textToModel, serializeRange } from "./serialize"
import type {
  Editor as EditorT,
  Paragraph,
  CustomInline,
  PromptPlugin,
  Range as RangeType,
  TriggerContext,
  Descendant
} from "./types"

/**
 * Props
 *
 *   - `modelValue` : the editor's value as a **string**.  Plugins drive how
 *     inline tokens (e.g. `@[name](id)`, `{{Ref 3}}`) round-trip.  Use
 *     `v-model` to two-way bind.
 *   - `placeholder` : shown when the document is empty.
 *
 * The editor never emits its internal `Descendant[]` shape; consumers only
 * deal with strings.
 */
defineOptions({ inheritAttrs: false })

const attrs = useAttrs()

const props = withDefaults(
  defineProps<{
    editor: EditorT
    modelValue?: string
    placeholder?: string
    /** Override the root container classes.  When omitted the default
     *  light-theme utility classes are applied. */
    containerClass?: string
    /** Override the outer wrapper classes (border, background, border-radius).
     *  Useful when footer needs to be inside the visual container. */
    wrapperClass?: string
    /** When true, the editor is read-only (contenteditable="false"). */
    disabled?: boolean
    /** Maximum visible character count (strips \n and zero-width spaces).
     *  null / undefined = no limit, no footer rendered. */
    maxLength?: number | null
    /** Show character counter in footer. Requires maxLength to be set. */
    showCounter?: boolean
    /** Show clear button in footer. */
    showClear?: boolean
    /** 挂载时不自动聚焦 contenteditable，避免画布新建节点后焦点落入输入框导致 Delete 键失效。
     *  用户点击输入区时仍按原生行为一次聚焦。画布配置节点场景启用。 */
    deferFocusOnClick?: boolean
  }>(),
  {
    modelValue: "",
    placeholder: "输入触发字符（如 @）打开菜单…",
    containerClass: undefined,
    wrapperClass: undefined,
    disabled: false,
    maxLength: null,
    showCounter: false,
    showClear: false,
    deferFocusOnClick: false
  }
)

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "change", value: string): void
  (e: "keydown", event: KeyboardEvent): void
  (e: "select", range: RangeType | null): void
  (e: "focus"): void
  (e: "blur"): void
  (e: "trigger-open", ctx: TriggerContext): void
  (e: "trigger-search", ctx: TriggerContext): void
  (e: "trigger-close"): void
  (e: "exceed-limit", currentCount: number, limit: number): void
}>()

const slots = useSlots()

const rootEl = ref<HTMLElement | null>(null)
const composing = ref(false)
const isUpdatingSelection = ref(false)
const isFocused = ref(false)

/**
 * 判断事件是否发生在某个"内联可编辑子区"中（标记 `data-inline-editable`）。
 * 此类子区由插件自行渲染并完全自治输入/键盘/合成事件，外层引擎应当跳过
 * 默认处理，避免重复 preventDefault 把插件的输入吞掉。
 */
const isInsideEditableInline = (event: Event): boolean => {
  const t = event.target as HTMLElement | null
  if (!t || typeof t.closest !== "function") return false
  return !!t.closest("[data-inline-editable]")
}

/**
 * 当焦点位于"内联可编辑子区"内时，外层 model 的 selection 应锁定到该
 * inline 节点的"前后某个文本叶"，以便外层光标定位、删除合并等操作
 * 把整个块当作一个原子。我们这里只用作判定，真实的 model selection
 * 由 PromptInput 通过 `selectionchange` 事件正常读取（DOM 选区在子区
 * 内时 `toModelPoint` 会向上找到 void-path 并解析到相邻文本叶）。
 */

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

// --- character counting & maxLength enforcement ----------------------------

const ZERO_WIDTH_SPACE = "\u200B"
const ZERO_WIDTH_REGEX = new RegExp(ZERO_WIDTH_SPACE, "g")

const INPUT_LIMIT_TIP_TEXT = "输入内容超过最大限制，已被忽略"
const PASTE_TRUNCATE_TIP_TEXT = "粘贴内容超过最大限制，已被截断"
const LIMIT_TIP_DURATION = 3000

/** Count visible characters (strips \n and zero-width spaces). */
function getVisibleCharCount(text: string): number {
  return text.replace(/\n/g, "").replace(ZERO_WIDTH_REGEX, "").length
}

/** Cached serialized text from the revision watcher — avoids double traversal. */
const serializedText = ref("")

/** Current visible character count based on the editor model. */
const charCount = computed(() => getVisibleCharCount(serializedText.value))

/** Count visible characters in the current selection. */
function getSelectedVisibleCharCount(): number {
  const sel = props.editor.selection
  if (!sel || Range.isCollapsed(sel)) return 0
  const selectedText = serializeRange(props.editor.children, sel, plugins.value)
  return getVisibleCharCount(selectedText)
}

/**
 * Truncate `insertText` so that after insertion the visible character count
 * does not exceed `limit`.  Accounts for selected text being replaced.
 */
function truncateToMaxLength(
  insertText: string,
  currentCount: number,
  selectedCount: number,
  limit: number
): { text: string; truncated: boolean } {
  const available = limit - currentCount + selectedCount
  if (available <= 0) return { text: "", truncated: insertText.length > 0 }
  let visibleCount = 0
  for (let i = 0; i < insertText.length; i += 1) {
    const ch = insertText[i]
    if (ch === "\n" || ch === ZERO_WIDTH_SPACE) continue
    visibleCount += 1
    if (visibleCount > available) {
      return { text: insertText.slice(0, i), truncated: true }
    }
  }
  return { text: insertText, truncated: false }
}

// --- limit tip state -------------------------------------------------------

const limitTipVisible = ref(false)
const limitTipText = ref("")
let limitTipTimer: ReturnType<typeof setTimeout> | null = null

function showLimitTip(message: string) {
  if (limitTipVisible.value && limitTipText.value === message) return
  limitTipText.value = message
  limitTipVisible.value = true
  if (limitTipTimer) {
    clearTimeout(limitTipTimer)
  }
  limitTipTimer = setTimeout(() => {
    limitTipVisible.value = false
    limitTipTimer = null
  }, LIMIT_TIP_DURATION)
}

// --- footer helpers --------------------------------------------------------

/**
 * 判断 footer-action 槽位是否实际渲染了内容。
 * 仅检查 `slots['footer-action']` 函数是否存在是不够的——父组件声明了
 * `<template #footer-action>` 但内部用 `v-if` 条件渲染时，槽位函数始终
 * 存在，只是返回 Comment 占位节点。这里调用槽位函数并过滤掉 Comment
 * 节点来判断是否有有效内容。
 */
const hasFooterActionContent = computed(() => {
  const fn = slots["footer-action"]
  if (!fn) return false
  const vnodes = fn()
  return vnodes.some((v) => v.type !== Comment)
})

const hasFooter = computed(
  () =>
    props.maxLength != null &&
    (props.showCounter || hasFooterActionContent.value || limitTipVisible.value)
)

function handleClear() {
  if (props.disabled) return
  initializeEditor(props.editor, textToModel("", plugins.value))
  lastEmittedText = ""
  serializedText.value = ""
  nextTick(() => rootEl.value?.focus())
}

// --- selection bridge --------------------------------------------------

const applyModelSelectionToDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  // 延迟聚焦模式：未聚焦时不主动写 DOM 选区，避免浏览器自动聚焦 contenteditable
  if (props.deferFocusOnClick && !isFocused.value) return
  // 若当前焦点位于内联可编辑子区，外层不再覆盖 DOM 选区，避免抢走插件光标。
  const active = document.activeElement as HTMLElement | null
  if (active && active.closest && active.closest("[data-inline-editable]")) {
    return
  }
  isUpdatingSelection.value = true
  applyDOMRange(root, props.editor.selection)
  setTimeout(() => {
    isUpdatingSelection.value = false
  }, 0)
}

const sameRange = (a: RangeType | null, b: RangeType | null): boolean => {
  if (!a || !b) return a === b
  return pointsEqual(a.anchor, b.anchor) && pointsEqual(a.focus, b.focus)
}

const flushSelectionFromDOM = (): void => {
  if (isUpdatingSelection.value || composing.value) return
  if (!isFocused.value) return
  const root = rootEl.value
  if (!root) return
  // 若 DOM 焦点位于内联可编辑子区，外层不再读取这一选区为 model selection。
  const active = document.activeElement as HTMLElement | null
  if (active && active.closest && active.closest("[data-inline-editable]")) {
    return
  }
  const range = readModelRange(root)
  if (!range) return
  const editor = props.editor
  if (!sameRange(editor.selection, range)) {
    editor.selection = range
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

/**
 * Last value we emitted via `update:modelValue`.  We use it to:
 *   1. avoid emitting an event when the value hasn't actually changed, and
 *   2. detect when an externally-set `modelValue` is *different* from what
 *      the editor currently holds, so we can rebuild the model — without
 *      this guard a parent that forwards `update:modelValue` straight back
 *      via `v-model` would create a write-loop.
 */
let lastEmittedText = ""

/**
 * Reference to the `editor.children` array at the time of the last
 * serialization.  When `revision` bumps but `children` hasn't changed
 * (i.e. a selection-only commit), we skip the O(n) `modelToText` traversal.
 */
let lastSerializedChildren: Descendant[] | null = null

const buildInitialModel = (): Descendant[] =>
  textToModel(props.modelValue ?? "", plugins.value)

onMounted(() => {
  const initial = buildInitialModel()
  initializeEditor(props.editor, initial)
  // Seed the cache so the first revision change does not spuriously emit.
  const initialText = modelToText(props.editor.children, plugins.value)
  lastEmittedText = initialText
  serializedText.value = initialText
  lastSerializedChildren = props.editor.children
  onDocumentSelectionChange = () => {
    if (!isFocused.value) return
    flushSelectionFromDOM()
  }
  document.addEventListener("selectionchange", onDocumentSelectionChange)
  nextTick(() => {
    // 延迟聚焦模式：挂载时不主动设置 DOM 选区，避免浏览器自动聚焦 contenteditable
    if (rootEl.value && !props.deferFocusOnClick) {
      applyDOMRange(rootEl.value, props.editor.selection)
    }
  })
})

onBeforeUnmount(() => {
  if (onDocumentSelectionChange) {
    document.removeEventListener("selectionchange", onDocumentSelectionChange)
  }
  if (limitTipTimer) {
    clearTimeout(limitTipTimer)
    limitTipTimer = null
  }
})

// Sync model -> DOM on every revision bump and run trigger detection.
// positionPopover is intentionally NOT called here — watch(activeTrigger) handles it
// whenever the trigger state changes (open / search update / close).
watch(
  () => props.editor.revision,
  () => {
    nextTick(() => {
      applyModelSelectionToDOM()
      // Skip serialization when only selection changed (children reference unchanged).
      if (props.editor.children !== lastSerializedChildren) {
        lastSerializedChildren = props.editor.children
        const text = modelToText(props.editor.children, plugins.value)
        serializedText.value = text
        if (text !== lastEmittedText) {
          lastEmittedText = text
          emit("update:modelValue", text)
          emit("change", text)
        }
      }
      detectTrigger()
    })
  }
)

// External value changes: rebuild the model only when the new value
// differs from what we last emitted (otherwise the parent's v-model echo
// would re-initialise on every keystroke and wipe the caret).
watch(
  () => props.modelValue,
  (next) => {
    const incoming = next ?? ""
    if (incoming === lastEmittedText) return
    lastEmittedText = incoming
    serializedText.value = incoming
    initializeEditor(props.editor, textToModel(incoming, plugins.value))
    lastSerializedChildren = props.editor.children
  }
)

// --- wrapper click (forwards focus when clicking outside the editable) ---

const onWrapperClick = (e: MouseEvent): void => {
  if (props.disabled) return
  const target = e.target as Node
  if (rootEl.value && !rootEl.value.contains(target)) {
    rootEl.value.focus()
  }
}

// --- focus / blur ------------------------------------------------------

const onFocus = (): void => {
  isFocused.value = true
  if (rootEl.value && props.editor.selection) {
    applyModelSelectionToDOM()
  }
  emit("focus")
}

const onBlur = (e: FocusEvent): void => {
  // 当焦点切到内联可编辑子区时不应视作失焦——它们仍在编辑器内部。
  const next = e.relatedTarget as HTMLElement | null
  if (next && rootEl.value && rootEl.value.contains(next)) {
    return
  }
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
  // 内联可编辑子区自治：插件自行处理输入，避免外层 preventDefault 吞事件。
  if (isInsideEditableInline(event)) return
  flushSelectionFromDOM()

  const type = event.inputType
  const data = event.data ?? ""

  switch (type) {
    case "insertText": {
      event.preventDefault()
      const limit = props.maxLength
      let textToInsert = data
      let wasTruncated = false
      if (limit != null && limit > 0) {
        const result = truncateToMaxLength(
          data,
          charCount.value,
          getSelectedVisibleCharCount(),
          limit
        )
        textToInsert = result.text
        wasTruncated = result.truncated
      }
      if (textToInsert) {
        Transforms.insertText(props.editor, textToInsert)
      }
      if (wasTruncated) {
        showLimitTip(INPUT_LIMIT_TIP_TEXT)
        emit("exceed-limit", charCount.value, limit!)
      }
      break
    }
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
    case "historyUndo":
      event.preventDefault()
      props.editor.undo()
      break
    case "historyRedo":
      event.preventDefault()
      props.editor.redo()
      break
    default:
      break
  }
}

// --- IME composition ---------------------------------------------------

const onCompositionStart = (event: CompositionEvent): void => {
  if (isInsideEditableInline(event)) return
  composing.value = true
}

const onCompositionEnd = (event: CompositionEvent): void => {
  if (isInsideEditableInline(event)) return
  composing.value = false
  const limit = props.maxLength
  if (event.data && limit != null && limit > 0) {
    // Composition replaces in-progress text, not a model selection,
    // so selectedCount is 0 and currentCount already reflects the
    // pre-composition model state.
    const result = truncateToMaxLength(event.data, charCount.value, 0, limit)
    if (result.truncated) {
      showLimitTip(INPUT_LIMIT_TIP_TEXT)
      emit("exceed-limit", charCount.value, limit)
    }
    if (result.text) {
      Transforms.insertText(props.editor, result.text)
    }
    // If the composition result was partially truncated, the DOM may
    // still contain the full composition text — sync the leaf to
    // discard the extra characters.
    if (result.text !== event.data) {
      syncCurrentLeafFromDOM()
    }
  } else if (event.data) {
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

/**
 * Detect "the caret sits in an empty text leaf glued to an inline-void
 * sibling" — the situation where a single ArrowLeft/ArrowRight visually
 * does nothing because the browser stops on the zero-width FEFF char.
 *
 * Returns the desired post-move model point, or `null` if no special
 * handling is needed (let the browser do its thing).
 */
const inlineHopTarget = (
  reverse: boolean
): { path: number[]; offset: number } | null => {
  const editor = props.editor
  const sel = editor.selection
  if (!sel || !Range.isCollapsed(sel)) return null
  const { path, offset } = sel.anchor
  if (path.length < 2) return null
  const [bi, ii] = path as [number, number]
  const block = editor.children[bi]
  if (!block || !("children" in block)) return null
  const blockChildren = (block as Paragraph).children
  const leaf = blockChildren[ii]
  if (!leaf || "children" in leaf) return null
  const leafText = (leaf as { text: string }).text

  if (reverse) {
    // Hop left over an inline that lives right before the current leaf
    // when the caret sits at the leaf's start.
    if (offset !== 0) return null
    const prev = blockChildren[ii - 1]
    if (!prev || !("children" in prev)) return null
    if ((prev as { type?: string }).type === undefined) return null
    // Land at the end of the text leaf preceding the inline (which
    // normalisation guarantees to exist).
    const beforeIdx = ii - 2
    if (beforeIdx < 0) return null
    const beforeLeaf = blockChildren[beforeIdx]
    if (!beforeLeaf || "children" in beforeLeaf) return null
    return {
      path: [bi, beforeIdx],
      offset: (beforeLeaf as { text: string }).text.length
    }
  } else {
    // Hop right over an inline that lives right after the current leaf
    // when the caret sits at the leaf's end.
    if (offset !== leafText.length) return null
    const next = blockChildren[ii + 1]
    if (!next || !("children" in next)) return null
    if ((next as { type?: string }).type === undefined) return null
    const afterIdx = ii + 2
    if (afterIdx >= blockChildren.length) return null
    const afterLeaf = blockChildren[afterIdx]
    if (!afterLeaf || "children" in afterLeaf) return null
    return { path: [bi, afterIdx], offset: 0 }
  }
}

const isUndoCombo = (e: KeyboardEvent): boolean =>
  (e.metaKey || e.ctrlKey) &&
  !e.shiftKey &&
  !e.altKey &&
  e.key.toLowerCase() === "z"

const isRedoCombo = (e: KeyboardEvent): boolean => {
  if (e.altKey) return false
  // Ctrl+Y on Win/Linux, Shift+Cmd+Z on macOS, Shift+Ctrl+Z everywhere.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
    return true
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "y")
    return true
  return false
}

const onKeydown = (e: KeyboardEvent): void => {
  // 内联可编辑子区自治：插件自行决定键盘行为。
  if (isInsideEditableInline(e)) {
    emit("keydown", e)
    return
  }
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

  // Undo / redo — wired to the editor's history stack.  We have to take
  // over here because the browser's native contenteditable undo would
  // mutate the DOM out from under our model.
  if (isRedoCombo(e)) {
    e.preventDefault()
    props.editor.redo()
    emit("keydown", e)
    return
  }
  if (isUndoCombo(e)) {
    e.preventDefault()
    props.editor.undo()
    emit("keydown", e)
    return
  }

  // ArrowLeft / ArrowRight: jump over an inline-void in one keystroke
  // when the caret would otherwise visually stall on the zero-width
  // FEFF filler that lives in the empty text leaf adjacent to the
  // inline.  We only intercept the *single-step* unmodified arrow keys
  // so that Shift-selection / Option-skip-by-word keep the browser's
  // native behaviour.
  if (
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight")
  ) {
    const target = inlineHopTarget(e.key === "ArrowLeft")
    if (target) {
      e.preventDefault()
      Transforms.select(props.editor, {
        anchor: { path: target.path, offset: target.offset },
        focus: { path: target.path, offset: target.offset }
      })
      return
    }
  }

  emit("keydown", e)
}

const onPaste = (e: ClipboardEvent): void => {
  if (composing.value) return
  if (isInsideEditableInline(e)) return
  const text = e.clipboardData?.getData("text/plain")
  if (text == null) return
  e.preventDefault()
  flushSelectionFromDOM()
  const limit = props.maxLength
  if (limit != null && limit > 0) {
    const result = truncateToMaxLength(
      text,
      charCount.value,
      getSelectedVisibleCharCount(),
      limit
    )
    if (result.truncated) {
      showLimitTip(PASTE_TRUNCATE_TIP_TEXT)
      emit("exceed-limit", charCount.value, limit)
    }
    insertSerializedText(result.text)
  } else {
    insertSerializedText(text)
  }
}

/**
 * 把"真实字符串"粘贴回编辑器：先用 plugin.parse（textToModel）把字符串
 * 还原成 Descendant[]，再按段落顺序插回光标位置。
 *
 * 实现要点：
 *  - 段间换行（"\n\n"）：`Transforms.splitBlock()`，新段为空、光标在段首，
 *    下一段内容直接续插即可，保持段落正向顺序。
 *  - 段内纯文本片段：走 `Transforms.insertText`，单换行 `\n` 作为普通文本
 *    进入 leaf，与 `modelToText` 输出对齐。
 *  - 段内 inline 节点：单独调用 `Transforms.insertNodes`，引擎会把光标
 *    精确放到 inline 之后的空文本叶起点，便于续接下一片段。
 *  逐项串行避免一次性插入混合数组时因光标推算误差导致的段落顺序错位。
 */
const insertSerializedText = (text: string): void => {
  if (!text) return
  const fragment = textToModel(text, plugins.value)
  // Collapse the entire paste — which may emit many insertText /
  // insertNodes / splitBlock calls — into a single history entry so
  // Ctrl+Z rolls back the whole paste at once instead of peeling it
  // off one fragment item at a time.
  props.editor.batch(() => {
    for (let i = 0; i < fragment.length; i++) {
      const block = fragment[i]
      if (
        !block ||
        !("children" in block) ||
        (block as { type?: string }).type !== "paragraph"
      ) {
        continue
      }
      const children = (block as Paragraph).children
      for (const child of children) {
        if ("children" in child) {
          Transforms.insertNodes(props.editor, child as Descendant)
        } else {
          const t = (child as { text: string }).text
          if (t !== "") Transforms.insertText(props.editor, t)
        }
      }
      if (i < fragment.length - 1) {
        Transforms.splitBlock(props.editor)
      }
    }
  })
}

// --- copy / cut / drag (real-string serialization) ---------------------

/**
 * 把当前模型选区序列化为"真实字符串"——即 plugin.serialize 输出的源串
 * （如 `@[name](id)`、`{{Ref 1}}`），而不是 DOM 上的可视展示文本。
 *
 * 返回 null 表示无可复制内容（选区为空/折叠/位于自治子区内）。
 */
const serializeSelection = (): string | null => {
  flushSelectionFromDOM()
  const sel = props.editor.selection
  if (!sel || Range.isCollapsed(sel)) return null
  const out = serializeRange(props.editor.children, sel, plugins.value)
  return out.length > 0 ? out : null
}

const writeSelectionToClipboard = (e: ClipboardEvent): boolean => {
  if (composing.value) return false
  // 内联可编辑子区自治：复制行为交给浏览器原生，子区文本即源文本。
  if (isInsideEditableInline(e)) return false
  const text = serializeSelection()
  if (text == null) return false
  const cd = e.clipboardData
  if (!cd) return false
  e.preventDefault()
  cd.setData("text/plain", text)
  return true
}

const onCopy = (e: ClipboardEvent): void => {
  writeSelectionToClipboard(e)
}

const onCut = (e: ClipboardEvent): void => {
  // 写入剪贴板后再删除选区，确保 undo 仍可回滚此次删除。
  if (writeSelectionToClipboard(e)) Transforms.delete(props.editor)
}

const onDragStart = (e: DragEvent): void => {
  if (composing.value) return
  if (isInsideEditableInline(e)) return
  const text = serializeSelection()
  if (text == null) return
  const dt = e.dataTransfer
  if (!dt) return
  dt.setData("text/plain", text)
  // 不 preventDefault：保留浏览器默认拖拽视觉。
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
  "data-void-path": JSON.stringify(path),
  contenteditable: "false"
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

const commitForActive = (payload: {
  range?: RangeType
  data: unknown
}): void => {
  const trigger = activeTrigger.value
  if (!trigger) return
  const plugin = plugins.value.find((p) => p.name === trigger.name)
  if (!plugin?.commit) return
  const limit = props.maxLength
  plugin.commit(props.editor, {
    range: payload.range ?? trigger.range,
    data: payload.data
  })
  closeTrigger()
  // Post-commit limit check: if the commit pushed us over, undo it.
  if (limit != null && limit > 0 && charCount.value > limit) {
    props.editor.undo()
    showLimitTip(INPUT_LIMIT_TIP_TEXT)
    emit("exceed-limit", charCount.value, limit)
  }
}

defineExpose({
  editor: props.editor,
  /** The contenteditable root element (NOT the wrapper). */
  editableEl: rootEl,
  /** Current visible character count. */
  charCount,
  /** Allow external callers to trigger the limit tip. */
  showLimitTip,
  toDOMRange: (range: RangeType) =>
    rootEl.value ? toDOMRange(rootEl.value, range) : null,
  closeTrigger,
  /**
   * 返回当前选区对应的"真实字符串"（经 plugin.serialize 还原），
   * 折叠/无选区时返回空串。
   */
  getSelectedText: (): string => serializeSelection() ?? "",
  /** 返回整篇文档的"真实字符串"，等价于当前 modelValue。 */
  getFullText: (): string => modelToText(props.editor.children, plugins.value),
  /** 重新定位 popover（画布场景视口变化时由外部调用）。 */
  repositionPopover: positionPopover,
  /** 聚焦编辑区。 */
  focus: () => rootEl.value?.focus()
})
</script>

<template>
  <div
    :class="[
      'prompt-input',
      'relative w-full flex flex-col',
      props.wrapperClass,
      isFocused && 'prompt-input-focused'
    ]"
    v-bind="attrs"
    @click="onWrapperClick"
  >
    <div
      ref="rootEl"
      :contenteditable="!props.disabled"
      role="textbox"
      :aria-disabled="props.disabled ? 'true' : undefined"
      spellcheck="false"
      data-cy="prompt-input"
      data-slate-editor="true"
      data-slate-node="value"
      :data-placeholder="placeholder"
      :class="[
        props.containerClass ?? [
          'relative min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm leading-7 cursor-text',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'whitespace-pre-wrap',
          isDocumentEmpty &&
            !isFocused &&
            'before:content-[attr(data-placeholder)] before:text-muted-foreground before:pointer-events-none before:absolute before:left-3 before:top-3 before:leading-7'
        ],
        hasFooter ? 'flex-1 min-h-0' : 'flex-1'
      ]"
      @beforeinput="onBeforeInput"
      @keydown="onKeydown"
      @click="onClick"
      @focus="onFocus"
      @blur="onBlur"
      @paste="onPaste"
      @copy="onCopy"
      @cut="onCut"
      @dragstart="onDragStart"
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
                  >&#xFEFF;<br
                /></span>
                <span v-else data-slate-zero-width="z" data-slate-length="0"
                  >&#xFEFF;</span
                >
              </template>
              <span
                v-else
                data-slate-string="true"
                style="white-space: pre-wrap"
                >{{ (child as { text: string }).text }}</span
              >
            </span>
          </span>
        </template>
      </div>
    </div>

    <!-- Footer: character counter, clear button, limit tip, and footer-action slot -->
    <div
      v-if="hasFooter"
      class="prompt-input-footer shrink-0 flex items-stretch justify-between rounded-b-md px-3 py-2"
    >
      <div class="flex min-w-0 flex-1 items-center">
        <span
          v-if="limitTipVisible"
          class="pointer-events-none truncate text-xs text-destructive"
        >
          {{ limitTipText }}
        </span>
        <div
          v-else-if="showCounter"
          class="flex items-center gap-x-0.5 text-xs text-muted-foreground"
        >
          <span class="pointer-events-none min-w-[3.75rem] text-left"
            >{{ charCount }} / {{ maxLength }}</span
          >
          <span
            v-if="showClear && charCount > 0"
            class="mx-1 h-3 w-px bg-border"
            aria-hidden="true"
          ></span>
          <button
            v-if="showClear && charCount > 0"
            type="button"
            class="pointer-events-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
            :disabled="props.disabled"
            aria-label="清空内容"
            @click="handleClear"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <span v-else aria-hidden="true"></span>
      </div>
      <div class="flex items-center">
        <slot name="footer-action" />
      </div>
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

<style scoped>
.prompt-input {
  font-size: 14px;
  border: 1px solid hsl(var(--border));
  cursor: text;
}

.prompt-input-focused {
  box-shadow: 0 0 0 1px hsl(var(--border));
}

/* Align text leaves with inline-void elements (badges use vertical-align: middle).
   Without this, plain text sits on the baseline while badges are middle-aligned,
   causing the plain text to appear slightly higher than the badge's internal text. */
.prompt-input :deep([data-slate-node="text"]) {
  vertical-align: middle;
}
</style>
