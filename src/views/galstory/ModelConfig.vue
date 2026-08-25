<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, FileCog, Minus } from "@lucide/vue"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { TooltipProvider } from "@/components/ui/tooltip"

import AgentBindingMatrix from "@/components/galstory/AgentBindingMatrix.vue"
import BackendNotice from "@/components/galstory/BackendNotice.vue"
import ConnectionCard from "@/components/galstory/ConnectionCard.vue"
import LintCounts from "@/components/galstory/LintCounts.vue"
import LintList from "@/components/galstory/LintList.vue"

import {
  AGENT_KIND_HINTS,
  AGENT_KIND_LABELS,
  AGENT_KINDS,
  OUTPUT_FORM_LABELS,
  agentLabel,
  agentPurpose
} from "@/lib/galstory-agents"
import { configApi, countLevels } from "@/lib/galstory"
import type { Binding, Connection, LintIssue, ModelConfig } from "@/types/galstory"

/**
 * 模型配置（`GET /api/config`）。
 *
 * 页签的顺序是有判据的：**「Agent 绑定」排第一** —— 这一页真正要回答的问题是
 * 「哪一步指到哪条连接、够不够用」，而不是「这些连接各自长什么样」。连接与预设是那张矩阵的
 * **词表**，所以排在它后面。
 *
 * ⚠️ **整页只读，而且引擎那一侧也只有读口**。反代刻意只转发 GET（引擎把「要花钱 / 会写」
 * 都放在非 GET 上），所以这里不放「保存」按钮 —— 一个点了却什么都没发生的按钮比没有更糟。
 * 改配置是改 `config.yaml`，页头把那个文件的路径直接给出来。
 */

const config = ref<ModelConfig | null>(null)
const loading = ref(true)
const error = ref<unknown>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    config.value = await configApi.get()
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

void load()

const counts = computed(() => countLevels(config.value?.issues ?? []))

/** 按 agent 名分好，矩阵每行只认自己那几条（`issues[].where` 就是那个名字） */
const issuesByAgent = computed(() => {
  const map: Record<string, LintIssue[]> = {}
  for (const issue of config.value?.issues ?? []) {
    if (!issue.where) continue
    ;(map[issue.where] ??= []).push(issue)
  }
  return map
})

/** 每条连接被几个环节解析到 —— 「这条删了会影响谁」 */
const usage = computed(() => {
  const map = new Map<string, number>()
  for (const binding of config.value?.bindings ?? []) {
    map.set(binding.connectionId, (map.get(binding.connectionId) ?? 0) + 1)
  }
  return map
})

// ── 行详情：三层优先级到底是怎么算出来的 ─────────────────────────────────────

const selected = ref<Binding | null>(null)

const chain = computed(() => {
  const row = selected.value
  const cfg = config.value
  if (!row || !cfg) return []
  return [
    {
      layer: "agents[].connection_id",
      // 引擎只告诉我们赢家是哪一层，不回传每一层各写了什么 —— 故这一层的值只在它赢了时
      // 才显示得出来。**不去猜**：显示一个猜出来的值比显示「未写」更糟。
      value: row.source === "override" ? row.connectionId : "",
      hint: "这一步单独指定的连接"
    },
    {
      layer: `agent_bindings.${row.kind}`,
      value: cfg.agentBindings[row.kind],
      hint: `${AGENT_KIND_LABELS[row.kind]} 这一类统一指到哪`
    },
    { layer: "default_connect", value: cfg.defaultConnect, hint: "上面都没写时的缺省" }
  ]
})

/** 链条上第一条有值的就是赢家 —— 把「为什么是它」画出来，而不是只给结果 */
const winnerIndex = computed(() => chain.value.findIndex((step) => step.value))

const selectedConnection = computed(() =>
  config.value?.connections.find((c) => c.id === selected.value?.connectionId) ?? null
)

// ── 连接详情：给出可以贴回 config.yaml 的片段 ────────────────────────────────

const viewing = ref<Connection | null>(null)

