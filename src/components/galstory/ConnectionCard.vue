<script setup lang="ts">
import { computed } from "vue"
import { Brain, BrainCircuit, Radio, Wrench } from "@lucide/vue"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Connection } from "@/types/galstory"

/**
 * 一条连接。
 *
 * 卡片上那排徽章是**三条能力轴**（结构化产出 / 工具调用 / 推理），它们互不相通，
 * 别合并成一个「支不支持」—— 换 provider 时要对着这三条各查一次。
 * 「关思考」单独占一格是因为它是这个引擎最大的一笔成本：实测输出 token 的
 * 81% 是拿不到的思考。
 */

const props = defineProps<{
  connection: Connection
  /** 有几个环节最终解析到了它 —— 「这条连接删了会影响谁」 */
  usedBy: number
  isDefault: boolean
}>()

defineEmits<{ edit: [connection: Connection] }>()

/**
 * 这条连接上有没有**任何**关思考的声明。判据是「两个字段都空 = 作者一个字没写」，
 * 而不是「值对不对」—— 合法取值是**端点**的事（本地 ollama /v1 只认 `none`，
 * DeepSeek 官方要走 extra_body），前端替端点判值必然过时。
 */
const noThinking = computed(
  () => Boolean(props.connection.reasoningEffort) || props.connection.thinkingDisabled
)

const thinkingHint = computed(() =>
  noThinking.value
    ? `已声明关思考（${props.connection.reasoningEffort || "extra_body"}）`
    : "没有任何关思考的声明 —— 机械型环节指到这里会为拿不到的思考付钱"
)

/** 提交触发线 = 窗口 × 水位。它是**模型的技术下限**，与故事的 max_context 分开判 */
const watermark = computed(() =>
  props.connection.contextWindow
    ? Math.round(props.connection.contextWindow * props.connection.commitWatermark)
    : null
)
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <CardTitle class="flex items-center gap-2">
            <code class="truncate font-mono text-sm">{{ connection.id }}</code>
            <Badge v-if="isDefault" variant="secondary">缺省</Badge>
          </CardTitle>
          <CardDescription class="truncate">
            {{ connection.model }} · {{ connection.provider }}
          </CardDescription>
        </div>
      </div>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <!-- 两条能力轴 + 流式。每一格都是「声明」，不是探测结果 —— 写错了运行期才会露头。
           ⚠️ 曾经还有一格「结构化」：引擎 2026-08-23 起不再向端点索取结构化产出（每一步都交
           文本、结构由 agent.shape 提取），那个声明连同它的旋钮一起没了。 -->
      <div class="flex flex-wrap gap-1.5">
        <Tooltip>
          <TooltipTrigger as-child>
            <Badge :variant="connection.toolCall ? 'secondary' : 'outline'" class="gap-1">
              <Wrench class="size-3" />
              工具调用
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {{ connection.toolCall ? "支持工具调用（认知检索与 skill 走这条）" : "不绑 tools" }}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Badge :variant="noThinking ? 'secondary' : 'outline'" class="gap-1">
              <component :is="noThinking ? Brain : BrainCircuit" class="size-3" />
              {{ noThinking ? "已关思考" : "会思考" }}
            </Badge>
          </TooltipTrigger>
          <TooltipContent class="max-w-xs">{{ thinkingHint }}</TooltipContent>
        </Tooltip>

        <Badge v-if="connection.stream" variant="outline" class="gap-1">
          <Radio class="size-3" />
          流式
        </Badge>
      </div>

      <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">端点</dt>
          <dd class="truncate font-mono text-xs">{{ connection.baseUrl || "厂商缺省" }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">API key</dt>
          <dd class="truncate font-mono text-xs">{{ connection.apiKeyEnv || "-" }}</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">超时 / 重发</dt>
          <dd class="tabular-nums">{{ connection.timeoutS }}s · {{ connection.maxRetries }} 次</dd>
        </div>
        <div class="flex flex-col">
          <dt class="text-xs text-muted-foreground">
            {{ connection.stream ? "块停滞 / socket 静默" : "上下文窗口" }}
          </dt>
          <dd class="tabular-nums">
            <template v-if="connection.stream">
              {{ connection.chunkTimeoutS || "-" }}s · {{ connection.idleTimeoutS ?? "-" }}s
            </template>
            <template v-else>{{ connection.contextWindow?.toLocaleString() ?? "未填" }}</template>
          </dd>
        </div>
        <div v-if="watermark" class="col-span-2 flex flex-col">
          <dt class="text-xs text-muted-foreground">提交触发线</dt>
          <dd class="text-xs text-muted-foreground">
            <span class="tabular-nums text-foreground">{{ watermark.toLocaleString() }}</span>
            token（窗口 {{ connection.contextWindow?.toLocaleString() }} ×
            {{ connection.commitWatermark }}）—— 模型的技术下限，与故事的 max_context 分开判
          </dd>
        </div>
      </dl>
    </CardContent>

    <CardFooter class="justify-between">
      <span class="text-xs text-muted-foreground">
        {{ usedBy > 0 ? `${usedBy} 个环节解析到它` : "当前没有环节用它" }}
      </span>
      <Button variant="outline" size="sm" @click="$emit('edit', connection)">查看 / 编辑</Button>
    </CardFooter>
  </Card>
</template>
