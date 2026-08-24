<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, Info, TriangleAlert } from "lucide-vue-next"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AGENT_KIND_HINTS,
  AGENT_KIND_LABELS,
  AGENT_KINDS,
  OUTPUT_FORM_LABELS,
  agentLabel
} from "@/lib/galstory-agents"
import type { Binding, LintIssue, LintLevel, ModelConfig } from "@/types/galstory"

/**
 * Agent × 连接 的解析矩阵 —— 这一页真正要回答的问题。
 *
 * 配置页最容易做成的样子是「把 config.yaml 摊成一堆表单」，但那等于把问题原样丢回给人：
 * `connection_id` 一个字段同时背着**这一步要什么**（agent 固有，换端点不变）与
 * **谁提供它**（端点属性，换端点全变）。引擎为此把环节划成三类、让「按类绑定」承担后者，
 * 这里就是把那层结构画出来 —— 三个组头就是 `agent_bindings` 那三行。
 *
 * ⚠️ **每一行的 `connectionId` / `source` / `timeBudgetS` 都是引擎算好给的，这里只渲染**。
 * 三层优先级的唯一声明处是 `AgentClients.binding_of`；在前端重算一份就是同一个判据两处声明，
 * 而漂了不报错 —— 只是矩阵上显示的绑定与引擎实际打过去的那条不是同一个。
 */

const props = defineProps<{
  config: ModelConfig
  /** 按 agent 名分好的体检结论（`issues[].where` 就是那个名字） */
  issuesByAgent: Record<string, LintIssue[]>
}>()

const emit = defineEmits<{ select: [binding: Binding] }>()

const grouped = computed(() =>
  AGENT_KINDS.map((kind) => ({
    kind,
    boundTo: props.config.agentBindings[kind],
    rows: props.config.bindings.filter((b) => b.binding === kind)
  })).filter((group) => group.rows.length > 0)
)

const SOURCE_LABELS: Record<Binding["source"], string> = {
  override: "本行覆盖",
  kind: "按类绑定",
  default: "缺省连接"
}

/** 只有「本行覆盖」值得强调 —— 那是作者特意为这一步指的，也是最该复核的一行 */
const SOURCE_VARIANTS: Record<Binding["source"], "default" | "secondary" | "outline"> = {
  override: "default",
  kind: "secondary",
  default: "outline"
}

const ICONS: Record<LintLevel, typeof Info> = { error: CircleAlert, warn: TriangleAlert, info: Info }
const TONES: Record<LintLevel, string> = {
  error: "text-destructive",
  warn: "text-amber-600",
  info: "text-muted-foreground"
}

const byId = computed(() => new Map(props.config.connections.map((c) => [c.id, c])))

/**
 * 一行只显示最严重的那一级；点开才看全部。
 *
 * **`resolved === false` 单独算一条 error**：引擎的绑定体检刻意跳过这一档（连接压根不存在时
 * 它 `continue`，交给运行期 `_build` 去 warning），可对着配置看的人来说，「指到了一条不存在的
 * 连接」正是最该一眼看见的 —— 那一步的超时与预设会**全丢**，而且完全静默。
 */
function worst(row: Binding): LintLevel | null {
  if (!row.resolved) return "error"
  const issues = props.issuesByAgent[row.name] ?? []
  if (issues.some((i) => i.level === "error")) return "error"
  if (issues.some((i) => i.level === "warn")) return "warn"
  if (issues.some((i) => i.level === "info")) return "info"
  return null
}
</script>

<template>
  <div class="rounded-lg border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>环节</TableHead>
          <TableHead class="w-28">要模型会什么</TableHead>
          <TableHead class="w-56">解析到的连接</TableHead>
          <TableHead class="w-24">来源</TableHead>
          <TableHead class="w-24 text-right">墙钟上界</TableHead>
          <TableHead class="w-14 text-right">体检</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        <template v-for="group in grouped" :key="group.kind">
          <!-- 组头就是 agent_bindings 的那一行：换 provider 时要改的就是它 -->
          <TableRow class="bg-muted/50 hover:bg-muted/50">
            <TableCell :colspan="2">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ AGENT_KIND_LABELS[group.kind] }}</span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Info class="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent class="max-w-xs">
                    {{ AGENT_KIND_HINTS[group.kind] }}
                  </TooltipContent>
                </Tooltip>
                <span class="text-xs text-muted-foreground">{{ group.rows.length }} 个环节</span>
              </div>
            </TableCell>
            <TableCell :colspan="4">
              <code class="font-mono text-xs">
                agent_bindings.{{ group.kind }} = {{ group.boundTo || "（未配，走缺省）" }}
              </code>
            </TableCell>
          </TableRow>

          <TableRow
            v-for="row in group.rows"
            :key="row.name"
            class="cursor-pointer"
            @click="emit('select', row)"
          >
            <TableCell>
              <div class="font-medium">{{ agentLabel(row.name) }}</div>
              <code class="font-mono text-xs text-muted-foreground">{{ row.name }}</code>
            </TableCell>

            <TableCell>
              <div class="flex flex-wrap gap-1">
                <!-- 产出形状是**纯描述性**的（产物长什么样），与端点能力无关 -->
                <Badge v-if="row.output !== 'text'" variant="secondary">
                  {{ OUTPUT_FORM_LABELS[row.output] }}
                </Badge>
                <Badge v-if="!row.reasoning" variant="outline">不必思考</Badge>
                <span
                  v-if="row.output === 'text' && row.reasoning"
                  class="text-xs text-muted-foreground"
                >
                  自由文本
                </span>
              </div>
            </TableCell>

            <TableCell>
              <code :class="['font-mono text-xs', row.resolved ? '' : 'text-destructive line-through']">
                {{ row.connectionId || "（未配）" }}
              </code>
              <div v-if="row.resolved" class="truncate text-xs text-muted-foreground">
                {{ byId.get(row.connectionId)?.model }}
              </div>
              <div v-else class="text-xs text-destructive">这条连接不存在</div>
            </TableCell>

            <TableCell>
              <Badge :variant="SOURCE_VARIANTS[row.source]">{{ SOURCE_LABELS[row.source] }}</Badge>
            </TableCell>

            <TableCell class="text-right text-sm tabular-nums text-muted-foreground">
              {{ row.timeBudgetS ? `${Math.round(row.timeBudgetS)}s` : "-" }}
            </TableCell>

            <TableCell class="text-right">
              <component
                :is="ICONS[worst(row)!]"
                v-if="worst(row)"
                :class="['ml-auto size-4', TONES[worst(row)!]]"
              />
              <span v-else class="text-xs text-muted-foreground">-</span>
            </TableCell>
          </TableRow>
        </template>
      </TableBody>
    </Table>
  </div>
</template>
