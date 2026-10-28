<script setup lang="ts">
import { computed, ref, watch } from "vue"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

import { AGENT_KIND_HINTS, AGENT_KIND_LABELS, AGENT_KINDS } from "@/lib/galstory-agents"
import { configApi } from "@/lib/galstory"
import { diffPatch, linesToList, listToLines, numberOrKeep } from "@/lib/galstory-form"
import { useAsyncAction } from "@/composables/useAsyncAction"
import type { AgentKind, ConfigPatch, ModelConfig } from "@/types/galstory"

/**
 * 顶层那几个键：缺省连接 / 按类绑定 / 核验总开关 / 日志 / skill 与插件增量。
 *
 * **这一页有保存按钮，而连接与预设那两个 tab 是即时对话框** —— 判据是「一次改动是不是一件
 * 完整的事」：改一条连接是，而这里的几个开关常常是一起调的（换 provider 时缺省连接与两条
 * 绑定要一块儿改），分开保存会让配置在中间态上停留一会儿。
 *
 * ⚠️ 提交仍然只发**改动过的键**（`diffPatch`）：整份回传会把引擎缺省值写死进用户的
 * `config.yaml`，那些行他从来没写过。
 */

const props = defineProps<{ config: ModelConfig }>()
const emit = defineEmits<{ saved: [config: ModelConfig] }>()

/** 核验三态。Select 的 value 不能是 null，故用哨兵串 */
const VERIFY = [
  { value: "inherit", label: "跟随 story.yaml（缺省）" },
  { value: "off", label: "总开关关掉" },
  { value: "on", label: "全开" }
]

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"]

/** 「未配，走缺省连接」是一个要显示的状态，而 Select 的 value 不能是空串 */
const UNSET = "__unset__"

interface Draft {
  defaultConnect: string
  /**
   * 按类绑定。**值里直接存哨兵**（`UNSET` = 「未配，走缺省连接」），而不是空串 ——
   * Select 的 value 不能是空串，存哨兵就能 `v-model` 直连，不必为每个键各造一个读写代理。
   */
  bindings: Record<AgentKind, string>
  verify: string
  logEnable: boolean
  logLevel: string
  logPrompts: boolean
  logOutputs: boolean
  logMaxChars: number | string
  logTokens: boolean
  skills: string
  plugins: string
}

function fromConfig(config: ModelConfig): Draft {
  return {
    defaultConnect: config.defaultConnect,
    bindings: Object.fromEntries(
      AGENT_KINDS.map((kind) => [kind, config.agentBindings[kind] || UNSET])
    ) as Record<AgentKind, string>,
    verify: config.verify === null ? "inherit" : config.verify ? "on" : "off",
    logEnable: config.log.enable,
    logLevel: config.log.level,
    logPrompts: config.log.prompts,
    logOutputs: config.log.outputs,
    logMaxChars: config.log.maxChars,
    logTokens: config.log.tokens,
    skills: listToLines(config.skills),
    plugins: listToLines(config.plugins)
  }
}

const draft = ref<Draft>(fromConfig(props.config))

// 保存之后父组件会换掉 config（回执里带着重新解析过的那一份）—— 草稿要跟着重置，
// 否则下一次 diff 的基线还是上一次的旧值，改动会被算成「没改」。
watch(() => props.config, (next) => (draft.value = fromConfig(next)))

// `bindings` 是个对象，逐键比会退化成引用比较 —— 整体序列化比一次最省事也最不会漏
const dirty = computed(
  () => JSON.stringify(fromConfig(props.config)) !== JSON.stringify(draft.value)
)

