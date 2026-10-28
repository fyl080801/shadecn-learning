<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, FileCog, Lock, Minus, Plus } from "@lucide/vue"

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

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"

import AgentBindingMatrix from "@/components/galstory/AgentBindingMatrix.vue"
import AgentOverrideForm from "@/components/galstory/AgentOverrideForm.vue"
import ConnectionForm from "@/components/galstory/ConnectionForm.vue"
import GeneralForm from "@/components/galstory/GeneralForm.vue"
import PresetForm from "@/components/galstory/PresetForm.vue"
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
import { GalStoryError, configApi, countLevels } from "@/lib/galstory"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { toast } from "vue-sonner"
import type {
  AgentOverride,
  Binding,
  Connection,
  LintIssue,
  ModelConfig,
  Preset
} from "@/types/galstory"

/**
 * 模型配置（`GET /api/config`）。
 *
 * 页签的顺序是有判据的：**「Agent 绑定」排第一** —— 这一页真正要回答的问题是
 * 「哪一步指到哪条连接、够不够用」，而不是「这些连接各自长什么样」。连接与预设是那张矩阵的
 * **词表**，所以排在它后面。
 *
 * ## 可写了，但「能不能写」由引擎说了算
 *
 * 这一页曾经整页只读（引擎那时只有读口、反代只转发 GET）。现在引擎有了写回那一族，反代也在
 * `WRITE_ALLOW` 里逐条放行了它们 —— 但**判据仍然不在前端**：`config.writable` 是引擎给的
 * （文件在不在、有没有写权限），`writable` 为 false 时这一页退回只读形态并把原因照原文显示。
 * 那条老纪律一个字没变：**一个点了必然失败的按钮比没有更糟**。
 *
 * ## 写回是 patch，不是整份回传
 *
 * 每个表单提交前都 `diffPatch`，**只发真正改过的那几个键**。整份回传会把引擎缺省值写死进
 * 用户的 `config.yaml`（那些行他从来没写过），还会让两个人的并发改动互相覆盖。
 *
 * ## 写完之后拿回执替换整份 config
 *
 * 改一条连接会让若干环节的绑定、时间预算、体检结论一起变。回执里带着引擎**重新解析过**的
 * 那一份，直接换上即可 —— 既省一次 GET，也堵掉「前端自己再算一遍三层优先级」那条明令禁止的路。
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

// ── 编辑：写完拿回执替换整份 config ──────────────────────────────────────────

/** 引擎说这份文件改不改得动。**判据不在前端**，见组件块注释 */
const writable = computed(() => config.value?.writable ?? false)

/** 每次写成功都走这里 —— 回执里那份是引擎重新解析过的，直接换上 */
function applySaved(next: ModelConfig) {
  config.value = next
  editingConnection.value = null
  creatingConnection.value = false
  editingPreset.value = null
  creatingPreset.value = false
  editingAgent.value = null
  creatingAgent.value = false
}

const editingConnection = ref<Connection | null>(null)
const creatingConnection = ref(false)
const editingPreset = ref<Preset | null>(null)
const creatingPreset = ref(false)
const editingAgent = ref<AgentOverride | null>(null)
const creatingAgent = ref(false)

/**
 * 待确认的删除。
 *
 * ⚠️ **两段式**：第一次不带 `force`，引擎那边如果还有人指着它就回 409 **并列出是谁** ——
 * 那不是「删不掉」，是「删掉之后那几处会静默回落到缺省连接与缺省预设，超时/重试/预设一起丢，
 * 而现象只是模型行为莫名其妙变了」。把那句话原样摆给人看，再让他决定要不要 `force`。
 */
const pendingDelete = ref<
  { kind: "connection" | "preset" | "agent"; id: string; conflict: string } | null
>(null)

