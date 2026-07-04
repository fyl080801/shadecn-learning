<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

import translateSvg from "@/assets/translate.svg?raw"
import rotateSvg from "@/assets/rotate.svg?raw"
import scaleSvg from "@/assets/scale.svg?raw"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useEditor } from "./composables/useEditorContext"

defineOptions({ inheritAttrs: false })

const editor = useEditor()
const signals = editor.signals
const strings = editor.strings
const t = (key: string) => strings.getKey(key)

const tools = [
  { id: "translate", label: "toolbar/translate", icon: translateSvg },
  { id: "rotate", label: "toolbar/rotate", icon: rotateSvg },
  { id: "scale", label: "toolbar/scale", icon: scaleSvg }
] as const

const mode = ref<(typeof tools)[number]["id"]>("translate")
// While a bone is selected, only rotation is allowed: translating or scaling
// a bone would offset it from its parent and visibly break the joint
// connection, so those tools are disabled for the duration of the selection.
const selectedIsBone = ref(false)

function setMode(id: (typeof tools)[number]["id"]) {
  if (selectedIsBone.value && id !== "rotate") return
  signals.transformModeChanged.dispatch(id)
}

function onTransformModeChanged(newMode: (typeof tools)[number]["id"]) {
  mode.value = newMode
}

function onObjectSelected(object: any) {
  selectedIsBone.value = !!object?.isBone
}

onMounted(() => {
  signals.transformModeChanged.add(onTransformModeChanged)
  signals.objectSelected.add(onObjectSelected)
  onObjectSelected(editor.selected)
})

onBeforeUnmount(() => {
  signals.transformModeChanged.remove(onTransformModeChanged)
  signals.objectSelected.remove(onObjectSelected)
})
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div
      v-bind="$attrs"
      class="te-toolbar flex items-center gap-0.5 rounded-md border bg-card p-1 shadow-sm"
    >
      <Tooltip v-for="tool in tools" :key="tool.id">
        <TooltipTrigger as-child>
          <Button
            :variant="mode === tool.id ? 'secondary' : 'ghost'"
            size="icon-sm"
            class="[&_svg]:size-4"
            :disabled="selectedIsBone && tool.id !== 'rotate'"
            @click="setMode(tool.id)"
          >
            <span v-html="tool.icon" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t(tool.label) }}</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
</template>