const { run: submit, pending } = useAsyncAction(async () => {
  const base = props.config
  const patch: ConfigPatch = {}

  if (draft.value.defaultConnect !== base.defaultConnect) {
    patch.defaultConnect = draft.value.defaultConnect
  }

  // 绑定按键合并：只把改了的那几个键发过去（哨兵在这里还原成空串 = 「没配」）
  const bindings: Record<string, string> = {}
  for (const kind of AGENT_KINDS) {
    const next = draft.value.bindings[kind] === UNSET ? "" : draft.value.bindings[kind]
    if (next !== (base.agentBindings[kind] || "")) bindings[kind] = next
  }
  if (Object.keys(bindings).length) patch.agentBindings = bindings

  const verify = draft.value.verify === "inherit" ? null : draft.value.verify === "on"
  if (verify !== base.verify) patch.verify = verify

  // 日志同理按键合并 —— 只发改了的那几个开关
  const log = diffPatch(
    {
      enable: draft.value.logEnable,
      level: draft.value.logLevel,
      prompts: draft.value.logPrompts,
      outputs: draft.value.logOutputs,
      maxChars: numberOrKeep(draft.value.logMaxChars, base.log.maxChars),
      tokens: draft.value.logTokens
    },
    {
      enable: base.log.enable,
      level: base.log.level,
      prompts: base.log.prompts,
      outputs: base.log.outputs,
      maxChars: base.log.maxChars,
      tokens: base.log.tokens
    }
  )
  if (Object.keys(log).length) patch.log = log

  const skills = linesToList(draft.value.skills)
  if (skills.join("\n") !== base.skills.join("\n")) patch.skills = skills
  const plugins = linesToList(draft.value.plugins)
  if (plugins.join("\n") !== base.plugins.join("\n")) patch.plugins = plugins

  if (Object.keys(patch).length === 0) return

  const result = await configApi.update(patch)
  emit("saved", result.config)
}, { errorMessage: "保存失败" })
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- ── 连接的两条路由轴 ─────────────────────────────────────────────── -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">连接怎么分配</CardTitle>
        <CardDescription>
          <code class="font-mono">connection_id</code>
          一个字段同时背着「这一步要什么」（换端点不变）与「谁提供它」（换端点全变）。
          按类绑之后前者留在引擎里，后者就收在下面这几行上 —— 换 provider 时改的就是它们。
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-3">
        <div class="space-y-2">
          <Label for="general-default">缺省连接</Label>
          <Select id="general-default" v-model="draft.defaultConnect">
            <SelectTrigger><SelectValue placeholder="未配" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="c in config.connections" :key="c.id" :value="c.id">
                {{ c.id }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">上面两层都没写时用它</p>
        </div>

        <div v-for="kind in AGENT_KINDS" :key="kind" class="space-y-2">
          <Label :for="`general-bind-${kind}`">{{ AGENT_KIND_LABELS[kind] }}</Label>
          <Select :id="`general-bind-${kind}`" v-model="draft.bindings[kind]">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="UNSET">未配，走缺省连接</SelectItem>
              <SelectItem v-for="c in config.connections" :key="c.id" :value="c.id">
                {{ c.id }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ AGENT_KIND_HINTS[kind] }}</p>
        </div>
      </CardContent>
    </Card>

    <!-- ── 核验 ────────────────────────────────────────────────────────── -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">输出核验</CardTitle>
        <CardDescription>
          产出之后由 critic 判定有没有违反机制约束，不符就带反馈重生一次。
          它<strong>每一次判定都要多花一次调用</strong>，故缺省跟着故事走。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="space-y-2">
          <Label for="general-verify">总开关</Label>
          <Select id="general-verify" v-model="draft.verify">
            <SelectTrigger class="w-full sm:w-80"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="opt in VERIFY" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>

    <!-- ── 日志 ────────────────────────────────────────────────────────── -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">运行日志</CardTitle>
        <CardDescription>
          命令行与 HTTP 共用这一份配置，故这里改了 <code class="font-mono">gal-story play</code>
          那边也跟着变。
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="log-enable">落日志文件</Label>
              <p class="text-xs text-muted-foreground">关了就只剩终端上的简洁输出</p>
            </div>
            <Switch id="log-enable" v-model="draft.logEnable" />
          </div>

          <div class="space-y-2">
            <Label for="log-level">级别</Label>
            <Select id="log-level" v-model="draft.logLevel">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="level in LEVELS" :key="level" :value="level">
                  {{ level }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="log-prompts">完整提示词</Label>
              <p class="text-xs text-muted-foreground">排查「模型为什么这么答」时要它</p>
            </div>
            <Switch id="log-prompts" v-model="draft.logPrompts" />
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="log-outputs">输出原文</Label>
              <p class="text-xs text-muted-foreground">各 agent 交回来的那一段</p>
            </div>
            <Switch id="log-outputs" v-model="draft.logOutputs" />
          </div>

          <div class="space-y-2">
            <Label for="log-max-chars">截断上限</Label>
            <Input id="log-max-chars" v-model="draft.logMaxChars" type="number" step="1000" />
            <p class="text-xs text-muted-foreground">上面两类大块内容共用；0 = 不截断</p>
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div class="min-w-0 pr-3">
              <Label for="log-tokens">token 计量</Label>
              <p class="text-xs text-muted-foreground">终端上那一行，不是日志文件</p>
            </div>
            <Switch id="log-tokens" v-model="draft.logTokens" />
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- ── skill / 插件增量 ─────────────────────────────────────────────── -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">skill 与插件</CardTitle>
        <CardDescription>
          一行一条，写 <code class="font-mono">+名字</code> 启用、
          <code class="font-mono">-名字</code> 停用。这是**全局那一层**的增量，
          故事那一侧还能再叠一层 —— 「装了」与「这局要用」是两件事。
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label for="general-skills">skills</Label>
          <Textarea id="general-skills" v-model="draft.skills" rows="4" class="font-mono text-xs" />
        </div>
        <div class="space-y-2">
          <Label for="general-plugins">plugins</Label>
          <Textarea
            id="general-plugins"
            v-model="draft.plugins"
            rows="4"
            class="font-mono text-xs"
          />
        </div>
      </CardContent>
    </Card>

    <div class="flex items-center justify-end gap-3">
      <span v-if="dirty" class="text-xs text-muted-foreground">有未保存的改动</span>
      <Button :loading="pending" :disabled="!dirty" @click="submit()">保存</Button>
    </div>
  </div>
</template>
