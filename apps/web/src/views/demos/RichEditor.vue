<script setup lang="ts">
/**
 * RichEditor — exercises the plugin-driven `<PromptInput>` with a string
 * `v-model`.  The editor's value is the raw string seen in the textarea
 * on the right; plugins decide how inline tokens round-trip.
 *
 * Three plugins are wired in:
 *
 *   1. `mention`  — input trigger `@`, syntax `@[Name](id)`.
 *   2. `ref`      — no trigger, syntax `{{Ref N}}`.
 *   3. `camera`   — no trigger, syntax `{{Camera}}`.
 *
 * All inline rendering and popover content stays here in the view layer;
 * `<PromptInput>` only talks plain strings.
 */
import { computed, ref } from "vue"
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
  PromptInput,
  createEditor,
  definePlugin,
  characterSource,
  splitByRegex
} from "@/components/prompt-input"
import type {
  CustomInline,
  MentionItem,
  ParsedSegment,
  TriggerContext
} from "@/components/prompt-input"
import {
  InlineCodeEditable,
  createInlineCodePlugin,
  commitInlineCodeText,
  type InlineCodeData
} from "@/components/inline-code"

// --- mention plugin (with trigger) -------------------------------------

const search = ref("")
const index = ref(0)
const chars = computed<MentionItem[]>(() =>
  characterSource(search.value).slice(0, 10)
)

const mentionPlugin = definePlugin({
  name: "mention",
  trigger: { key: "@" },
  inline: { type: "mention" },
  parse(text): ParsedSegment[] {
    return splitByRegex(text, /@\[([^\]]+)\]\(([^)]+)\)/g, (m) => ({
      kind: "node",
      type: "mention",
      data: {
        character: m[1] ?? "",
        id: m[2] ?? ""
      } satisfies MentionItem
    }))
  },
  serialize(node): string {
    const data = (node.data ?? {}) as Partial<MentionItem>
    const character = data.character ?? node.character ?? ""
    const id = data.id ?? character
    return `@[${character}](${id})`
  },
  onKeyDown(e) {
    if (chars.value.length === 0) return false
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        index.value =
          index.value >= chars.value.length - 1 ? 0 : index.value + 1
        return true
      case "ArrowUp":
        e.preventDefault()
        index.value =
     index.value <= 0 ? chars.value.length - 1 : index.value - 1
        return true
      case "Tab":
      case "Enter": {
        e.preventDefault()
        const pick = chars.value[index.value]
        if (pick) commitPick(pick)
        return true
      }
    }
    return false
  }
})

// --- ref plugin (no trigger) -------------------------------------------

type RefData = { index: number }

const refPlugin = definePlugin({
  name: "ref",
  inline: { type: "ref" },
  parse(text): ParsedSegment[] {
    return splitByRegex(text, /\{\{Ref\s+(\d+)\}\}/g, (m) => ({
      kind: "node",
      type: "ref",
      data: { index: Number(m[1]) } satisfies RefData
    }))
  },
  serialize(node): string {
    const data = (node.data ?? { index: 0 }) as RefData
    return `{{Ref${data.index}}}`
  }
})

// --- camera plugin (no trigger) ----------------------------------------

const cameraPlugin = definePlugin({
  name: "camera",
  inline: { type: "camera" },
  parse(text): ParsedSegment[] {
    return splitByRegex(text, /\{\{Camera\}\}/g, () => ({
      kind: "node",
      type: "camera",
      data: {}
    }))
  },
  serialize(): string {
    return "{{Camera}}"
  }
})

// --- inline-code plugin (no trigger, md-style ` ... `) -----------------

const inlineCodePlugin = createInlineCodePlugin()

// --- editor instance ---------------------------------------------------

const { editor } = createEditor({
  plugins: [mentionPlugin, refPlugin, cameraPlugin, inlineCodePlugin]
})

/**
 * 子区输入回写：把新文本写回节点 data 并触发 editor.apply()。
 * 注意：DOM 文本由 <InlineCodeEditable> 自管，这里不再读取 textContent。
 * 之所以独立成子组件是为了避免 Vue 在 revision++ 时重写 textContent
 * 把光标拉回到块首——子组件用 ref + 手动同步绕开模板插值。
 */
const onInlineCodeUpdate = (element: CustomInline, text: string): void => {
  commitInlineCodeText(editor, element, text)
}

// --- popover commit ----------------------------------------------------

let _commitFn: ((p: { data: unknown }) => void) | null = null
const setCommitFn = (fn: (p: { data: unknown }) => void): void => {
  _commitFn = fn
}

const commitPick = (item: MentionItem): void => {
  _commitFn?.({ data: item })
  search.value = ""
  index.value = 0
}

// --- trigger lifecycle ------------------------------------------------

const onTriggerOpen = (ctx: TriggerContext): void => {
  search.value = ctx.search
  index.value = 0
}

const onTriggerSearch = (ctx: TriggerContext): void => {
  search.value = ctx.search
  index.value = 0
}

const onTriggerClose = (): void => {
  search.value = ""
  index.value = 0
}

// --- v-model (string value) -------------------------------------------

const initialText =
  "This example shows how you might implement a simple @-mentions feature " +
  "that lets users autocomplete mentioning a user by their username. " +
  "Which, in this case means Star Wars characters.\n\n" +
  "Try mentioning characters, like @[R2-D2](r2-d2) or " +
  "@[Mace Windu](mace-windu)! You can also drop refs like {{Ref 1}} or a " +
  "{{Camera}} placeholder anywhere in the text.\n\n" +
  "Inline-code blocks are editable in place: try clicking inside " +
  "`hello world` or `npm install vue` and typing—but you can't add line " +
  "breaks, and ArrowLeft/ArrowRight at the boundary jumps over the whole " +
  "block in a single step."