/**
 * ⚠️ **「开关」与「删哪一个」是两个 ref**，而且这一颗确认按钮**不能用 `AlertDialogAction`**。
 *
 * 它内部就是 `DialogClose` —— **先关掉对话框、再**跑透传下来的 `@click`，而那句关闭是裸的
 * `onOpenChange(false)`、**不看 `event.defaultPrevented`**，故 `@click.prevent` 挡不住（试过）。
 * 合成一个 ref 的话 handler 读到的是被关闭清掉的 null，请求一声不响地发不出去；而就算拆成两个
 * ref，用 `AlertDialogAction` 也会把上面那段**两段式**顶掉 —— 409 之后要把「谁还指着它」留在
 * 框里给人看，可框已经被它关了。故确认那一颗是普通 `Button`，关框由这里的代码显式决定。
 * 同一个坑在 `FlowList.vue` / `LinkedAccounts.vue` / `ProgressDialog.vue` 里各钉过一次。
 */
const deleteOpen = ref(false)

function askDelete(kind: "connection" | "preset" | "agent", id: string) {
  pendingDelete.value = { kind, id, conflict: "" }
  deleteOpen.value = true
}

const { run: confirmDelete, pending: deleting } = useAsyncAction(async (force: boolean) => {
  const target = pendingDelete.value
  if (!target) return
  try {
    const result =
      target.kind === "connection"
        ? await configApi.deleteConnection(target.id, force)
        : target.kind === "preset"
          ? await configApi.deletePreset(target.id, force)
          : await configApi.deleteAgent(target.id)
    // 框由这里关（确认那一颗不是 AlertDialogAction，见 askDelete 上面那段）。
    // `pendingDelete` 留着：关闭有动画，清掉会让框里的文案在收起途中变成空白。
    deleteOpen.value = false
    toast.success(`「${target.id}」已删除`)
    applySaved(result.config)
  } catch (err) {
    // 409 = 还被指着。**留在对话框里**把引擎那句话显示出来，别弹一个 toast 就把框关了 ——
    // 那句话里有「谁指着它」，而那正是决定要不要强删所需要的全部信息。
    if (err instanceof GalStoryError && err.status === 409) {
      pendingDelete.value = { ...target, conflict: err.message }
      return
    }
    throw err
  }
}, { errorMessage: "删除失败" })

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
    // 新字段优先：`reasoning_effort` 是弃用的旧写法，引擎装载期会点名让改
    conn.reasoning ? `  reasoning: ${conn.reasoning}` : null,
    !conn.reasoning && conn.reasoningEffort
      ? `  reasoning_effort: ${conn.reasoningEffort}`
      : null,
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
        <!-- 这一页写的就是这个文件 —— 路径直接给出来 -->
        <div
          v-if="config.sourceFile"
          class="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
        >
          <FileCog class="size-4 shrink-0" />
          <span>这一页写的是：</span>
          <code class="truncate font-mono text-xs">{{ config.sourceFile }}</code>
          <span v-if="config.format === 'yaml'" class="ml-auto shrink-0 text-xs">
            写回保留文件里的注释与引擎读不到的键
          </span>
        </div>

        <!-- 改不动时退回只读形态，并把引擎给的原因照原文显示（不在前端重编一份文案） -->
        <div
          v-if="!writable"
          class="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
        >
          <Lock class="size-4 shrink-0" />
          <span>{{ config.readOnlyReason || "这份配置当前只读" }}</span>
        </div>

        <Tabs default-value="bindings" class="flex min-h-0 flex-1 flex-col gap-4">
          <TabsList>
            <TabsTrigger value="bindings">Agent 绑定</TabsTrigger>
            <TabsTrigger value="general">常规</TabsTrigger>
            <TabsTrigger value="connections">连接 {{ config.connections.length }}</TabsTrigger>
            <TabsTrigger value="presets">采样预设 {{ config.presets.length }}</TabsTrigger>
            <TabsTrigger value="lint">体检</TabsTrigger>
          </TabsList>

          <!-- ── 常规：顶层那几个键 ──────────────────────────────────────── -->
          <TabsContent value="general">
            <!-- 只读时整块不给（表单里全是会发请求的控件），改用一句话指回文件 -->
            <GeneralForm v-if="writable" :config="config" @saved="applySaved" />
            <p v-else class="text-sm text-muted-foreground">
              这份配置当前只读，改它请直接编辑
              <code class="font-mono text-xs">{{ config.sourceFile || "config.yaml" }}</code>
              。
            </p>
          </TabsContent>

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

            <!-- ⚠️ 这张表与上面那张矩阵**刻意不是同一个东西**：矩阵是三层算完的解析结果，
                 这里是作者**显式写过**的那几行。「空」在两边含义相反，合并会把它们弄混。 -->
            <Separator />

            <div class="flex flex-wrap items-center gap-3">
              <div class="flex-1">
                <h2 class="text-sm font-medium">环节覆盖项</h2>
                <p class="text-xs text-muted-foreground">
                  作者在 <code class="font-mono">agents:</code> 里显式写过的那几行 ——
                  上面矩阵显示的是它们回落之后的解析结果。
                </p>
              </div>
              <Button v-if="writable" size="sm" variant="outline" @click="creatingAgent = true">
                <Plus class="size-4" />
                新建覆盖项
              </Button>
            </div>

            <div v-if="config.agents.length" class="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>环节</TableHead>
                    <TableHead class="w-40">连接</TableHead>
                    <TableHead class="w-28">预设</TableHead>
                    <TableHead class="w-32 text-right">超时 / 重发</TableHead>
                    <TableHead class="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in config.agents" :key="row.name">
                    <TableCell>
                      <div class="flex flex-col">
                        <span class="text-sm">{{ agentLabel(row.name) }}</span>
                        <code class="font-mono text-xs text-muted-foreground">{{ row.name }}</code>
                        <!-- 引擎不认识 = 运行期静默回落，整段配置白写。标出来 -->
                        <span v-if="!row.known" class="text-xs text-destructive">
                          引擎不认识它 —— 这一段配置运行期会被丢掉
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code class="font-mono text-xs">{{ row.connectionId || "未写" }}</code>
                    </TableCell>
                    <TableCell>
                      <code class="font-mono text-xs">{{ row.presetId || "未写" }}</code>
                    </TableCell>
                    <TableCell class="text-right tabular-nums text-xs">
                      {{ row.wallTimeoutS ?? row.timeoutS ?? "-" }}s ·
                      {{ row.maxRetries ?? "-" }}
                    </TableCell>
                    <TableCell class="text-right">
                      <div v-if="writable" class="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" @click="editingAgent = row">编辑</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-destructive"
                          @click="askDelete('agent', row.name)"
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <p v-else class="text-sm text-muted-foreground">
              还没有任何覆盖项 —— 每个环节都按「按类绑定 &gt; 缺省连接」回落。
            </p>
          </TabsContent>

          <!-- ── 连接 ────────────────────────────────────────────────────── -->
          <TabsContent value="connections" class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center gap-3">
              <p class="flex-1 text-sm text-muted-foreground">
                缺省连接：<code class="font-mono">{{ config.defaultConnect || "未配" }}</code>
              </p>
              <Button v-if="writable" size="sm" variant="outline" @click="creatingConnection = true">
                <Plus class="size-4" />
                新建连接
              </Button>
            </div>
            <div class="grid gap-4 md:grid-cols-2">
              <ConnectionCard
                v-for="conn in config.connections"
                :key="conn.id"
                :connection="conn"
                :used-by="usage.get(conn.id) ?? 0"
                :is-default="conn.id === config.defaultConnect"
                :readonly="!writable"
                @edit="writable ? (editingConnection = $event) : (viewing = $event)"
                @remove="askDelete('connection', $event.id)"
              />
            </div>
          </TabsContent>

          <!-- ── 采样预设 ───────────────────────────────────────────────── -->
          <TabsContent value="presets" class="flex flex-col gap-4">
            <div class="flex flex-wrap items-center gap-3">
              <p class="flex-1 text-sm text-muted-foreground">
                采样参数与连接是两件事：连接管「谁提供、卡多久算卡住」，预设管「怎么采样」。
                同一条连接可以被几个不同温度的环节共用。
              </p>
              <Button v-if="writable" size="sm" variant="outline" @click="creatingPreset = true">
                <Plus class="size-4" />
                新建预设
              </Button>
            </div>

            <div class="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>预设</TableHead>
                    <TableHead class="w-28 text-right">temperature</TableHead>
                    <TableHead class="w-24 text-right">top_p</TableHead>
                    <TableHead class="w-28 text-right">max_tokens</TableHead>
                    <TableHead class="w-64">用在哪</TableHead>
                    <TableHead class="w-28" />
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
                    <TableCell class="text-right">
                      <div v-if="writable" class="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" @click="editingPreset = preset">
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-destructive"
                          @click="askDelete('preset', preset.id)"
                        >
                          删除
                        </Button>
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

      <!-- ── 表单 ────────────────────────────────────────────────────────
           只在可写时挂：不可写时连接卡片走的是下面那个只读的 yaml 片段对话框 -->
      <template v-if="config && writable">
        <ConnectionForm
          :connection="editingConnection"
          :creating="creatingConnection"
          :config="config"
          @saved="applySaved"
          @close="((editingConnection = null), (creatingConnection = false))"
        />
        <PresetForm
          :preset="editingPreset"
          :creating="creatingPreset"
          :config="config"
          @saved="applySaved"
          @close="((editingPreset = null), (creatingPreset = false))"
        />
        <AgentOverrideForm
          :override="editingAgent"
          :creating="creatingAgent"
          :config="config"
          @saved="applySaved"
          @close="((editingAgent = null), (creatingAgent = false))"
        />
      </template>

      <!-- 删除确认。**两段式**：第一次不带 force，引擎回 409 时把「谁还指着它」原样摆出来，
           再让人决定要不要强删 —— 那句话里有做这个决定所需要的全部信息 -->
      <AlertDialog :open="deleteOpen" @update:open="(open) => !open && (deleteOpen = false)">
        <AlertDialogContent v-if="pendingDelete">
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除
              <code class="font-mono text-sm">{{ pendingDelete.id }}</code>
              ？
            </AlertDialogTitle>
            <AlertDialogDescription>
              <template v-if="pendingDelete.conflict">{{ pendingDelete.conflict }}</template>
              <template v-else-if="pendingDelete.kind === 'agent'">
                这只删掉它的<strong>覆盖项</strong>（环节由引擎定义，不会消失），删完按三层优先级
                回落。⚠️ 该环节在配置里写的提示词段也会跟着删掉。
              </template>
              <template v-else>这一项会从配置文件里删掉。</template>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="deleting">取消</AlertDialogCancel>
            <!-- 冲突之后那一颗才是「强删」：文案要跟着变，别让两次点的是同一句话。
                 ⚠️ 这里**刻意不是 `AlertDialogAction`** —— 它会先关框，两段式就没地方显示了 -->
            <Button
              :disabled="deleting"
              @click="confirmDelete(Boolean(pendingDelete.conflict))"
            >
              {{ pendingDelete.conflict ? "仍然删除" : "删除" }}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <!-- 连接详情：只读形态下给出可以贴回 config.yaml 的片段 -->
      <Dialog :open="viewing !== null" @update:open="(open) => !open && (viewing = null)">
        <DialogContent v-if="viewing" class="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <code class="font-mono text-sm">{{ viewing.id }}</code>
            </DialogTitle>
            <DialogDescription>
              这份配置当前只读，故这里不改。下面这段对应
              <code class="font-mono">config.yaml</code> 的
              <code class="font-mono">connections:</code>，可以直接贴回去。
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
