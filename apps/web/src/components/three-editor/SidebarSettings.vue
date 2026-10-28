<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue"

import { useEditor } from "./composables/useEditorContext"
import { MultiCmdsCommand } from "./commands/MultiCmdsCommand"
import { RemoveObjectCommand } from "./commands/RemoveObjectCommand"

import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

const editor = useEditor()
const config = editor.config
const signals = editor.signals
const strings = editor.strings
const history = editor.history
const t = (key: string) => strings.getKey(key)

const IS_MAC = navigator.platform.toUpperCase().indexOf("MAC") >= 0

// ----- 语言 -----

const languageLocales = ["en", "fr", "zh", "ja", "ko", "fa"]
const languageOptions = languageLocales.map((locale) => ({
  value: locale,
  label: new Intl.DisplayNames(locale, { type: "language" }).of(locale)
}))

const language = ref(config.getKey("language") ?? "en")

function onLanguageChange() {
  config.setKey("language", language.value)
}

// ----- 快捷键 -----

const shortcutNames = [
  "translate",
  "rotate",
  "scale",
  "undo",
  "focus",
  "perspective",
  "orthographic"
] as const

function isValidKeyBinding(key: string) {
  return /^[A-Za-z0-9]$/i.test(key)
}

const shortcuts = reactive<Record<string, string>>({})
for (const name of shortcutNames) {
  shortcuts[name] = config.getKey(`settings/shortcuts/${name}`) ?? ""
}

function onShortcutChange(name: string) {
  const value = (shortcuts[name] || "").toLowerCase()
  if (isValidKeyBinding(value)) {
    shortcuts[name] = value
    config.setKey(`settings/shortcuts/${name}`, value)
  } else {
    shortcuts[name] = config.getKey(`settings/shortcuts/${name}`) ?? ""
  }
}

function onShortcutKeyup(event: KeyboardEvent) {
  if (isValidKeyBinding(event.key)) {
    ;(event.target as HTMLInputElement).blur()
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  switch (event.key.toLowerCase()) {
    case "backspace":
    case "delete": {
      if (event.key.toLowerCase() === "backspace") {
        event.preventDefault() // 阻止浏览器后退
      }

      const object = editor.selected

      if (object === null || object.parent === null) return

      if (object.isSpotLight || object.isDirectionalLight) {
        editor.execute(
          new MultiCmdsCommand(editor, [
            new RemoveObjectCommand(editor, object),
            new RemoveObjectCommand(editor, object.target)
          ])
        )
      } else {
        editor.execute(new RemoveObjectCommand(editor, object))
      }

      break
    }

    case config.getKey("settings/shortcuts/translate"):
      signals.transformModeChanged.dispatch("translate")
      break

    case config.getKey("settings/shortcuts/rotate"):
      signals.transformModeChanged.dispatch("rotate")
      break

    case config.getKey("settings/shortcuts/scale"):
      signals.transformModeChanged.dispatch("scale")
      break

    case config.getKey("settings/shortcuts/undo"):
      if (IS_MAC ? event.metaKey : event.ctrlKey) {
        event.preventDefault() // 阻止浏览器特定的快捷键

        if (event.shiftKey) {
          editor.redo()
        } else {
          editor.undo()
        }
      }

      break

    case config.getKey("settings/shortcuts/focus"):
      if (editor.selected !== null) {
        editor.focus(editor.selected)
      }

      break

    case config.getKey("settings/shortcuts/perspective"):
      editor.setCameraType("perspective")
      break

    case config.getKey("settings/shortcuts/orthographic"):
      editor.setCameraType("orthographic")
      break
  }
}

// ----- 历史 -----

const persistentHistory = ref(!!config.getKey("settings/history"))
const historyEntries = ref<
  Array<{ id: number; name: string; isRedo: boolean }>
>([])
const selectedHistoryId = ref<number | null>(null)

let ignoreHistoryChangedForSelection = false

function refreshHistoryEntries() {
  const entries: Array<{ id: number; name: string; isRedo: boolean }> = []

  for (const cmd of history.undos) {
    entries.push({ id: cmd.id, name: cmd.name, isRedo: false })
  }

  for (let i = history.redos.length - 1; i >= 0; i--) {
    const cmd = history.redos[i]
    entries.push({ id: cmd.id, name: cmd.name, isRedo: true })
  }

  historyEntries.value = entries
}

function onHistoryChanged(cmd: any) {
  refreshHistoryEntries()

  if (ignoreHistoryChangedForSelection) return
  selectedHistoryId.value = cmd !== undefined ? cmd.id : null
}

function onHistoryClick(entry: { id: number }) {
  ignoreHistoryChangedForSelection = true
  history.goToState(entry.id)
  ignoreHistoryChangedForSelection = false

  selectedHistoryId.value = entry.id
}

function onPersistentChange() {
  const value = persistentHistory.value

  config.setKey("settings/history", value)

  if (value) {
    alert(strings.getKey("prompt/history/preserve"))

    const lastUndoCmd = history.undos[history.undos.length - 1]
    const lastUndoId = lastUndoCmd !== undefined ? lastUndoCmd.id : 0
    history.enableSerialization(lastUndoId)
  } else {
    signals.historyChanged.dispatch()
  }
}

function onClearHistory() {
  if (confirm(strings.getKey("prompt/history/clear"))) {
    history.clear()
  }
}

onMounted(() => {
  refreshHistoryEntries()

  document.addEventListener("keydown", onDocumentKeydown)
  signals.editorCleared.add(refreshHistoryEntries)
  signals.historyChanged.add(onHistoryChanged)
})

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onDocumentKeydown)
  signals.editorCleared.remove(refreshHistoryEntries)
  signals.historyChanged.remove(onHistoryChanged)
})
</script>

