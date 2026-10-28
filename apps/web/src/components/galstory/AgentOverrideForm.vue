<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"

import { agentLabel, agentPurpose } from "@/lib/galstory-agents"
import { configApi } from "@/lib/galstory"
import { diffPatch, numberOrNull } from "@/lib/galstory-form"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { AgentOverride, AgentPatch, Binding, ModelConfig } from "@/types/galstory"

/**
 * 一个环节的**覆盖项**。
 *
 * ## 这里编辑的是「原始声明」，不是「解析结果」
 *
 * 矩阵那一张表显示的是三层优先级算完之后**实际指到哪**；这个表单改的是最上面那一层
 * ——**作者在 `agents:` 里写过的那几行**。两者「空」的含义相反：矩阵里空是回落值，
 * 这里空是**没写**（于是回落）。故每一格的占位符都写着「留空 = 跟随…」，
 * 而不是把回落值填进框里假装那是作者写的。
 *
 * ## 环节名不给编辑
 *
 * 写错一个名字的后果是**整段配置静默失效**（引擎回落 `default_connect` + 缺省预设，
 * 该环节的连接/超时/提示词段全丢）。故新建时只能从引擎认识的那份清单里挑。
 */

const props = defineProps<{
  /** 要改的那一项；null = 新建一条覆盖 */
  override: AgentOverride | null
  creating: boolean
  config: ModelConfig
}>()

const emit = defineEmits<{ saved: [config: ModelConfig]; close: [] }>()

/**
 * 数字框的草稿类型是 `number | string`，**空框就是空串**（shadcn 的 Input 不收 null）。
 * 提交时再按「这一格可不可以为空」分流：`numberOrNull` 把空串变成显式 null（清掉这一项），
 * `numberOrKeep` 把空串还原成原值（这一格不允许空，用户只是把框清了）。
 */
interface Draft {
  name: string
  connectionId: string
  presetId: string
  timeoutS: number | string
  maxRetries: number | string
  wallTimeoutS: number | string
  maxOutputTokens: number | string
  cognition: string
}

/** Select 的 value 不能是空串，而「没写」是一个要显示的状态 */
const UNSET = "__unset__"
/** 认知检索三态：没写（跟引擎缺省）/ 开 / 关 */
const COGNITION = [
  { value: UNSET, label: "未写（跟这个环节的引擎缺省）" },
  { value: "on", label: "开" },
  { value: "off", label: "关" }
]

const draft = ref<Draft>(blank())

function blank(): Draft {
  return {
    name: "",
    connectionId: "",
    presetId: "",
    timeoutS: "",
    maxRetries: "",
    wallTimeoutS: "",
    maxOutputTokens: "",
    cognition: UNSET
  }
}

function fromOverride(o: AgentOverride): Draft {
  return {
    name: o.name,
    connectionId: o.connectionId,
    presetId: o.presetId,
    timeoutS: o.timeoutS ?? "",
    maxRetries: o.maxRetries ?? "",
    wallTimeoutS: o.wallTimeoutS ?? "",
    maxOutputTokens: o.maxOutputTokens ?? "",
    cognition: o.cognition === null ? UNSET : o.cognition ? "on" : "off"
  }
}

const open = computed(() => props.override !== null || props.creating)

watch(
  () => [props.override, props.creating] as const,
  ([o, creating]) => {
    if (o) draft.value = fromOverride(o)
    else if (creating) draft.value = blank()
  },
  { immediate: true }
)

/** 引擎认识的全部环节名（`bindings[]` 就是那份全集），新建时从这里挑 */
const known = computed<Binding[]>(() => props.config.bindings)

/** 已经写过覆盖项的那些 —— 新建时不该再挑到它（那是「编辑」不是「新建」） */
const alreadyOverridden = computed(() => new Set(props.config.agents.map((a) => a.name)))

const selectable = computed(() =>
  known.value.filter((b) => !alreadyOverridden.value.has(b.name))
)

/** 这个环节现在解析到的那一行 —— 每个占位符里的「跟随…」要说得出具体是什么 */
const resolved = computed(() => known.value.find((b) => b.name === draft.value.name) ?? null)

const connectionModel = computed({
  get: () => draft.value.connectionId || UNSET,
  set: (v: string) => {
    draft.value.connectionId = v === UNSET ? "" : v
  }
})

const presetModel = computed({
  get: () => draft.value.presetId || UNSET,
  set: (v: string) => {
    draft.value.presetId = v === UNSET ? "" : v
  }
})

