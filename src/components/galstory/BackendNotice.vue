<script setup lang="ts">
import { computed } from "vue"
import { PlugZap, ServerCrash } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { GalStoryError, NOT_CONFIGURED } from "@/lib/galstory"

/**
 * 取不到数据时显示什么。
 *
 * **「没配」与「坏了」要分开说**，因为下一步动作完全不同：前者要去 `.env` 加一行，
 * 后者要去看引擎起没起。混成一句「加载失败」就等于让人自己去猜是哪一种 ——
 * 而这个仓库里绝大多数人根本没跑那个引擎，最常见的恰恰是第一种。
 */
const props = defineProps<{ error: unknown }>()

defineEmits<{ retry: [] }>()

const notConfigured = computed(
  () => props.error instanceof GalStoryError && props.error.status === NOT_CONFIGURED
)

const message = computed(() =>
  props.error instanceof Error ? props.error.message : String(props.error)
)

/** 引擎与反代都会给一句「接下来该做什么」，有就照给，别自己另编一句 */
const hint = computed(() => (props.error instanceof GalStoryError ? props.error.hint : ""))
</script>

<template>
  <div class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
    <component :is="notConfigured ? PlugZap : ServerCrash" class="size-8 text-muted-foreground" />

    <template v-if="notConfigured">
      <p class="text-sm font-medium">GalStory 后端没有配置</p>
      <p class="max-w-md text-sm text-muted-foreground">
        在 <code class="font-mono">.env</code> 里设
        <code class="font-mono">GAL_STORY_API_URL</code>（例如
        <code class="font-mono">http://127.0.0.1:8000</code>），再重启服务端。
        引擎那一侧用
        <code class="font-mono">uv run gal-story serve</code> 起。
      </p>
    </template>

    <template v-else>
      <p class="max-w-md text-sm text-destructive">{{ message }}</p>
      <p v-if="hint" class="max-w-md text-sm text-muted-foreground">{{ hint }}</p>
    </template>

    <Button variant="outline" size="sm" @click="$emit('retry')">重试</Button>
  </div>
</template>