const text = ref(initialText)

const reset = (): void => {
  text.value = initialText
}

// --- live mention list (parsed straight from the string) --------------

const modelMentions = computed(() => {
  const out: Array<{ id: string; character: string }> = []
  const re = /@\[([^\]]+)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text.value)) !== null) {
    out.push({ character: m[1] ?? "", id: m[2] ?? "" })
  }
  return out
})
</script>

<template>
  <div class="container mx-auto max-w-6xl space-y-6 p-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold tracking-tight">
        Rich Editor · Plugin-driven string v-model
      </h1>
      <p class="text-sm text-muted-foreground">
        值类型为字符串。<code class="rounded bg-muted px-1.5 py-0.5 text-xs"
          >@</code
        >
        触发 mention，<code v-pre class="rounded bg-muted px-1.5 py-0.5 text-xs"
          >{{Ref N}}</code
        >
        与
        <code v-pre class="rounded bg-muted px-1.5 py-0.5 text-xs"
          >{{Camera}}</code
        >
        由插件解析为不同的 inline 元素。
        <br />
        新增：<code v-pre class="rounded bg-muted px-1.5 py-0.5 text-xs"
          >`text`</code
        >
        被解析为可内部编辑的行内代码块——块内可单独编辑，但禁止换行；外层
        ArrowLeft/Right 把整块视为一个字符。
      </p>
    </header>

    <div class="grid gap-6 md:grid-cols-3">
      <Card class="md:col-span-2">
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Editor</CardTitle>
              <CardDescription>
                data-cy="prompt-input" — focus & start typing
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
          <PromptInput
            v-model="text"
            :editor="editor"
            @trigger-open="onTriggerOpen"
            @trigger-search="onTriggerSearch"
            @trigger-close="onTriggerClose"
          >
            <!-- mention -->
            <template #element:mention="{ element, attributes }">
              <span
                v-bind="attributes"
                contenteditable="false"
                :style="{
                  padding: '3px 3px 2px',
              margin: '0 1px',
                  verticalAlign: 'baseline',
                  display: 'inline-block',
                  borderRadius: '4px',
                  backgroundColor: '#eee',
                  fontSize: '0.9em'
                }"
              >
                @{{
                  ((element as CustomInline).data as MentionItem | undefined)
                    ?.character ?? (element as CustomInline).character
                }}
              </span>
            </template>

            <!-- ref -->
            <template #element:ref="{ element, attributes }">
              <span
                v-bind="attributes"
                contenteditable="false"
                :style="{
                  padding: '2px 6px',
                  margin: '0 1px',
                  verticalAlign: 'baseline',
                  display: 'inline-block',
                  borderRadius: '4px',
                  backgroundColor: '#dbeafe',
                  color: '#1d4ed8',
                  fontSize: '0.85em'
                }"
              >
                Ref
                {{ ((element as CustomInline).data as { index: number }).index }}
              </span>
            </template>

            <!-- camera -->
            <template #element:camera="{ attributes }">
              <span
                v-bind="attributes"
                contenteditable="false"
                :style="{
                  padding: '2px 6px',
                  margin: '0 1px',
                  verticalAlign: 'baseline',
                  display: 'inline-block',
                  borderRadius: '4px',
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  fontSize: '0.85em'
                }"
              >
                📷 Camera
            </span>
            </template>

            <!-- inline-code: 嵌套 contenteditable 子区由独立子组件管理，
                 避免 Vue 在 editor.apply() 后重写 textContent 把光标拉回块首。-->
            <template #element:inline-code="{ element, attributes }">
              <span
                v-bind="attributes"
                contenteditable="false"
                :style="{
                  display: 'inline-block',
                  verticalAlign: 'baseline',
                  margin: '0 2px',
                  padding: '0 6px',
                  borderRadius: '4px',
                  backgroundColor: '#f3f4f6',
                  border: '1px solid #e5e7eb',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: '0.88em',
                  lineHeight: '1.5'
                }"
              >
                <InlineCodeEditable
                  :text="
                    ((element as CustomInline).data as InlineCodeData | undefined)?.text ?? ''
                  "
                  @update="(t) => onInlineCodeUpdate(element as CustomInline, t)"
                />
              </span>
            </template>

            <!-- mention popover -->
            <template #portal:mention="{ commit, close }">
              <template
                v-if="(setCommitFn(commit as (p: { data: unknown }) => void), true)"
              />
              <div
                :style="{
                  padding: '3px',
                  background: 'white',
                  borderRadius: '4px',
                  boxShadow: '0 1px 5px rgba(0,0,0,.2)'
                }"
              >
                <div
                  v-if="chars.length === 0"
                  class="px-2 py-1 text-xs text-muted-foreground"
                >
                  无匹配
                </div>
                <div
                  v-for="(char, i) in chars"
                  :key="char.id"
                  :style="{
                    padding: '1px 6px',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    background: i === index ? '#B4D5FF' : 'transparent'
                  }"
                  @click="
                    () => {
                      commit({ data: char })
                      close()
                    }
                  "
                  @mouseenter="index = i"
                >
                  {{ char.character }}
                </div>
              </div>
            </template>
          </PromptInput>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live string value</CardTitle>
          <CardDescription>The v-model is a plain string</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div>
            <p
              class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Mentions (parsed from string)
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
              Raw string
            </p>
            <pre
              class="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 text-xs leading-relaxed whitespace-pre-wrap"
            ><code>{{ text }}</code></pre>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>