<script setup lang="ts">
// @ts-nocheck
import { onBeforeUnmount, onMounted, ref } from "vue"

import { useEditor } from "./composables/useEditorContext"

import { AddScriptCommand } from "./commands/AddScriptCommand"
import { SetScriptValueCommand } from "./commands/SetScriptValueCommand"
import { RemoveScriptCommand } from "./commands/RemoveScriptCommand"

import { Button } from "@/components/ui/button"

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const scripts = ref<any[]>([])

function refresh() {
  const object = editor.selected

  if (object === null) {
    scripts.value = []
    return
  }

  scripts.value = editor.scripts[object.uuid] ?? []
}

function onNameChange(script: any, event: Event) {
  editor.execute(
    new SetScriptValueCommand(
      editor,
      editor.selected,
      script,
      "name",
      (event.target as HTMLInputElement).value
    )
  )
}

function onEdit(script: any) {
  signals.editScript.dispatch(editor.selected, script)
}

function onRemove(script: any) {
  if (confirm(strings.getKey("prompt/script/remove"))) {
    editor.execute(new RemoveScriptCommand(editor, editor.selected, script))
  }
}

function onNew() {
  const script = { name: "", source: "function update( event ) {}" }
  editor.execute(new AddScriptCommand(editor, editor.selected, script))
}

onMounted(() => {
  refresh()

  signals.objectSelected.add(refresh)
  signals.scriptAdded.add(refresh)
  signals.scriptRemoved.add(refresh)
  signals.scriptChanged.add(refresh)
})

onBeforeUnmount(() => {
  signals.objectSelected.remove(refresh)
  signals.scriptAdded.remove(refresh)
  signals.scriptRemoved.remove(refresh)
  signals.scriptChanged.remove(refresh)
})
</script>

<template>
  <div class="space-y-2 p-3">
    <div v-if="scripts.length" class="space-y-1">
      <div
        v-for="script in scripts"
        :key="script.name + script.source.length"
        class="flex items-center gap-1"
      >
        <input
          :value="script.name"
          type="text"
          class="border-input h-7 w-[130px] rounded-md border bg-transparent px-2 text-xs"
          @change="onNameChange(script, $event)"
        />
        <Button
          size="sm"
          variant="outline"
          class="h-7 text-xs"
          @click="onEdit(script)"
        >
          {{ t("sidebar/script/edit") }}
        </Button>
        <Button
          size="sm"
          variant="outline"
          class="h-7 text-xs"
          @click="onRemove(script)"
        >
          {{ t("sidebar/script/remove") }}
        </Button>
      </div>
    </div>

    <Button size="sm" variant="outline" class="text-xs" @click="onNew">
      {{ t("sidebar/script/new") }}
    </Button>
  </div>
</template>
