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
import { Switch } from "@/components/ui/switch"

import { configApi } from "@/lib/galstory"
import { diffPatch, numberOrKeep, numberOrNull } from "@/lib/galstory-form"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { Connection, ConnectionPatch, ModelConfig } from "@/types/galstory"
import { PROVIDER_REASONING, PROVIDERS } from "@/types/galstory"

/**
 * 一条模型连接的编辑表单。
 *
 * ## 三件事这里刻意不做
 *
 * 1. **不收 API key 的值**。配置里存的是**环境变量名**，值只在 `.env`/真实环境里。开一个能填
 *    key 的框，等于让一份本该只有变量名的配置文件开始装密钥（接口那一侧压根没有这个字段）。
 * 2. **不给 `extra_body`**。那是原样透传的厂商私有信封、引擎自己都不解析，接口只出「有没有
 *    关掉思考」这个结论而不出内容 —— 有些厂商的鉴权参数就走请求体。要改它去改 `config.yaml`。
 * 3. **不改 `id`**。改 id 是「删一条建一条」（还要把指着它的地方一起改），不是一次 patch。
 *
 * ## 推理档位的下拉框按 provider 收窄
 *
 * ⚠️ 表里没有的那一档**不是「差不多」**：引擎当作没声明并告警、**绝不折算到邻近档**，即那一行
 * 写下去思考开关根本不生效，而现象只是账单变了。写口那边会 400 拦住，这里是不让人走到那一步。
 */

const props = defineProps<{
  /** 要改的那条；null = 新建 */
  connection: Connection | null
  /** 新建模式（`connection` 为 null 时才看它） */
  creating: boolean
  config: ModelConfig
}>()

const emit = defineEmits<{
  /** 写成功了，带回引擎重新解析过的整份配置 */
  saved: [config: ModelConfig]
  close: []
}>()

/**
 * 数字框的草稿类型是 `number | string`，**空框就是空串**（shadcn 的 Input 不收 null）。
 * 提交时再按「这一格可不可以为空」分流：`numberOrNull` 把空串变成显式 null（清掉这一项），
 * `numberOrKeep` 把空串还原成原值（这一格不允许空，用户只是把框清了）。
 */
interface Draft {
  id: string
  provider: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  timeoutS: number | string
  maxRetries: number | string
  reasoning: string
  toolCall: boolean
  stream: boolean
  idleTimeoutS: number | string
  chunkTimeoutS: number | string
  maxOutputTokens: number | string
  maxCallSeconds: number | string
  streamUsage: boolean
  contextWindow: number | string
  commitWatermark: number | string
}

/** 没声明推理档位是一个**要显示的状态**，而 Select 的 value 不能是空串，故给它一个哨兵 */
const UNSET = "__unset__"

const draft = ref<Draft>(blank())

function blank(): Draft {
  return {
    id: "",
    provider: "openai_compatible",
    model: "",
    baseUrl: "",
    apiKeyEnv: "",
    timeoutS: "",
    maxRetries: "",
    reasoning: "",
    toolCall: true,
    stream: false,
    idleTimeoutS: "",
    chunkTimeoutS: "",
    maxOutputTokens: "",
    maxCallSeconds: "",
    streamUsage: true,
    contextWindow: "",
    commitWatermark: ""
  }
}

function fromConnection(conn: Connection): Draft {
  return {
    id: conn.id,
    provider: conn.provider,
    model: conn.model,
    baseUrl: conn.baseUrl,
    apiKeyEnv: conn.apiKeyEnv,
    timeoutS: conn.timeoutS ?? "",
    maxRetries: conn.maxRetries ?? "",
    reasoning: conn.reasoning,
    toolCall: conn.toolCall,
    stream: conn.stream,
    idleTimeoutS: conn.idleTimeoutS ?? "",
    chunkTimeoutS: conn.chunkTimeoutS ?? "",
    maxOutputTokens: conn.maxOutputTokens ?? "",
    maxCallSeconds: conn.maxCallSeconds ?? "",
    streamUsage: conn.streamUsage,
    contextWindow: conn.contextWindow ?? "",
    commitWatermark: conn.commitWatermark
  }
}

