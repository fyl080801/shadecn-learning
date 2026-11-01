<script setup lang="ts">
import { computed } from "vue"

import { useNodePart } from "@/components/flow/node-kit/context"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApps } from "@/composables/useApps"

import {
  NODE_APP_KEY,
  NODE_APP_MODEL_KEY,
  appsOfCategory,
  choiceUnavailable,
  nodeAppCategory,
  resolveNodeApp,
  sizeParamOf
} from "./node-app"
import SizePicker from "./SizePicker.vue"

/**
 * 生成节点底部输入框里的「用哪个应用 / 模型」（docs/29 §3.8）：放在发送按钮左边，替掉那行提示文字。
 *
 * - 参考图上限不在这里显示：连线时直接按它限制（`node-app.ts` 的 `appInputLimit`，满了拖不进来、加号建不出来）；
 * - 列的是这个节点类别（看输出端口：图片节点 → 生图应用）的应用；用不了的置灰、悬停看原因；
 * - 应用列了不止一个模型才有第二个下拉；所选模型有尺寸参数（`size` 类型）时再多一枚尺寸按钮（`SizePicker.vue`）；
 * - 选了就写进节点的 `data.appId` / `data.appModel`（协作者看到的是同一个选择）；没选 = 第一个可用的应用、它的默认模型，
 *   读的一侧不回写；
 * - 一个应用都没有（服务端没配应用表）时只显示一句说明。
 */
const ctx = useNodePart()
const { apps, loading } = useApps()

const category = computed(() => nodeAppCategory(ctx.type))
const candidates = computed(() => (category.value ? appsOfCategory(apps.value, category.value) : []))
const choice = computed(() =>
  category.value ? resolveNodeApp(apps.value, category.value, ctx.node.data.value) : null
)
const problem = computed(() => (choice.value ? choiceUnavailable(choice.value) : null))

const size = computed(() => (choice.value ? sizeParamOf(choice.value) : null))

function pickApp(value: unknown) {
  if (typeof value !== "string" || value === choice.value?.app.id) return
  ctx.node.write("data", { set: { [NODE_APP_KEY]: value }, remove: [NODE_APP_MODEL_KEY] }, "选择生成应用")
}

function pickModel(value: unknown) {
  if (typeof value !== "string" || !choice.value || value === choice.value.model) return
  // 模型跟着应用走：一并写下应用，否则「没选应用、按默认」时选的模型对不上号
  ctx.node.write("data", { set: { [NODE_APP_KEY]: choice.value.app.id, [NODE_APP_MODEL_KEY]: value } }, "选择生成模型")
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1.5" data-testid="app-picker">
    <span v-if="candidates.length === 0" class="truncate text-[11px] text-muted-foreground" data-testid="app-picker-empty">
      {{ loading ? "正在加载生成应用…" : "服务端还没有配置生成应用" }}
    </span>
    <template v-else-if="choice">
      <Select :model-value="choice.app.id" @update:model-value="pickApp">
        <SelectTrigger size="sm" class="h-7 max-w-36 px-2 text-xs data-[size=sm]:h-7" data-testid="app-picker-app" :title="choice.app.description">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="app in candidates"
            :key="app.id"
            :value="app.id"
            :disabled="!!app.unavailable"
            :title="app.unavailable ?? app.description"
          >
            {{ app.title }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select v-if="choice.app.models.length > 1" :model-value="choice.model" @update:model-value="pickModel">
        <SelectTrigger size="sm" class="h-7 max-w-36 px-2 text-xs data-[size=sm]:h-7" data-testid="app-picker-model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="model in choice.app.models"
            :key="model.id"
            :value="model.id"
            :disabled="!!model.unavailable"
            :title="model.unavailable ?? model.id"
          >
            {{ model.title ?? model.id }}
          </SelectItem>
        </SelectContent>
      </Select>
      <SizePicker v-if="size" :key="size.name" :name="size.name" :spec="size.spec" />
      <span v-if="problem" class="truncate text-[11px] text-destructive" :title="problem" data-testid="app-picker-hint">
        {{ problem }}
      </span>
    </template>
  </div>
</template>
