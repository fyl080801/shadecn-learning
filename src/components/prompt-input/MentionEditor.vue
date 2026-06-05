<script setup lang="ts">
/**
 * MentionEditor — Vue analogue of Slate's <Slate> + <Editable>.
 *
 * Design (mirrors slate-react's DOM exactly):
 *   - The `editor` is the single source of truth.
 *   - Each block paragraph renders as:
 *       <div data-slate-node="element" data-block-path="[bi]">
 *         ...children...
 *       </div>
 *   - Each text leaf renders as:
 *       <span data-slate-node="text">
 *         <span data-slate-leaf="true" data-leaf-path="[bi,ii]">
 *           <span data-slate-string="true">text</span>     ← when non-empty
 *           OR
 *           <span data-slate-zero-width="z|n" data-slate-length="0">
 *             ﻿ (U+FEFF)
 *             <br/>  ← only when this is an empty block's only leaf
 *           </span>
 *         </span>
 *       </span>
 *   - Mentions are inline voids; the caret never lives inside them
 *     (it lives in the surrounding empty text leaves the normalizer
 *     guarantees).
 *
 * The zero-width FEFF + <br> in empty paragraphs is what gives the
 * empty paragraph a visible height in the browser; without it, hitting
 * Enter at the end of the document looks like "nothing happened".
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from "vue"
import { Transforms, initializeEditor, getText } from "./operations"
import { readModelRange, applyDOMRange, toDOMRange } from "./selection"
import MentionElement from "./MentionElement.vue"
import type {
  Descendant,
  Editor,
  Mention,
  Paragraph,
  Range as RangeType
} from "./types"

const props = withDefaults(
  defineProps<{
    editor: Editor
    initialValue: Descendant[]
    placeholder?: string
  }>(),
  { placeholder: "输入 @ 触发提及…" }
)

const emit = defineEmits<{
  (e: "change", value: Descendant[]): void
  (e: "keydown", event: KeyboardEvent): void
  (e: "select", range: RangeType | null): void
  (e: "focus"): void
  (e: "blur"): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const composing = ref(false)

const isUpdatingSelection = ref(false)
const isFocused = ref(false)

const applyModelSelectionToDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  isUpdatingSelection.value = true
  applyDOMRange(root, props.editor.selection)
  // Clear the flag on a macrotask so the document's selectionchange
  // (a microtask) sees the flag as set and skips the bounce-back.
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

// Sync model -> DOM on every revision bump.
watch(
  () => props.editor.revision,
  () => {
    nextTick(() => {
      applyModelSelectionToDOM()
      emit("change", props.editor.children)
    })
  }
)

// --- focus / blur ---

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
  nextTick(() => flushSelectionFromDOM())
}

// --- beforeinput ---

const onBeforeInput = (event: InputEvent): void => {
  if (composing.value) return
  // Sync DOM selection → model BEFORE applying the operation.
  flushSelectionFromDOM()

  const type = event.inputType
  const data = event.data ?? ""

  switch (type) {
    case "insertText":
      event.preventDefault()
      Transforms.insertText(props.editor, data)
      break
    case "insertCompositionText":
      // Let IME run; we'll sync on compositionend.
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
    case "insertFromPaste": {
      // Handled in onPaste; just prevent default here for safety.
      event.preventDefault()
      break
    }
    default:
      break
  }
}

// --- IME composition ---

const onCompositionStart = (): void => {
  composing.value = true
}

const onCompositionEnd = (event: CompositionEvent): void => {
  composing.value = false
  // Insert the composed text into the model so the leaf stays in sync.
  // Some browsers (Safari) already insert the text natively before
  // compositionend; clear the DOM-side change by re-applying the model.
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
      // The text content lives inside the inner [data-slate-string] span.
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

// --- keyboard ---

const onKeydown = (e: KeyboardEvent): void => {
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

// --- rendering helpers ---

const isMention = (n: Descendant): n is Mention =>
  "type" in n && n.type === "mention"

const isParaEmpty = (block: Paragraph): boolean => {
  // A paragraph is "empty" if it contains no mentions and the only
  // text leaf has empty text (slate uses this to render the line
  // break placeholder so the empty line keeps its height).
  const c = block.children
  if (c.length === 1) {
    const only = c[0]
    return !!only && !("children" in only) && (only as { text: string }).text === ""
  }
  return false
}

const elementAttrs = (path: number[]) => ({
  "data-slate-node": "element",
  "data-slate-inline": "true",
  "data-slate-void": "true",
  "data-void-path": JSON.stringify(path)
})

const isDocumentEmpty = computed(() => {
  const c = props.editor.children
  if (c.length === 0) return true
  if (c.length > 1) return false
  const block = c[0]
  if (!block || !("children" in block)) return false
  const p = block as Paragraph
  return isParaEmpty(p)
})

defineExpose({
  editor: props.editor,
  toDOMRange: (range: RangeType) =>
    rootEl.value ? toDOMRange(rootEl.value, range) : null
})
</script>

<template>
  <div
    ref="rootEl"
    contenteditable="true"
    spellcheck="false"
    data-cy="mention-editor"
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
        <slot
          v-if="isMention(child)"
          name="element"
          :attributes="elementAttrs([bi, ci])"
          :element="child"
        >
          <MentionElement
            :attributes="elementAttrs([bi, ci])"
            :element="child"
          />
        </slot>
        <!-- Text leaf: slate-style nested wrappers.
             - Empty leaf in an empty paragraph  → zero-width "n" + <br>
             - Empty leaf next to/around an inline → zero-width "z"
             - Non-empty leaf                     → data-slate-string  -->
        <span
          v-else
          data-slate-node="text"
        >
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
</template>