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

<script setup lang="ts">
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "../components/ui/card"
</script>