<template>
  <div class="te-sidebar-settings space-y-4 p-3">
    <div class="flex items-center gap-2">
      <Label class="w-32 shrink-0 text-xs">{{
        t("sidebar/settings/language")
      }}</Label>
      <Select v-model="language" @update:model-value="onLanguageChange">
        <SelectTrigger size="sm" class="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="option in languageOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-2 border-t pt-3">
      <Label class="text-xs uppercase">{{
        t("sidebar/settings/shortcuts")
      }}</Label>

      <div
        v-for="name in shortcutNames"
        :key="name"
        class="flex items-center gap-2"
      >
        <Label class="w-32 shrink-0 text-xs capitalize">{{
          t(`sidebar/settings/shortcuts/${name}`)
        }}</Label>
        <input
          v-model="shortcuts[name]"
          type="text"
          maxlength="1"
          class="border-input h-7 w-10 rounded-md border bg-transparent px-2 text-center text-xs lowercase"
          @click="($event.target as HTMLInputElement).select()"
          @change="onShortcutChange(name)"
          @keyup="onShortcutKeyup($event)"
        />
      </div>
    </div>

    <div class="space-y-2 border-t pt-3">
      <div class="flex items-center justify-between">
        <Label class="text-xs uppercase">{{ t("sidebar/history") }}</Label>
        <label class="flex items-center gap-1 text-xs">
          <Checkbox
            v-model="persistentHistory"
            @update:model-value="onPersistentChange"
          />
          {{ t("sidebar/history/persistent") }}
        </label>
      </div>

      <ScrollArea class="h-40 rounded-md border">
        <div class="space-y-0.5 p-1">
          <button
            v-for="entry in historyEntries"
            :key="entry.id"
            type="button"
            class="hover:bg-accent block w-full truncate rounded-sm px-2 py-1 text-left text-xs"
            :class="{
              'bg-accent': selectedHistoryId === entry.id,
              'opacity-40': entry.isRedo
            }"
            @click="onHistoryClick(entry)"
          >
            {{ entry.name }}
          </button>
        </div>
      </ScrollArea>

      <Button
        size="sm"
        variant="outline"
        class="text-xs"
        @click="onClearHistory"
      >
        {{ t("sidebar/history/clear") }}
      </Button>
    </div>
  </div>
</template>
