<script setup lang="ts">
/**
 * RichEditor — Vue port of Slate's `mentions.tsx` example.
 *
 * Read this file top-to-bottom and you should recognise every line from
 * https://github.com/ianstormtaylor/slate/blob/main/site/examples/ts/mentions.tsx
 *
 * Differences:
 *   - `useMemo` / `useState` / `useRef` become `ref` / `computed` / `ref`
 *   - `withReact(withHistory(createEditor()))` becomes
 *     `withMentions(withHistory(withReact(createEditor())))`
 *   - `ReactEditor.toDOMRange` becomes our `toDOMRange(editor, range)`
 *   - `<Portal>` is `<Teleport to="body">`
 *   - JSX is Vue's `<template>` syntax
 */
import { computed, onMounted, ref, watch, nextTick } from "vue"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  createEditor,
  withHistory,
  withReact,
  withMentions,
  createText,
  createMention,
  createParagraph,
  Editor,
  Range,
  Transforms,
  initializeEditor,
  toDOMRange,
  characterSource
} from "@/components/mention-editor"
import MentionEditor from "@/components/mention-editor/MentionEditor.vue"
import MentionElement from "@/components/mention-editor/MentionElement.vue"
import type { Descendant, RangeType } from "@/components/mention-editor"

// --- editor instance (mimic React's useMemo) ----------------------------
const editor = withMentions(withHistory(withReact(createEditor())))

// --- trigger state (mimic React's useState) ----------------------------
const target = ref<RangeType | null>(null)
const search = ref("")
const index = ref(0)
const popupStyle = ref({ top: "-9999px", left: "-9999px" })
const popupEl = ref<HTMLElement | null>(null)

// --- mention data --------------------------------------------------------
const chars = computed(() => characterSource(search.value).slice(0, 10))

// --- onChange — detect the @xxx trigger --------------------------------
// 1:1 port of the React example's onChange:
const onChange = (): void => {
  const { selection } = editor
  if (selection && Range.isCollapsed(selection)) {
    const [start] = Range.edges(selection)
    const wordBefore = Editor.before(editor, start, { unit: "word" })
    const before = wordBefore && Editor.before(editor, wordBefore)
    const beforeRange = before && Editor.range(editor, before, start)
    const beforeText = beforeRange && Editor.string(editor, beforeRange)
    const beforeMatch = beforeText && beforeText.match(/^@(\w*)$/)
    const after = Editor.after(editor, start)
    const afterRange = Editor.range(editor, start, after)
    const afterText = Editor.string(editor, afterRange)
    const afterMatch = afterText.match(/^(\s|$)/)
    if (beforeMatch && afterMatch) {
      target.value = beforeRange
      search.value = beforeMatch[1] ?? ""
      index.value = 0
      return
    }
  }
  target.value = null
}

// --- onKeyDown — handle arrow / Tab / Enter / Esc ---------------------
const onKeyDown = (event: KeyboardEvent): void => {
  if (target.value && chars.value.length > 0) {
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault()
        const prev = index.value >= chars.value.length - 1 ? 0 : index.value + 1
        index.value = prev
        break
      }
      case "ArrowUp": {
        event.preventDefault()
        const next = index.value <= 0 ? chars.value.length - 1 : index.value - 1
        index.value = next
        break
      }
      case "Tab":
      case "Enter": {
        event.preventDefault()
        Transforms.select(editor, target.value)
        insertMention(chars.value[index.value]!.character)
        target.value = null
        break
      }
      case "Escape": {
        event.preventDefault()
        target.value = null
        break
      }
    }
    return
  }
  // Popup is closed — handle Enter as a block break.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    Transforms.splitBlock(editor)
  }
}

// --- popup positioning (mimic React's useEffect) ------------------------
watch(
  [
    () => chars.value.length,
    () => search.value,
    () => target.value,
    () => index.value
  ],
  async () => {
    await nextTick()
    if (target.value && chars.value.length > 0 && popupEl.value) {
      const root = document.querySelector<HTMLElement>(
        '[data-cy="mention-editor"]'
      )
      if (!root) return
      const domRange = toDOMRange(root, target.value)
      if (!domRange) return
      const rect = domRange.getBoundingClientRect()
      popupStyle.value = {
        top: `${rect.top + window.pageYOffset + 24}px`,
        left: `${rect.left + window.pageXOffset}px`
      }
    }
  },
  { immediate: true, flush: "post" }
)

// --- mention operations -------------------------------------------------
const insertMention = (character: string): void => {
  // Use the character's slug as the id so the demo can find the chip
  // deterministically.  Slate assigns a random id; we don't expose that
  // here because the consumer doesn't need it.
  const mention = createMention(character)
  Transforms.insertNodes(editor, mention)
  Transforms.move(editor)
}

