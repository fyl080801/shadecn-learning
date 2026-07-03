<script setup lang="ts">
import { ref } from "vue"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

const props = defineProps<{
  open: boolean
  strings: any
}>()

const emit = defineEmits<{
  (e: "update:open", value: boolean): void
  (e: "confirm", asScene: boolean): void
  (e: "cancel"): void
}>()

const asScene = ref(false)

function t(key: string) {
  return props.strings.getKey(key)
}

function onOpenChange(value: boolean) {
  emit("update:open", value)
  if (!value) emit("cancel")
}

function onConfirm() {
  emit("confirm", asScene.value)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("dialog/gltf/title") }}</DialogTitle>
      </DialogHeader>

      <label class="flex items-center gap-2 text-sm">
        <Checkbox v-model="asScene" />
        {{ t("dialog/gltf/asScene") }}
      </label>

      <DialogFooter>
        <Button variant="outline" @click="onOpenChange(false)">
          {{ t("dialog/cancel") }}
        </Button>
        <Button @click="onConfirm">
          {{ t("dialog/ok") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