const open = computed(() => props.connection !== null || props.creating)

watch(
  () => [props.connection, props.creating] as const,
  ([conn, creating]) => {
    if (conn) draft.value = fromConnection(conn)
    else if (creating) draft.value = blank()
  },
  { immediate: true }
)

/** 这个 provider 实际有哪几档推理（`PROVIDER_REASONING` 是引擎那张表的镜像） */
const levels = computed(() => PROVIDER_REASONING[draft.value.provider] ?? [])

/**
 * 换 provider 之后，原来选的那一档新厂商可能没有。**当场清掉并说一句**，别留着一个
 * 保存时才 400 的值 —— 更别默默换成邻近档（那正是引擎明令不做的事）。
 */
watch(
  () => draft.value.provider,
  () => {
    const level = draft.value.reasoning
    if (level && !levels.value.includes(level)) {
      draft.value.reasoning = ""
      toast.info(`${draft.value.provider} 没有「${level}」这一档，推理档位已清空`)
    }
  }
)

const reasoningModel = computed({
  get: () => draft.value.reasoning || UNSET,
  set: (value: string) => {
    draft.value.reasoning = value === UNSET ? "" : value
  }
})

/** 新建时 id 会成为路径的一段，也会成为别处引用它的字面量 —— 空格与斜杠一律不收 */
const ID_RE = /^[A-Za-z0-9_.-]+$/

const { run: submit, pending } = useAsyncAction(async () => {
  const id = draft.value.id.trim()
  if (!id) {
    toast.error("请填写连接 id")
    return
  }
  if (!ID_RE.test(id)) {
    toast.error("连接 id 只能用字母、数字、下划线、点和短横线")
    return
  }
  if (props.creating && props.config.connections.some((c) => c.id === id)) {
    toast.error(`已经有一条叫「${id}」的连接了`)
    return
  }

  const original = props.connection
  // ⚠️ **只发改过的键**（见 `galstory-form.ts` 模块头）：整份回传会把引擎缺省值写死进
  // 用户的 config.yaml，那些行他从来没写过。
  const patch: ConnectionPatch = diffPatch<ConnectionPatch>(
    {
      provider: draft.value.provider,
      model: draft.value.model.trim(),
      baseUrl: draft.value.baseUrl.trim(),
      apiKeyEnv: draft.value.apiKeyEnv.trim(),
      // 不可为空的几项：框清空了就保持原值，绝不发 null 过去
      timeoutS: numberOrKeep(draft.value.timeoutS, original?.timeoutS ?? 40),
      maxRetries: numberOrKeep(draft.value.maxRetries, original?.maxRetries ?? 2),
      chunkTimeoutS: numberOrKeep(draft.value.chunkTimeoutS, original?.chunkTimeoutS ?? 20),
      maxOutputTokens: numberOrKeep(
        draft.value.maxOutputTokens,
        original?.maxOutputTokens ?? 125000
      ),
      maxCallSeconds: numberOrKeep(draft.value.maxCallSeconds, original?.maxCallSeconds ?? 1800),
      commitWatermark: numberOrKeep(draft.value.commitWatermark, original?.commitWatermark ?? 0.6),
      // 可为空的几项：清空就是显式清掉
      idleTimeoutS: numberOrNull(draft.value.idleTimeoutS),
      contextWindow: numberOrNull(draft.value.contextWindow),
      reasoning: draft.value.reasoning,
      toolCall: draft.value.toolCall,
      stream: draft.value.stream,
      streamUsage: draft.value.streamUsage
    },
    original === null
      ? null
      : {
          provider: original.provider,
          model: original.model,
          baseUrl: original.baseUrl,
          apiKeyEnv: original.apiKeyEnv,
          timeoutS: original.timeoutS,
          maxRetries: original.maxRetries,
          chunkTimeoutS: original.chunkTimeoutS,
          maxOutputTokens: original.maxOutputTokens,
          maxCallSeconds: original.maxCallSeconds,
          commitWatermark: original.commitWatermark,
          idleTimeoutS: original.idleTimeoutS,
          contextWindow: original.contextWindow,
          reasoning: original.reasoning,
          toolCall: original.toolCall,
          stream: original.stream,
          streamUsage: original.streamUsage
        }
  )

  if (original !== null && Object.keys(patch).length === 0) {
    toast.info("没有改动")
    emit("close")
    return
  }

  const result = await configApi.saveConnection(id, patch)
  toast.success(result.created ? `连接「${id}」已创建` : `连接「${id}」已保存`)
  emit("saved", result.config)
}, { errorMessage: "保存失败" })
</script>

