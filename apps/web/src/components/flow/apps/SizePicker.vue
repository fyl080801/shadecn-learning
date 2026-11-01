<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { ChevronDown } from "@lucide/vue"
import { checkParamValue, parseSizeValue, sizeCellOf, sizeValueOf, type ParamSpec } from "@shadecn/shared/apps"

import { useNodePart } from "@/components/flow/node-kit/context"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import { NODE_APP_PARAM_PREFIX } from "./node-app"

/**
 * 生成节点的尺寸选择（docs/29 §3.9）：一个按钮显示当前尺寸，点开是「分辨率 × 比例」的弹出框。
 *
 * 一切都按参数说明来（`size` 类型：`tiers` 档位、`presets` 比例 → 每档的宽高），说明来自应用表的模型档案 —— 这里不认识任何模型：
 * - **分辨率**：`tiers` 里的档位；换分辨率时比例保持（换成同一比例的另一档），这一档没有那个比例的参考值就回到「自动」；
 * - **比例**：「自动」= 只传档位，比例由模型按提示词定（方舟推荐的写法）；其余是 `presets` 的比例，选了传这一档那一格的宽高；
 *   这一档没有参考值的比例不可选；
 * - 只能在表里选，不能自己填宽高；
 * - 选择写进节点的 `data["appParam.<参数名>"]`。面板里没有底栏（不显示当前值、没有「恢复默认」）。
 */
const props = defineProps<{ name: string; spec: ParamSpec }>()

const ctx = useNodePart()
const key = computed(() => `${NODE_APP_PARAM_PREFIX}${props.name}`)

const stored = computed(() => ctx.node.data.value[key.value])
/** 节点上存的值对这个模型合不合（换了模型，旧值可能超出新模型的范围） */
const storedProblem = computed(() =>
  stored.value === undefined ? null : checkParamValue(props.name, props.spec, stored.value)
)
const fallback = computed(() => (typeof props.spec.default === "string" ? props.spec.default : null))
/** 这次生成实际用的值：存的合就用存的，否则用默认（和 `nodeAppParams` 同一个规则） */
const current = computed(() =>
  typeof stored.value === "string" && !storedProblem.value ? stored.value : fallback.value
)
const cell = computed(() => (current.value ? sizeCellOf(props.spec, current.value) : null))

const tiers = computed(() => props.spec.tiers ?? [])
const ratios = computed(() => Object.keys(props.spec.presets ?? {}))

const label = computed(() => {
  if (!current.value) return "尺寸"
  if (cell.value) return cell.value.ratio ? `${cell.value.ratio} · ${cell.value.tier}` : `${cell.value.tier} · 自动比例`
  // 表外的宽高（应用表的默认值、别的调用方写的）照样显示
  const size = parseSizeValue(current.value)
  return size ? `${size.width}×${size.height}` : current.value
})

// —— 弹出框里的选择 ——

const open = ref(false)
const tier = ref<string | null>(null)
const ratio = ref<string | null>(null)

/** 打开时从当前值摆好：在表里的落到那一格；不在表里的落到默认档位、「自动」 */
watch(open, (isOpen) => {
  if (!isOpen) return
  tier.value = cell.value?.tier ?? fallbackTier()
  ratio.value = cell.value?.ratio ?? null
})

function fallbackTier(): string | null {
  const defaultCell = fallback.value ? sizeCellOf(props.spec, fallback.value) : null
  return defaultCell?.tier ?? tiers.value[tiers.value.length - 1] ?? null
}

/** 这一档、这个比例的宽高（没有 = 这个比例在这一档不可选；按钮上不显示宽高） */
function sizeOf(tierId: string | null, ratioId: string): string | null {
  return tierId ? sizeValueOf(props.spec, tierId, ratioId) : null
}

/** 比例按钮上的小方块：按比例画，长边固定 */
function shapeStyle(ratioId: string) {
  const [w, h] = ratioId.split(":").map(Number)
  if (!w || !h) return {}
  const long = 14
  return w >= h ? { width: `${long}px`, height: `${(long * h) / w}px` } : { width: `${(long * w) / h}px`, height: `${long}px` }
}

function write(value: string) {
  ctx.node.write("data", { set: { [key.value]: value } }, "选择生成尺寸")
}

function pickTier(next: string) {
  tier.value = next
  const value = sizeValueOf(props.spec, next, ratio.value) ?? sizeValueOf(props.spec, next, null)
  if (value === next) ratio.value = null
  if (value) write(value)
}

function pickRatio(next: string | null) {
  if (!tier.value) return
  const value = sizeValueOf(props.spec, tier.value, next)
  if (!value) return
  ratio.value = next
  write(value)
}

/** 触发按钮的外观：照抄 `ui/select/SelectTrigger.vue`，和旁边的下拉框长得一样（同一行里两种按钮会显得不齐） */
const TRIGGER_CLASS =
  "border-input [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent py-2 whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3 [&_svg]:pointer-events-none [&_svg]:shrink-0"
</script>

<template>
  <Popover v-model:open="open">
    <!-- 外观和旁边的应用 / 模型下拉（SelectTrigger）一致：同样的边框、底色、高度、字号和右侧箭头 -->
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(TRIGGER_CLASS, 'h-7 max-w-36 shrink-0 px-2 text-xs')"
        :aria-invalid="storedProblem ? true : undefined"
        :title="storedProblem ? `节点上的尺寸不适用于这个模型，改用默认：${storedProblem}` : (spec.description ?? '尺寸')"
        data-testid="size-picker"
      >
        <span>{{ label }}</span>
        <ChevronDown class="size-4 opacity-50" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="nodrag nopan nowheel w-80 p-3" data-testid="size-picker-panel">
      <div class="flex flex-col gap-3 text-sm">
        <section v-if="tiers.length > 0" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium text-muted-foreground">分辨率</h4>
          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="item in tiers"
              :key="item"
              size="xs"
              :variant="tier === item ? 'default' : 'outline'"
              class="min-w-12"
              :data-testid="`size-tier-${item}`"
              @click="pickTier(item)"
            >
              {{ item }}
            </Button>
          </div>
        </section>

        <section v-if="tiers.length > 0" class="flex flex-col gap-1.5">
          <h4 class="text-xs font-medium text-muted-foreground">比例</h4>
          <div class="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              :class="
                cn(
                  'flex items-center justify-center rounded-md border px-1 py-1.5 text-xs hover:bg-accent',
                  ratio === null && 'border-primary bg-accent'
                )
              "
              data-testid="size-ratio-auto"
              @click="pickRatio(null)"
            >
              <span class="flex h-3.5 items-center text-muted-foreground">自动</span>
            </button>
            <button
              v-for="item in ratios"
              :key="item"
              type="button"
              :disabled="!sizeOf(tier, item)"
              :class="
                cn(
                  'flex items-center justify-center rounded-md border px-1 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
                  ratio === item && 'border-primary bg-accent'
                )
              "
              :data-testid="`size-ratio-${item}`"
              @click="pickRatio(item)"
            >
              <span class="flex h-3.5 items-center gap-1">
                <span class="inline-block rounded-[2px] border border-current" :style="shapeStyle(item)" />
                {{ item }}
              </span>
            </button>
          </div>
        </section>

      </div>
    </PopoverContent>
  </Popover>
</template>
