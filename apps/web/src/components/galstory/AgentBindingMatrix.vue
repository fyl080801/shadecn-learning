<script setup lang="ts">
import { computed } from "vue"
import { CircleAlert, Info, TriangleAlert } from "@lucide/vue"

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
  AGENT_ROLE_ORDER,
  OUTPUT_FORM_LABELS,
  agentLabel,
  roleHint,
  roleLabel
} from "@/lib/galstory-agents"
import type { Binding, LintIssue, LintLevel, ModelConfig } from "@/types/galstory"

/**
 * Agent × 连接 的解析矩阵 —— 这一页真正要回答的问题。
 *
 * 配置页最容易做成的样子是「把 config.yaml 摊成一堆表单」，但那等于把问题原样丢回给人：
 * `connection_id` 一个字段同时背着**这一步要什么**（agent 固有，换端点不变）与
 * **谁提供它**（端点属性，换端点全变）。
 *
 * ## 按**职能**分组，不按路由键
 *
 * 组头是引擎里的**五位 agent**（世界 / 导演 / 演员 / 场景 / 玩家）—— 那是读的人心里的单位：
 * 「导演这几步指到哪条连接了」是个有意义的问题，「thinking 那一档有哪些」不是。
 *
 * ⚠️ **路由键没被藏掉**，它只是回到了它该在的位置：`agent_bindings` 那两行由页面在表**上方**
 * 单列成两张卡（换 provider 时要改的就是它俩），每一行则用「不必思考」这个徽章说明它走哪一边。
 * 此前它是组头，于是同一位 agent 的几步会被拆到两个组里 —— 而作者要找的是「导演」，
 * 不是「不必思考」。
 *
 * ⚠️ **归属由引擎给**（`Binding.role`，判据写在那个环节自己的模块里），这里**不许**按环节名
 * 再归一次 —— 引擎把某个环节从一位挪给另一位时，前端不会有任何东西提醒，页面只是默默放错组。
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

/**
 * 按五位分组。**跨位的那些单列在最后**（`shared`：核验器伺候四位的产出，挂在其中任何一位
 * 名下都是错的）—— 判据是引擎给的那个布尔，不是这里按名字认出来的。
 */
const grouped = computed(() => {
  const shared = props.config.bindings.filter((b) => b.shared)
  // ⚠️ **顺序由引擎给**（`config.roleOrder`）；接口没给时才回落到本地那份
  const order = props.config.roleOrder?.length ? props.config.roleOrder : AGENT_ROLE_ORDER
  const groups = order.map((role) => ({
    role: role as string,
    label: roleLabel(role),
    hint: roleHint(role),
    rows: props.config.bindings.filter((b) => !b.shared && b.role === role)
  }))
  return [
    ...groups,
    {
      role: "shared",
      label: "跨位",
      hint: "归属由调用现场决定：核验器跑在生成之后，核的是谁就归谁 —— 四位的产出它都伺候。",
      rows: shared
    }
  ].filter((group) => group.rows.length > 0)
})



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
        <template v-for="group in grouped" :key="group.role">
          <!-- 组头 = 引擎里的**一位 agent**（归属由引擎给，见组件头） -->
          <TableRow class="bg-muted/50 hover:bg-muted/50">
            <TableCell :colspan="6">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ group.label }}</span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Info class="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent class="max-w-xs">{{ group.hint }}</TooltipContent>
                </Tooltip>
                <span class="text-xs text-muted-foreground">{{ group.rows.length }} 个环节</span>
              </div>
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