<template>
  <Dialog :open="open" @update:open="(next) => !next && emit('close')">
    <DialogContent class="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ creating ? "新建连接" : `编辑连接 ${draft.id}` }}</DialogTitle>
        <DialogDescription>
          连接管的是「谁提供、卡多久算卡住」；「怎么采样」在采样预设里，两件事分开配。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="conn-id">id</Label>
            <Input
              id="conn-id"
              v-model="draft.id"
              :disabled="!creating"
              placeholder="例如：ollama_kimi"
            />
            <!-- 改 id 是「删一条建一条」，还要把指着它的地方一起改 —— 不做成一个输入框 -->
            <p v-if="!creating" class="text-xs text-muted-foreground">
              id 不能改：改它等于删一条再建一条，指着它的那几处也要跟着改。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="conn-provider">provider</Label>
            <Select id="conn-provider" v-model="draft.provider">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="name in PROVIDERS" :key="name" :value="name">
                  {{ name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              它只提供厂商缺省的地址、key 变量名与推理档位的线上写法，协议都是 OpenAI 兼容。
            </p>
          </div>

          <div class="space-y-2">
            <Label for="conn-model">model</Label>
            <Input id="conn-model" v-model="draft.model" placeholder="例如：deepseek-v4-flash" />
          </div>

          <div class="space-y-2">
            <Label for="conn-base-url">base_url</Label>
            <Input
              id="conn-base-url"
              v-model="draft.baseUrl"
              placeholder="留空 = 用 provider 的缺省地址"
            />
          </div>

          <div class="space-y-2 sm:col-span-2">
            <Label for="conn-key-env">api_key_env</Label>
            <Input id="conn-key-env" v-model="draft.apiKeyEnv" placeholder="例如：DEEPSEEK_API_KEY" />
            <!-- 这一条要说清楚，否则一定有人往这里填 key 本身 -->
            <p class="text-xs text-muted-foreground">
              填的是**环境变量名**，不是 key 本身。key 只放在 <code class="font-mono">.env</code>
              或真实环境里 —— 配置文件里永远不该出现它的值。
            </p>
          </div>
        </div>

        <Separator />

        <!-- ── 该不该为思考付钱 ─────────────────────────────────────────── -->
        <div class="space-y-2">
          <Label for="conn-reasoning">推理档位</Label>
          <Select id="conn-reasoning" v-model="reasoningModel">
            <SelectTrigger class="w-full sm:w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="UNSET">未声明（用端点缺省）</SelectItem>
              <SelectItem v-for="level in levels" :key="level" :value="level">
                {{ level }}{{ level === "off" ? "（关思考）" : "" }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            下拉里只列
            <code class="font-mono">{{ draft.provider }}</code>
            实际有的那几档。厂商没有的那一档不是「差不多」—— 引擎当作没声明并告警、绝不折算到
            邻近档，即那一行写下去思考开关根本不生效，而现象只是账单变了。
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="conn-tool-call">工具调用</Label>
              <p class="text-xs text-muted-foreground">只管工具循环（认知检索 / skill）</p>
            </div>
            <Switch id="conn-tool-call" v-model="draft.toolCall" />
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="conn-stream">流式</Label>
              <p class="text-xs text-muted-foreground">开了之后超时拆成三个数，见下</p>
            </div>
            <Switch id="conn-stream" v-model="draft.stream" />
          </div>
        </div>

        <Separator />

        <!-- ── 超时与闸门 ───────────────────────────────────────────────── -->
        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-2">
            <Label for="conn-timeout">timeout_s</Label>
            <Input id="conn-timeout" v-model="draft.timeoutS" type="number" step="1" />
            <p class="text-xs text-muted-foreground">非流式下 = 单次调用总时长</p>
          </div>

          <div class="space-y-2">
            <Label for="conn-retries">max_retries</Label>
            <Input id="conn-retries" v-model="draft.maxRetries" type="number" step="1" />
            <p class="text-xs text-muted-foreground">只对传输类失败重发</p>
          </div>

          <div class="space-y-2">
            <Label for="conn-context">context_window</Label>
            <Input
              id="conn-context"
              v-model="draft.contextWindow"
              type="number"
              step="1"
              placeholder="留空 = 不判"
            />
            <p class="text-xs text-muted-foreground">引擎不内置模型表，按实际端点填</p>
          </div>
        </div>

        <div v-if="draft.stream" class="grid gap-4 rounded-md border p-3 sm:grid-cols-3">
          <div class="space-y-2">
            <Label for="conn-idle">idle_timeout_s</Label>
            <Input
              id="conn-idle"
              v-model="draft.idleTimeoutS"
              type="number"
              step="1"
              placeholder="留空 = 跟 timeout_s"
            />
            <p class="text-xs text-muted-foreground">socket 静默，只测得出连接死了</p>
          </div>

          <div class="space-y-2">
            <Label for="conn-chunk">chunk_timeout_s</Label>
            <Input id="conn-chunk" v-model="draft.chunkTimeoutS" type="number" step="1" />
            <!-- 这是流式下真正的卡顿检测；要收紧就收它，别去收墙钟 -->
            <p class="text-xs text-muted-foreground">
              两个内容块之间的间隔 —— 流式下真正的卡顿检测
            </p>
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="conn-usage">stream_usage</Label>
              <p class="text-xs text-muted-foreground">关了 max_context 阈值永不触发</p>
            </div>
            <Switch id="conn-usage" v-model="draft.streamUsage" />
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-2">
            <Label for="conn-out-tokens">max_output_tokens</Label>
            <Input id="conn-out-tokens" v-model="draft.maxOutputTokens" type="number" step="1000" />
            <p class="text-xs text-muted-foreground">失控兜底，0 = 关。不是采样上限</p>
          </div>

          <div class="space-y-2">
            <Label for="conn-call-seconds">max_call_seconds</Label>
            <Input id="conn-call-seconds" v-model="draft.maxCallSeconds" type="number" step="60" />
            <p class="text-xs text-muted-foreground">总时长兜底，0 = 关</p>
          </div>

          <div class="space-y-2">
            <Label for="conn-watermark">commit_watermark</Label>
            <Input
              id="conn-watermark"
              v-model="draft.commitWatermark"
              type="number"
              step="0.05"
              min="0"
              max="1"
            />
            <p class="text-xs text-muted-foreground">提交触发线 = 窗口 × 它</p>
          </div>
        </div>

        <!-- 这两样刻意不给编辑面，说清楚而不是假装没有 -->
        <p class="text-xs text-muted-foreground">
          <code class="font-mono">extra_body</code>
          （厂商私有信封）只能在 <code class="font-mono">config.yaml</code> 里改：它原样透传、
          引擎自己都不解析，而有些厂商的鉴权参数就走请求体，故接口刻意不出它的内容。
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="pending" @click="emit('close')">取消</Button>
        <Button :loading="pending" @click="submit()">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