const yamlPreview = computed(() => {
  const conn = viewing.value
  if (!conn) return ""
  const lines = [
    `- id: ${conn.id}`,
    `  provider: ${conn.provider}`,
    `  model: ${conn.model}`,
    conn.baseUrl ? `  base_url: ${conn.baseUrl}` : null,
    conn.apiKeyEnv ? `  api_key_env: ${conn.apiKeyEnv}` : null,
    `  timeout_s: ${conn.timeoutS}`,
    `  max_retries: ${conn.maxRetries}`,
    conn.contextWindow ? `  context_window: ${conn.contextWindow}` : null,
    conn.reasoningEffort ? `  reasoning_effort: ${conn.reasoningEffort}` : null,
    conn.stream ? "  stream: true" : null,
    conn.stream && conn.idleTimeoutS ? `  idle_timeout_s: ${conn.idleTimeoutS}` : null,
    conn.stream && conn.chunkTimeoutS ? `  chunk_timeout_s: ${conn.chunkTimeoutS}` : null,
    // extra_body 只知道「有没有」，不知道内容 —— 那是原样透传的厂商私有信封，接口刻意不给
    conn.thinkingDisabled ? "  extra_body: { ... }   # 关思考的厂商私有声明，内容见配置文件" : null
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
})
</script>

<template>
  <!-- reka-ui 的 Tooltip 要有 Provider 祖先；矩阵与连接卡片里都有，统一套在最外层 -->
  <TooltipProvider>
    <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
      <header class="flex flex-wrap items-start gap-3">
        <div class="flex-1">
          <h1 class="text-2xl font-semibold tracking-tight">模型配置</h1>
          <p class="text-sm text-muted-foreground">
            每个环节指到哪条连接由三层决定：本行覆盖 &gt; 按类绑定 &gt; 缺省连接。
          </p>
        </div>
        <LintCounts v-if="config" :counts="counts" />
      </header>

      <div v-if="loading" class="flex flex-col gap-4">
        <Skeleton class="h-10 w-64" />
        <Skeleton class="h-96 w-full" />
      </div>

      <BackendNotice v-else-if="error || !config" :error="error ?? '读不到配置'" @retry="load()" />

      <template v-else>
        <!-- 整页只读，那就把「该去改哪个文件」直接说出来 -->
        <div
          v-if="config.sourceFile"
          class="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <FileCog class="size-4 shrink-0" />
          <span>改配置改这个文件：</span>
          <code class="truncate font-mono text-xs">{{ config.sourceFile }}</code>
        </div>

        <Tabs default-value="bindings" class="flex min-h-0 flex-1 flex-col gap-4">
          <TabsList>
            <TabsTrigger value="bindings">Agent 绑定</TabsTrigger>
            <TabsTrigger value="connections">连接 {{ config.connections.length }}</TabsTrigger>
            <TabsTrigger value="presets">采样预设 {{ config.presets.length }}</TabsTrigger>
            <TabsTrigger value="lint">体检</TabsTrigger>
          </TabsList>

          <!-- ── Agent 绑定：这一页的主角 ────────────────────────────────── -->
          <TabsContent value="bindings" class="flex flex-col gap-4">
            <div class="grid gap-3 md:grid-cols-3">
              <Card v-for="kind in AGENT_KINDS" :key="kind">
                <CardHeader>
                  <CardTitle class="text-sm">{{ AGENT_KIND_LABELS[kind] }}</CardTitle>
                  <CardDescription class="text-xs">{{ AGENT_KIND_HINTS[kind] }}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div class="flex flex-col gap-1">
                    <span class="text-xs text-muted-foreground">指到</span>
                    <code class="font-mono text-sm">
                      {{ config.agentBindings[kind] || "未配，走缺省连接" }}
                    </code>
                  </div>
                </CardContent>
              </Card>
            </div>

            <p class="text-xs text-muted-foreground">
              换 provider 时改的就是上面这三行 ——
              <code class="font-mono">connection_id</code>
              一个字段同时背着「这一步要什么」（换端点不变）与「谁提供它」（换端点全变），
              按类绑之后前者留在引擎里，后者收在这三行上。
            </p>

            <AgentBindingMatrix
              :config="config"
              :issues-by-agent="issuesByAgent"
              @select="selected = $event"
            />
          </TabsContent>

          <!-- ── 连接 ────────────────────────────────────────────────────── -->
          <TabsContent value="connections" class="flex flex-col gap-4">
            <p class="text-sm text-muted-foreground">
              缺省连接：<code class="font-mono">{{ config.defaultConnect }}</code>
            </p>
            <div class="grid gap-4 md:grid-cols-2">
              <ConnectionCard
                v-for="conn in config.connections"
                :key="conn.id"
                :connection="conn"
                :used-by="usage.get(conn.id) ?? 0"
                :is-default="conn.id === config.defaultConnect"
                @edit="viewing = $event"
              />
            </div>
          </TabsContent>

          <!-- ── 采样预设 ───────────────────────────────────────────────── -->
          <TabsContent value="presets" class="flex flex-col gap-4">
            <p class="text-sm text-muted-foreground">
              采样参数与连接是两件事：连接管「谁提供、卡多久算卡住」，预设管「怎么采样」。
              同一条连接可以被几个不同温度的环节共用。
            </p>

            <div class="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>预设</TableHead>
                    <TableHead class="w-28 text-right">temperature</TableHead>
                    <TableHead class="w-24 text-right">top_p</TableHead>
                    <TableHead class="w-28 text-right">max_tokens</TableHead>
                    <TableHead class="w-64">用在哪</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="preset in config.presets" :key="preset.id">
                    <TableCell>
                      <code class="font-mono text-sm">{{ preset.id }}</code>
                    </TableCell>
                    <TableCell class="text-right tabular-nums">{{ preset.temperature }}</TableCell>
                    <TableCell class="text-right tabular-nums">{{ preset.topP ?? "-" }}</TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ preset.maxTokens ?? "-" }}
                    </TableCell>
                    <TableCell>
                      <div class="flex flex-wrap gap-1">
                        <Badge
                          v-for="row in config.bindings.filter((b) => b.presetId === preset.id)"
                          :key="row.name"
                          variant="outline"
                        >
                          {{ agentLabel(row.name) }}
                        </Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <!-- ── 体检 ────────────────────────────────────────────────────── -->
          <TabsContent value="lint">
            <LintList
              :issues="config.issues"
              empty-text="配置体检没有发现问题：每个环节都指到了存在的连接，能力也对得上。"
            />
          </TabsContent>
        </Tabs>
      </template>

      <!-- 行详情：把「三层优先级」画出来，而不是只给结果 -->
      <Dialog :open="selected !== null" @update:open="(open) => !open && (selected = null)">
        <DialogContent v-if="selected" class="max-w-lg">
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              {{ agentLabel(selected.name) }}
              <code class="font-mono text-sm text-muted-foreground">{{ selected.name }}</code>
            </DialogTitle>
            <!-- 表里没这个名字时 purpose 为空（引擎新增了环节而前端的显示名表没跟上），
                 那就整块不渲染 —— 不拿一个占位字符去撑版式 -->
            <DialogDescription v-if="agentPurpose(selected.name)">
              {{ agentPurpose(selected.name) }}
            </DialogDescription>
          </DialogHeader>

          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-2">
              <span class="text-xs text-muted-foreground">连接是怎么定下来的</span>
              <div
                v-for="(step, index) in chain"
                :key="step.layer"
                :class="[
                  'flex items-center gap-3 rounded-md border p-2',
                  index === winnerIndex ? 'border-primary' : 'opacity-60'
                ]"
              >
                <component
                  :is="index === winnerIndex ? Check : Minus"
                  class="size-4 shrink-0 text-muted-foreground"
                />
                <div class="min-w-0 flex-1">
                  <code class="font-mono text-xs">{{ step.layer }}</code>
                  <div class="text-xs text-muted-foreground">{{ step.hint }}</div>
                </div>
                <code class="shrink-0 font-mono text-xs">{{ step.value || "未写" }}</code>
              </div>
            </div>

            <Separator />

            <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div class="flex flex-col">
                <dt class="text-xs text-muted-foreground">采样预设</dt>
                <dd class="font-mono text-xs">{{ selected.presetId || "缺省" }}</dd>
              </div>
              <div class="flex flex-col">
                <!-- 产出形状：产物长什么样（自由文本 / 一列重复块 / 分段取其一）。
                     ⚠️ 这里曾是「约束方式」（function_calling / json_schema / json_mode）——
                     引擎不再向端点索取结构化产出，那个旋钮两层一起取消了。 -->
                <dt class="text-xs text-muted-foreground">产出形状</dt>
                <dd class="font-mono text-xs">{{ OUTPUT_FORM_LABELS[selected.output] }}</dd>
              </div>
              <div class="flex flex-col">
                <dt class="text-xs text-muted-foreground">超时覆盖</dt>
                <dd class="tabular-nums">
                  {{ selected.wallTimeoutS ?? selected.timeoutS ?? "跟随连接" }}
                </dd>
              </div>
              <div class="flex flex-col">
                <dt class="text-xs text-muted-foreground">重发预算</dt>
                <dd class="tabular-nums">
                  {{ selected.maxRetries ?? selectedConnection?.maxRetries ?? "-" }} 次
                </dd>
              </div>
            </dl>

            <!-- 这笔账由引擎算（`AgentClients.time_budget_of`）= (重发预算 + 1) × 墙钟超时。
                 ⚠️ 曾经分两条公式（结构化环节还要串一段纯文本兜底），那个公式在引擎仓库里
                 算错过一次；结构化产出退役之后只剩这一条，前端更不该自己再算一遍 -->
            <p class="text-xs text-muted-foreground">
              单次调用墙钟上界
              <span class="tabular-nums text-foreground">
                {{ Math.round(selected.timeBudgetS) }}s
              </span>
            </p>

            <LintList :issues="issuesByAgent[selected.name] ?? []" />
          </div>

          <DialogFooter>
            <Button variant="outline" @click="selected = null">关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- 连接详情：整页只读，给出可以贴回 config.yaml 的片段 -->
      <Dialog :open="viewing !== null" @update:open="(open) => !open && (viewing = null)">
        <DialogContent v-if="viewing" class="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <code class="font-mono text-sm">{{ viewing.id }}</code>
            </DialogTitle>
            <DialogDescription>
              引擎只提供读口，故这里不改配置。下面这段对应
              <code class="font-mono">config.yaml</code> 的
              <code class="font-mono">connections:</code>。
            </DialogDescription>
          </DialogHeader>

          <pre
            class="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs"
          >{{ yamlPreview }}</pre>

          <DialogFooter>
            <Button variant="outline" @click="viewing = null">关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </TooltipProvider>
</template>
