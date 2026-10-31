<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { assetVariantPath, type AssetSize } from "@shadecn/shared/canvas"

import AssetImage from "@/components/flow/AssetImage.vue"

defineOptions({ inheritAttrs: false })

/**
 * 画布节点上的资源图（docs/27 §4.1）：**渐进加载**。
 *
 * - 目标档（`size`，由 `useMediaFit().assetSize` 按缩放定）还没加载完时，底下先垫一张 `icon` 档、做**毛玻璃**处理
 *   （模糊 + 放大一点盖住模糊后发虚的边）；目标档加载完就盖上去、撤掉占位。
 * - **先图标、后目标档**：这张图的图标档有结果（加载完或失败）之前，目标档不发请求。打开画布时几十个节点同时加载，
 *   目标档和图标档一起发会抢连接，图标就不一定先到；排在后面，整张画布先铺满毛玻璃，再逐个变清晰。
 *   只在每张图第一次时等：图标档有过结果后（换 `src` 才重置），缩放换档不再等。
 * - 目标档本身就是 `icon`（画布缩得很小）时不要占位，直接显示。
 * - 占位图**不退回原图**（`fallback: false`）：没有缩略图（老数据、外部链接）就没有占位，目标档照常边下边显示。
 * - 缩放来回跨过阈值时换档：缩小换回 `icon`（早就加载过，几乎立刻好）；放大换到 `low`，加载期间露出毛玻璃占位。
 *
 * 其余属性（`alt` / `draggable` / `class` / `data-testid`）落在目标档那张 `<img>` 上；`load` 原样带档往外发
 * （占位图加载完也发一次，档是 `icon` —— 节点还没尺寸时可以先按它记个近似值，见 `media-fit.ts`）。
 */
const props = defineProps<{ src: string; size: Exclude<AssetSize, "original"> }>()

const emit = defineEmits<{ load: [event: Event, size: AssetSize] }>()

const mainLoaded = ref(false)
const placeholderFailed = ref(false)
/** 这张图的图标档有过结果（加载完或失败）：之后目标档不用再排在它后面 */
const iconSettled = ref(false)

watch(
  () => [props.src, props.size],
  () => (mainLoaded.value = false)
)
watch(
  () => props.src,
  () => {
    placeholderFailed.value = false
    iconSettled.value = false
  }
)

/** 要不要垫毛玻璃占位：目标档不是图标、推得出图标地址、图标没失败、目标档还没加载完 */
const showPlaceholder = computed(
  () =>
    props.size !== "icon" &&
    !mainLoaded.value &&
    !placeholderFailed.value &&
    assetVariantPath(props.src, "icon") !== null
)

/** 目标档先不发请求：占位图标还在路上 */
const holdMain = computed(() => showPlaceholder.value && !iconSettled.value)

function onPlaceholderLoad(event: Event, size: AssetSize) {
  iconSettled.value = true
  emit("load", event, size)
}

function onPlaceholderError() {
  placeholderFailed.value = true
  iconSettled.value = true
}

function onMainLoad(event: Event, size: AssetSize) {
  mainLoaded.value = true
  if (size === "icon") iconSettled.value = true
  emit("load", event, size)
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden" data-testid="canvas-asset-image">
    <AssetImage
      v-if="showPlaceholder"
      :src="props.src"
      size="icon"
      :fallback="false"
      alt=""
      aria-hidden="true"
      draggable="false"
      class="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-md"
      data-role="placeholder"
      @load="onPlaceholderLoad"
      @error="onPlaceholderError()"
    />
    <AssetImage
      v-if="!holdMain"
      v-bind="$attrs"
      :src="props.src"
      :size="props.size"
      :class="showPlaceholder ? 'opacity-0' : undefined"
      data-role="main"
      @load="onMainLoad"
    />
  </div>
</template>
