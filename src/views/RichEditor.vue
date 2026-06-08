<script setup lang="ts">
/**
 * RichEditor — Vue port of Slate's `mentions.tsx` example, refactored to
 * exercise the plugin-based PromptInput API.  Read this file top-to-bottom
 * and you should still recognise the original Slate flow.
 *
 * Differences from the React example:
 *   - The editor is built with `createEditor({ plugins })` and plugins
 *     are registered through the plugin protocol.
 *   - "Mention" is no longer baked into the editor; it is just a plugin
 *     authored here in the view layer.
 *   - The popover renders inside `<PromptInput #portal:mention>` and is
 *     fully controlled by this view; the editor only positions it.
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
  initializeEditor,
  characterSource,
  createText,
  createInline,
  createParagraph
} from "@/components/prompt-input"
import type {
  Descendant,
  CustomInline,
  TriggerContext,
  MentionItem
} from "@/components/prompt-input"

// --- mention plugin (lives entirely in the view layer) -----------------

// Local UI state for the mention popover; `definePlugin.onKeyDown` reads
// these refs to drive ↑/↓/Tab/Enter navigation.
const search = ref("")
const index = ref(0)
const chars = computed<MentionItem[]>(() =>
  characterSource(search.value).slice(0, 10)
)

const mentionPlugin = definePlugin({
  name: "mention",
  trigger: { key: "@" },
  inline: { type: "mention" },
  onKeyDown(e, _ctx) {
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

// --- editor instance ---------------------------------------------------

const { editor } = createEditor({ plugins: [mentionPlugin] })

// --- popover commit ----------------------------------------------------

let _commitFn: ((p: { data: unknown }) => void) | null = null
const setCommitFn = (fn: (p: { data: unknown }) => void): void => {
  _commitFn = fn
}

const commitPick = (item: MentionItem): void => {
  // Persist the full data payload on the inline node so the renderer can
  // show whatever fields it needs.
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

// --- initial value -----------------------------------------------------

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
    createInline("mention", {
      id: "r2-d2",
      character: "R2-D2"
    } satisfies MentionItem),
    createText(" or "),
    createInline("mention", {
      id: "mace-windu",
      character: "Mace Windu"
    } satisfies MentionItem),
    createText("!")
  ])
]

const reset = (): void => {
  initializeEditor(editor, initialValue)
}

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
          const m = child as CustomInline & { character?: string }
          const data = (m.data ?? {}) as Partial<MentionItem>
          const character = data.character ?? m.character ?? ""
          const id = data.id ?? character
          out.push({ id, character })
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
        Rich Editor · @ Mentions（Plugin API）
      </h1>
      <p class="text-sm text-muted-foreground">
        Vue 3 port of
        <a
          href="https://github.com/ianstormtaylor/slate/blob/main/site/examples/ts/mentions.tsx"
          target="_blank"
          class="underline"
        >slate/site/examples/ts/mentions.tsx</a>. 输入
        <code class="rounded bg-muted px-1.5 py-0.5 text-xs">@</code> 触发，
        ↑/↓ 导航，Enter/Tab 选中，Esc 关闭。
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
            :editor="editor"
            :initial-value="initialValue"
            @trigger-open="onTriggerOpen"
            @trigger-search="onTriggerSearch"
            @trigger-close="onTriggerClose"
          >
            <!-- inline node renderer keyed by plugin name -->
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

            <!-- popover content keyed by plugin name -->
            <template #portal:mention="{ commit, close }">
              <!-- Capture commit so `onKeyDown` (running outside the slot
                   scope) can apply selection too. -->
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
  </div>
</template>