// --- initial value (mirror Slate's example) ----------------------------
const initialValue: Descendant[] = [
  createParagraph([
    createText("This example shows how you might implement a simple "),
    createText("@-mentions", { bold: true }),
    createText(
      " feature that lets users autocomplete mentioning a user by their " +
        "username. Which, in this case means Star Wars characters. The "
    ),
    createText("mentions", { bold: true }),
    createText(" are rendered as "),
    createText("void inline elements", { code: true }),
    createText(" inside the document.")
  ]),
  createParagraph([
    createText("Try mentioning characters, like "),
    createMention("R2-D2"),
    createText(" or "),
    createMention("Mace Windu"),
    createText("!")
  ])
]

// --- demo controls ------------------------------------------------------
const reset = (): void => {
  initializeEditor(editor, initialValue)
  target.value = null
  search.value = ""
  index.value = 0
}

onMounted(() => {
  // The MentionEditor component runs initializeEditor itself on mount; this
  // is here in case the user clicks Reset before focusing the editor.
})

// --- mentions for the side panel ---------------------------------------
const modelMentions = computed(() => {
  const out: Array<{ id: string; character: string }> = []
  for (const block of editor.children as Descendant[]) {
    if ("children" in block) {
      for (const child of (block as { children: Descendant[] }).children) {
        if (
          "children" in child &&
          (child as { type?: string }).type === "mention"
        ) {
          const m = child as { character: string; id?: string }
          out.push({ id: m.id ?? m.character, character: m.character })
        }
      }
    }
  }
  return out
})
</script>

<template>
  <div class="container mx-auto max-w-6xl space-y-6 p-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold tracking-tight">
        Rich Editor · @ Mentions
      </h1>
      <p class="text-sm text-muted-foreground">
        Vue 3 port of
        <a
          href="https://github.com/ianstormtaylor/slate/blob/main/site/examples/ts/mentions.tsx"
          target="_blank"
          class="underline"
          >slate/site/examples/ts/mentions.tsx</a
        >. Input
        <code class="rounded bg-muted px-1.5 py-0.5 text-xs">@</code> to
        trigger, ↑/↓ to navigate, Enter/Tab to pick, Esc to dismiss.
      </p>
    </header>

    <div class="grid gap-6 md:grid-cols-3">
      <Card class="md:col-span-2">
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Editor</CardTitle>
              <CardDescription>
                data-cy="mention-editor" — focus & start typing
              </CardDescription>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="secondary"
                >mentions: {{ modelMentions.length }}</Badge
              >
              <Button size="sm" variant="outline" @click="reset">Reset</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <MentionEditor
            :editor="editor"
            :initial-value="initialValue"
            @change="onChange"
            @keydown="onKeyDown"
          >
            <template #element="{ attributes, element }">
              <MentionElement :attributes="attributes" :element="element" />
            </template>
          </MentionEditor>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live document model</CardTitle>
          <CardDescription>Reactive snapshot of the model</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div>
            <p
              class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Mentions
            </p>
            <div
              v-if="modelMentions.length === 0"
              class="text-sm text-muted-foreground"
            >
              (empty)
            </div>
            <ul v-else class="space-y-1.5">
              <li
                v-for="m in modelMentions"
                :key="m.id"
                class="flex items-center justify-between rounded-md border bg-muted/40 px-2 py-1.5 text-sm"
              >
                <span class="truncate">
                  <span class="text-muted-foreground">@</span>
                  {{ m.character }}
                </span>
                <code class="ml-2 truncate text-xs text-muted-foreground">{{
                  m.id
                }}</code>
              </li>
            </ul>
          </div>
          <Separator />
          <div>
            <p
              class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Model
            </p>
            <pre
              class="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-xs leading-relaxed"
            ><code>{{ JSON.stringify(editor.children, null, 2) }}</code></pre>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Popup — mirrors Slate's <Portal> -->
    <Teleport to="body">
      <div
        v-if="target && chars.length > 0"
        ref="popupEl"
        data-cy="mentions-portal"
        :style="{
          position: 'absolute',
          top: popupStyle.top,
          left: popupStyle.left,
          zIndex: 1000,
          padding: '3px',
          background: 'white',
          borderRadius: '4px',
          boxShadow: '0 1px 5px rgba(0,0,0,.2)'
        }"
        @mousedown.prevent
      >
        <div
          v-for="(char, i) in chars"
          :key="char.id"
          :style="{
            padding: '1px 3px',
            borderRadius: '3px',
            cursor: 'pointer',
            background: i === index ? '#B4D5FF' : 'transparent'
          }"
          @click="
            () => {
              Transforms.select(editor, target!)
              insertMention(char.character)
              target = null
            }
          "
        >
          {{ char.character }}
        </div>
      </div>
    </Teleport>
  </div>
</template>