const { run: submit, pending } = useAsyncAction(async () => {
  const name = draft.value.name.trim()
  if (!name) {
    toast.error("请选择一个环节")
    return
  }

  const original = props.override
  const cognition =
    draft.value.cognition === UNSET ? null : draft.value.cognition === "on"

  const patch: AgentPatch = diffPatch<AgentPatch>(
    {
      connectionId: draft.value.connectionId,
      presetId: draft.value.presetId,
      cognition,
      // 这几项**可为空**，清空 = 把这一行从配置里改成 null（回落连接那一层）
      timeoutS: numberOrNull(draft.value.timeoutS),
      maxRetries: numberOrNull(draft.value.maxRetries),
      wallTimeoutS: numberOrNull(draft.value.wallTimeoutS),
      maxOutputTokens: numberOrNull(draft.value.maxOutputTokens)
    },
    original === null
      ? null
      : {
          connectionId: original.connectionId,
          presetId: original.presetId,
          cognition: original.cognition,
          timeoutS: original.timeoutS,
          maxRetries: original.maxRetries,
          wallTimeoutS: original.wallTimeoutS,
          maxOutputTokens: original.maxOutputTokens
        }
  )

  if (original !== null && Object.keys(patch).length === 0) {
    toast.info("没有改动")
    emit("close")
    return
  }

  const result = await configApi.saveAgent(name, patch)
  toast.success(
    result.created ? `已为「${agentLabel(name)}」新建覆盖项` : `「${agentLabel(name)}」已保存`
  )
  emit("saved", result.config)
}, { errorMessage: "保存失败" })
</script>

<template>
  <Dialog :open="open" @update:open="(next) => !next && emit('close')">
    <DialogContent class="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {{ creating ? "新建环节覆盖项" : `编辑 ${agentLabel(draft.name)}` }}
        </DialogTitle>
        <DialogDescription>
          这里改的是<strong>作者写过的那几行</strong>，不是解析结果。每一格留空就是没写，
          由三层优先级回落。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div class="space-y-2">
          <Label for="agent-name">环节</Label>
          <!-- 新建时只能从引擎认识的清单里挑：写错一个名字 = 整段配置静默失效 -->
          <Select v-if="creating" id="agent-name" v-model="draft.name">
            <SelectTrigger><SelectValue placeholder="选一个环节" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="b in selectable" :key="b.name" :value="b.name">
                {{ agentLabel(b.name) }}（{{ b.name }}）
              </SelectItem>
            </SelectContent>
          </Select>
          <div v-else class="flex items-center gap-2">
            <code class="font-mono text-sm">{{ draft.name }}</code>
            <span v-if="override && !override.known" class="text-xs text-destructive">
              引擎不认识这个环节 —— 它的配置运行期会被静默丢掉
            </span>
          </div>
          <p v-if="draft.name && agentPurpose(draft.name)" class="text-xs text-muted-foreground">
            {{ agentPurpose(draft.name) }}
          </p>
          <p v-else-if="creating && selectable.length === 0" class="text-xs text-muted-foreground">
            每个环节都已经有覆盖项了 —— 直接在下面的表里编辑。
          </p>
        </div>

        <Separator />

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="agent-conn">连接</Label>
            <Select id="agent-conn" v-model="connectionModel">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="UNSET">未写（按类绑定 / 缺省连接）</SelectItem>
                <SelectItem v-for="c in config.connections" :key="c.id" :value="c.id">
                  {{ c.id }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="resolved" class="text-xs text-muted-foreground">
              不写的话现在会解析到
              <code class="font-mono">{{ resolved.connectionId }}</code>
            </p>
          </div>

          <div class="space-y-2">
            <Label for="agent-preset">采样预设</Label>
            <Select id="agent-preset" v-model="presetModel">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="UNSET">未写（缺省预设）</SelectItem>
                <SelectItem v-for="p in config.presets" :key="p.id" :value="p.id">
                  {{ p.id }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label for="agent-timeout">timeout_s</Label>
            <Input
              id="agent-timeout"
              v-model="draft.timeoutS"
              type="number"
              step="1"
              placeholder="留空 = 跟随连接"
            />
          </div>

          <div class="space-y-2">
            <Label for="agent-retries">max_retries</Label>
            <Input
              id="agent-retries"
              v-model="draft.maxRetries"
              type="number"
              step="1"
              placeholder="留空 = 跟随连接"
            />
            <!-- 放宽窗口必须同时收窄重发预算，否则单次调用的墙钟上界反而变长了 -->
            <p class="text-xs text-muted-foreground">
              墙钟上界 =（这个数 + 1）× 墙钟超时 —— 放宽超时就要同时收窄它。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="agent-wall">wall_timeout_s</Label>
            <Input
              id="agent-wall"
              v-model="draft.wallTimeoutS"
              type="number"
              step="1"
              placeholder="留空 = 回落 timeout_s"
            />
            <p class="text-xs text-muted-foreground">
              流式下它只管「首块之前」—— 在吐字就是在跑，卡顿归 chunk_timeout_s 判。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="agent-out-tokens">max_output_tokens</Label>
            <Input
              id="agent-out-tokens"
              v-model="draft.maxOutputTokens"
              type="number"
              step="1000"
              placeholder="留空 = 跟随连接"
            />
          </div>

          <div class="space-y-2 sm:col-span-2">
            <Label for="agent-cognition">认知检索</Label>
            <Select id="agent-cognition" v-model="draft.cognition">
              <SelectTrigger class="w-full sm:w-80"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="opt in COGNITION" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              故事那一侧的 <code class="font-mono">agentloop</code> 是总开关；这里是按环节细调。
            </p>
          </div>
        </div>

        <p v-if="resolved" class="text-xs text-muted-foreground">
          当前解析结果：单次调用墙钟上界
          <span class="tabular-nums text-foreground">{{ Math.round(resolved.timeBudgetS) }}s</span>
          （由引擎算，保存后会跟着变）。
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="emit('close')">取消</Button>
        <Button :loading="pending" @click="submit()">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
