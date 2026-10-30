<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { CodeBlockVariants } from "./variants"
import { cn } from "@/lib/utils"
import { codeBlockVariants } from "./variants"

const props = withDefaults(defineProps<{
  variant?: CodeBlockVariants["variant"]
  size?: "default" | "sm"
  class?: HTMLAttributes["class"]
}>(), {
  variant: "default",
  size: "default",
})
</script>

<template>
  <div
    data-slot="code-block"
    :data-variant="variant"
    :data-size="size"
    :class="cn(codeBlockVariants({ variant }), props.class)"
  >
    <slot />
  </div>
</template>
