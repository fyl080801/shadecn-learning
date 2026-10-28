<script setup lang="ts">
import { computed } from "vue"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet"

import { agentLabel, agentPurpose, phaseLook } from "@/lib/galstory-agents"
import type { PipelineStep } from "@/composables/useGalStoryRun"

/**
 * 某一次模型调用的详情。**点了流水线上那一条才出现**，不是常驻面板。
 *
 * ## 用 `Sheet` 而不是内嵌一列
 *
 * `Sheet` 是 shadcn-vue 里这种「从边上滑出来的抽屉」的那个组件（`Drawer` 是 vaul 那套
 * **底部**抽屉，方向不对）。它渲染在 portal 里、`fixed` 定位，故**自然顶到视口顶端**——
 * 而内嵌成一列时它只能从 header 下面开始，上面白掉一条。
 *
 * 顺带解决了另一件事：内嵌那一列会把对话挤窄，于是输入框得跟着一起变宽窄；改成浮层之后
 * 对话根本不动，那条「输入框要和消息块一体」的要求自动成立。
 *
 * ## 这里能显示什么，是被认知隔离限死的
 *
 * ⚠️ **没有提示词、没有输出原文、没有角色名**，而且这**不是接口没做完** —— 引擎那一侧
 * 刻意不把它们放上这条流：agent 标签冒号后那半截是角色**真名**，提示词里是导演的编排意图与
 * 其它角色的剧本私念，而这条流直接推给玩家。一个 `knows=false` 的角色在正文里落的是公共指代，
 * 详情面板却把真名或私念摆出来，就把隔离从侧门绕开了。
 *
 * 故这一层只有**可计量的那些**：哪个环节、归哪一段、跑了多久、几次尝试、吃了多少 token、
 * 失败原因。要看提示词与产出原文去引擎的运行日志（`logs/run-*.log`），那是给作者的，不是
 * 给玩家的 —— 两者的受众不同，这条边界就该在这里守住。
 */

const props = defineProps<{ step: PipelineStep | null }>()
const emit = defineEmits<{ close: [] }>()

/** `Sheet` 是受控的：关掉（点遮罩/按 Esc/点 X）一律回抛给页面，由它把选中态清掉 */
const open = computed({
  get: () => props.step !== null,
  set: (value: boolean) => {
    if (!value) emit("close")
  }
})

const phase = computed(() => (props.step ? phaseLook(props.step.phase) : null))

function fmt(seconds: number) {
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`
}

function tokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-sm">
      <SheetHeader class="border-b">
        <SheetTitle class="truncate text-sm">
          {{ step ? agentLabel(step.step) : "" }}
        </SheetTitle>
        <SheetDescription class="truncate text-xs">
          <template v-if="step">
            第 {{ step.turn }} 轮 · {{ phase?.label }}
            <template v-if="step.who"> · {{ step.who }}</template>
          </template>
        </SheetDescription>
      </SheetHeader>

      <div v-if="step" class="min-h-0 flex-1 overflow-y-auto p-4">
        <div class="flex flex-col gap-4 text-xs">
          <p v-if="agentPurpose(step.step)" class="leading-relaxed text-muted-foreground">
            {{ agentPurpose(step.step) }}
          </p>

          <!-- 失败最要紧，摆最上面 -->
          <div v-if="step.error" class="rounded-md border border-destructive/40 p-3">
            <p class="mb-1 font-medium text-destructive">这一次失败了</p>
            <p class="leading-relaxed break-words text-destructive">{{ step.error }}</p>
            <p class="mt-2 text-muted-foreground">
              引擎对传输类失败会自己重发；完整的栈在运行日志里。
            </p>
          </div>

          <Separator />

          <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
            <div class="flex flex-col gap-0.5">
              <dt class="text-muted-foreground">耗时</dt>
              <dd class="tabular-nums">{{ fmt(step.elapsed) }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-muted-foreground">调用形态</dt>
              <dd class="font-mono">{{ step.form || "-" }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-muted-foreground">输入 token</dt>
              <dd class="tabular-nums">{{ tokens(step.inputTokens) }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-muted-foreground">产出 token</dt>
              <dd class="tabular-nums">{{ tokens(step.outputTokens) }}</dd>
            </div>
            <div class="col-span-2 flex flex-col gap-0.5">
              <dt class="text-muted-foreground">尝试次数</dt>
              <dd>
                <span class="tabular-nums">第 {{ step.attempt }} 次</span>
                <!-- 重发不是重复：同一环节连着几条各是一次传输尝试 -->
                <span v-if="step.attempt > 1" class="ml-2 text-muted-foreground">
                  （前面那几次是传输失败后重发的）
                </span>
              </dd>
            </div>
          </dl>

          <!-- 估出来的数别当账单看 -->
          <p v-if="step.tokensEstimated" class="text-muted-foreground">
            ⚠️ 这一次的 token 是<strong>按字符估的</strong>（服务端没给用量），别拿它对账。
          </p>

          <Separator />

          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline" class="font-mono text-[10px]">{{ step.step }}</Badge>
            <Badge variant="secondary" class="text-[10px]">{{ phase?.label }}</Badge>
          </div>

          <!-- 说清楚为什么没有提示词/产出原文 —— 否则看着像接口没做完 -->
          <p class="leading-relaxed text-muted-foreground">
            这里不显示提示词与产出原文：那些是导演的编排意图与角色的剧本私念，而这条流是直接
            推给玩家的。要查它们去引擎的运行日志。
          </p>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>
