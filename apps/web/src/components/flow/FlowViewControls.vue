<script setup lang="ts">
import { computed, ref } from "vue"
import { Panel } from "@vue-flow/core"
import { MiniMap } from "@vue-flow/minimap"
import { Map, Maximize, Minus, Plus } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 左下角视图控件：缩放（− 百分比 +）、全览、小地图显隐，外加小地图本身。
 *
 * 小地图是挂在开关按钮上的浮层（Popover，按钮正上方弹出），默认不显示；
 * 它是一个常驻开关，点外面、按 Esc 都不收起，只有再点一次按钮才关。
 *
 * 只管「怎么看」，不碰画布内容。
 * 定位交给 Vue Flow 的 `<Panel>`，动作走 `useFlowCanvas` 里包好的那几个
 * （按钮缩放不会发 move-end，视口同步在那边补）。
 * 必须渲染在 `<VueFlow>` 的插槽里 —— Panel / MiniMap 依赖它注入的画布实例。
 */
const { canvas } = useFlowEditor()

const percent = computed(() => Math.round(canvas.zoomLevel.value * 100))

/** 输入框的草稿：聚焦时接管显示，回车 / 失焦提交，Esc 放弃 */
const draft = ref<string | null>(null)

function startEdit(event: FocusEvent) {
  draft.value = String(percent.value)
  ;(event.target as HTMLInputElement).select()
}

function commit() {
  if (draft.value === null) return
  const value = Number.parseFloat(draft.value.replace("%", ""))
  draft.value = null
  if (Number.isFinite(value) && value > 0) canvas.zoomToLevel(value / 100)
}

function cancel(event: KeyboardEvent) {
  draft.value = null
  ;(event.target as HTMLInputElement).blur()
}
</script>

<template>
  <Panel
    position="bottom-left"
    class="flow-view-controls flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
  >
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="缩小"
      :disabled="canvas.zoomLevel.value <= canvas.minZoom.value"
      @click="canvas.zoomOutView()"
    >
      <Minus />
    </Button>
    <input
      :value="draft ?? `${percent}%`"
      class="h-8 w-14 rounded-md bg-transparent text-center text-xs tabular-nums outline-none hover:bg-accent focus:bg-accent"
      title="缩放比例（可输入）"
      aria-label="缩放比例"
      inputmode="numeric"
      @focus="startEdit"
      @input="draft = ($event.target as HTMLInputElement).value"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
      @keydown.esc="cancel"
      @blur="commit()"
    >
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="放大"
      :disabled="canvas.zoomLevel.value >= canvas.maxZoom.value"
      @click="canvas.zoomInView()"
    >
      <Plus />
    </Button>

    <Separator
      orientation="vertical"
      class="mx-1 data-[orientation=vertical]:h-5"
    />

    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="全览"
      @click="canvas.fitAll()"
    >
      <Maximize />
    </Button>
    <Popover v-model:open="canvas.miniMapVisible.value">
      <PopoverTrigger as-child>
        <Button
          :variant="canvas.miniMapVisible.value ? 'secondary' : 'ghost'"
          size="icon"
          class="size-8 rounded-full"
          :title="canvas.miniMapVisible.value ? '隐藏小地图' : '显示小地图'"
        >
          <Map />
        </Button>
      </PopoverTrigger>
      <!--
        浮层 teleport 到 body，但仍在这棵组件树里，MiniMap 照样拿得到 Vue Flow 实例。
        MiniMap 自带的 Panel 定位在 vue-flow.css 里被 `.flow-minimap` 摊平成普通块。
      -->
      <PopoverContent
        side="top"
        align="center"
        :side-offset="14"
        class="w-auto overflow-hidden rounded-xl p-0 shadow-lg"
        @open-auto-focus.prevent
        @interact-outside.prevent
        @escape-key-down.prevent
      >
        <MiniMap class="flow-minimap" :width="200" :height="140" pannable zoomable />
      </PopoverContent>
    </Popover>
  </Panel>
</template>
