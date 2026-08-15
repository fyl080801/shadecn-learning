<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "."
import { Primitive } from "reka-ui"
import { Loader2 } from "lucide-vue-next"
import { cn } from "@/lib/utils"
import { buttonVariants } from "."

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"]
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
  /**
   * 请求进行中：转圈 + 自动禁用。
   * 只是**视觉反馈**，防连点的守卫在 `useAsyncAction` 里 —— disabled 要等下一次渲染才生效，
   * 拦不住同一轮事件循环里的第二次点击。
   */
  loading?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
})
</script>

<template>
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :disabled="disabled || loading || undefined"
    :aria-disabled="disabled || loading || undefined"
    :aria-busy="loading || undefined"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <Loader2 v-if="loading" class="animate-spin" />
    <slot />
  </Primitive>
</template>
