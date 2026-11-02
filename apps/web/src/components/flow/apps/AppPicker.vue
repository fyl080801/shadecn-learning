<script setup lang="ts">
import { computed } from "vue"

import { useNodePart } from "@/components/flow/node-kit/context"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApps } from "@/composables/useApps"

import { NODE_APP_KEY, appHint, appsOfCategory, nodeAppCategory, resolveNodeApp, sizeParamOf } from "./node-app"
import SizePicker from "./SizePicker.vue"

/**
 * 生成节点（文本 / 图片 / 视频）底部输入框里的「用哪个应用」（docs/29 §3.8）：放在发送按钮左边，替掉那行提示文字。
 *
 * - 一个应用就是一个模型，所以只有这一个下拉，没有级联；所选应用有尺寸参数（`size` 类型）时多一枚尺寸按钮（`SizePicker.vue`）；
 * - 参考图上限不在这里显示：连线时直接按它限制（`node-app.ts` 的 `appInputLimit`，满了拖不进来、加号建不出来）；
 * - 列的是这个节点类别（看输出端口：图片节点 → 生图应用）的全部应用；用不了的置灰、悬停看原因，别的悬停看说明和模型；
 * - 选了就写进节点的 `data.appId`（协作者看到的是同一个选择）；没选 = 第一个可用的应用，读的一侧不回写；
 * - 一个应用都没有（服务端 `modules.apps` 没配；文本节点的应用来自语言服务提供方 `llm.providers`）时只显示一句说明。
 */
const ctx = useNodePart()
const { apps, loading } = useApps()

const category = computed(() => nodeAppCategory(ctx.type))
const candidates = computed(() => (category.value ? appsOfCategory(apps.value, category.value) : []))
const selected = computed(() =>
  category.value ? resolveNodeApp(apps.value, category.value, ctx.node.data.value) : null
)

const size = computed(() => (selected.value ? sizeParamOf(selected.value) : null))

function pickApp(value: unknown) {
  if (typeof value !== "string" || value === selected.value?.id) return
  ctx.node.write("data", { set: { [NODE_APP_KEY]: value } }, "选择生成应用")
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5" data-testid="app-picker">
    <span v-if="candidates.length === 0" class="truncate text-[11px] text-muted-foreground" data-testid="app-picker-empty">
      {{ loading ? "正在加载生成应用…" : category === "text" ? "服务端还没有配置语言服务" : "服务端还没有配置生成应用" }}
    </span>
    <template v-else-if="selected">
      <Select :model-value="selected.id" @update:model-value="pickApp">
        <SelectTrigger size="sm" class="h-7 max-w-48 px-2 text-xs data-[size=sm]:h-7" data-testid="app-picker-app" :title="appHint(selected)">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="app in candidates"
            :key="app.id"
            :value="app.id"
            :disabled="!!app.unavailable"
            :title="appHint(app)"
          >
            {{ app.title }}
          </SelectItem>
        </SelectContent>
      </Select>
      <SizePicker v-if="size" :key="size.name" :name="size.name" :spec="size.spec" />
      <span v-if="selected.unavailable" class="truncate text-[11px] text-destructive" :title="selected.unavailable" data-testid="app-picker-hint">
        {{ selected.unavailable }}
      </span>
    </template>
  </div>
</template>
