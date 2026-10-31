<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { assetVariantPath, type AssetSize } from "@shadecn/shared/canvas"

/**
 * 按档显示一张画布资源图（docs/27 §4）：`src` 永远是**原图**地址（节点里存的那个），`size` 决定取哪一档。
 *
 * 推得出档位地址（`assetVariantPath`：我们自己的素材键、不是 SVG）就先加载缩略图；**缩略图加载失败自动退回原图**
 * （老数据、生成失败的没有缩略图，请求会 404）—— 只有原图也失败才往外发 `error`。`fallback: false` 时不退：
 * 缩略图失败直接报 `error`（占位图用它：占位图退成原图就失去了意义）。
 * 外部链接、`blob:` 本地预览之类推不出档位，直接用原图。
 *
 * `load` 带上**实际加载的那一档**（退回了就是 `original`）：缩略图和原图高宽比相同，但 `icon` 只有百来像素，
 * 取整后比例略有出入，量尺寸的人据此决定信不信它（`media-fit.ts`）。
 * 其余属性（`class` / `alt` / `draggable` / `loading` / `data-*`）落在 `<img>` 上。
 */
const props = withDefaults(
  defineProps<{ src: string | null | undefined; size?: AssetSize; fallback?: boolean }>(),
  { size: "original", fallback: true }
)

const emit = defineEmits<{ load: [event: Event, size: AssetSize]; error: [event: Event] }>()

/** 这一档已经失败过：退回原图。换了图或档就重新试 */
const variantFailed = ref(false)
watch(
  () => [props.src, props.size],
  () => (variantFailed.value = false)
)

const original = computed(() => props.src?.trim() || undefined)

const current = computed(() => {
  if (!original.value) return undefined
  if (props.size === "original" || variantFailed.value) return original.value
  return assetVariantPath(original.value, props.size) ?? original.value
})

/** 实际在加载的那一档 */
const actualSize = computed<AssetSize>(() => (current.value === original.value ? "original" : props.size))

function onError(event: Event) {
  if (props.fallback && current.value !== original.value) {
    variantFailed.value = true
    return
  }
  emit("error", event)
}
</script>

<template>
  <img :src="current" :data-asset-size="actualSize" @load="emit('load', $event, actualSize)" @error="onError" />
</template>
