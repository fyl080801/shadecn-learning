<script setup lang="ts">
import { computed, ref, watch } from "vue"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clapperboard,
  Compass,
  Layers,
  Loader2,
  NotebookPen,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench
} from "@lucide/vue"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle
} from "@/components/ui/stepper"

import { agentLabel, groupTitle, roleLabel } from "@/lib/galstory-agents"
import { agentLanes, type AgentLane, type PipelineStep } from "@/composables/useGalStoryRun"

/**
 * agent 循环的**纵向流水线**，恒三层：
 *
 * ```
 * 初始化            ← ① 这一段在干什么（阶段，引擎给的 `phase`）
 *   世界            ← ② 谁在干（agent —— 全局就导演/演员/世界/玩家四位）
 *     建档归一化    ← ③ 他做的每一件事（含取料与核验）
 *     公开人物志
 * ```
 *
 * ⚠️ **②那一层从不折叠，哪怕只有一位**。曾经为了少一层空转折过一次（只有一位时抹掉它、
 * 直接列③），换来的是「谁在做」没有固定位置 —— 有时在第二层、有时在第一层；更糟的是
 * 「认知检索」「知识写回」这种**不是 agent 的东西**会顶到 agent 的位置上，而那个问题本来
 * 就是要它回答的。
 *
 * ⚠️ **一个组件实例只渲染①的一段**（上游 `timeline` 已经分好，判据在 `belongsTogether`）。
 * 段与段之间隔着叙事 —— 「agent 行为与叙事交错」因此是**结构性**的，不靠这里摆。
 *
 * ## ③里没有「认知检索」这一位
 *
 * 取料与核验**不占②那一层**（引擎给它们 `attached: true`）：它们不是一位 agent，是某位
 * 正在做的一件事 —— 取料跑在生成之前、核验跑在之后，折进它服务的那一位才答得出
 * 「这个演员刚才干了什么」。折叠归 `agentLanes`（纯函数、可测），这里只渲染。
 *
 * 还在跑的那一位末尾带一个**变化的标签**（检索认知 / 核验产出 / …）——**跑完就不显示了**：
 * 那是「此刻在做什么」，不是一条要留下来的记录。
 *
 * ## 「谁」是角色卡上的真名
 *
 * ⚠️ 这**不是**玩家在正文里读到的那个词（`for_player`），是**刻意**的：这个面板答的是
 * 「刚才那次调用是替谁跑的」，受众是开着这一局的人。判据在引擎侧 `agui._progress` 一处，
 * 这里**不许再加工**。正文一个字不受它影响。
 *
 * ## 为什么是 Stepper 而不是自己画
 *
 * `reka-ui` 的 Stepper 原语把「第几步、走到哪了、走完没有」做成了**状态**（`state` 是
 * `active`/`completed`/`inactive`，落在 `data-state` 上），指示点、标题、连接线各自按它取样式。
 * 自己拿 div 拼的话，这套状态就散在一堆三元表达式里 —— 而它正是这个面板要表达的全部东西。
 * ⚠️ 纵向要三处配合：根上 `orientation="vertical"` + `flex-col`、item 改成上下排、
 * 连接线从默认的横条改成 `w-px flex-1`（组件库给的基线是横向的）。
 *
 * **重发要看得见**：同一件事连着出现好几条不是重复，是它重试过（`attempt`）。
 */

const props = defineProps<{
  /** ①的**一段**（上游已分好，见 `useGalStoryRun.belongsTogether`） */
  steps: PipelineStep[]
  running: boolean
  /** 右侧详情面板正看着哪一条（高亮它） */
  selectedId?: number | null
}>()

/** 点某一条 = 想看它的详情。**这里不自己开面板**：由页面决定详情摆在哪 */
const emit = defineEmits<{ select: [step: PipelineStep] }>()

const PHASE_ICONS: Record<string, unknown> = {
  bootstrap: Sparkles,
  plan: Compass,
  perform: Clapperboard,
  integrate: Layers,
  player: Wrench,
  options: Wrench,
  writeback: NotebookPen,
  retrieve: Search,
  verify: ShieldCheck,
  other: Wrench
}

const head = computed(() => props.steps[0] ?? null)
const lanes = computed<AgentLane[]>(() => agentLanes(props.steps))

/**
 * ②那一行的抬头：`演员 · 林越` / `导演` / `世界` / `玩家`。
 *
 * ⚠️ **只有演员与玩家带名字**（判据在 `agentLanes.laneWho`）：导演与世界各只有一位。
 * 连这一位都还说不出时（只有取料到了）退回那次调用自己的名字。
 */
function laneTitle(lane: AgentLane): string {
  const name = lane.role ? roleLabel(lane.role) : agentLabel(lane.main.step)
  return lane.who ? `${name} · ${lane.who}` : name
}

/**
 * ①的抬头 = **这一段在干什么**。分段是引擎给的（`phase`），这里只管怎么称呼它。
 *
 * ⚠️ **拿第一条不是附着型的那步定阶段**：取料跑在生成**之前**，一段的头几条常常是它 ——
 * 而取料自己没有阶段上的归属（它属于接下来那一位）。拿它定的话，正主还没到的那半秒里
 * 抬头会是「取料」，正主一到又跳成「规划剧本」，读起来像闪了一下。
 *
 * 正主真的还没到时退回**那一位自己**（`导演` / `演员 · 某某`）—— 那句话此刻是对的。
 */
/**
 * 这一段的**正主**：第一条不是附着型的调用。
 *
 * ⚠️ 一段的头几条常常是取料（它跑在生成之前，还会被下一段**领回来**，见
 * `stealTrailingAttached`），而取料自己没有阶段上的归属 —— 抬头与图标都得看正主，
 * 否则「剧本演绎」会顶着一个放大镜、写着「取料」。
 */
const real = computed(() => props.steps.find((s) => !s.attached) ?? head.value)

const label = computed(() => {
  const r = real.value
  if (!r) return ""
  const first = lanes.value[0]
  return groupTitle(r.phase) || (first ? laneTitle(first) : "")
})

const icon = computed(() => PHASE_ICONS[real.value?.phase ?? "other"] ?? Wrench)
const elapsed = computed(() => props.steps.reduce((sum, s) => sum + s.elapsed, 0))
const failed = computed(() => props.steps.some((s) => s.error))

/** 这一段还在跑（它是最后一段且整轮在跑） */
const active = computed(() => props.running)

/**
 * **此刻在做什么** —— 只给还在跑的那一行，且只给最后一行（前面的都跑完了）。
 * ⚠️ 跑完就返回空：那是个状态，不是一条记录。
 */
function activityOf(lane: AgentLane, index: number): string {
  if (!active.value || index !== lanes.value.length - 1) return ""
  // 与行名一样就不重复说（正主还没跑完时，这一行的名字**就是**那次取料）
  return lane.activity === laneTitle(lane) ? "" : lane.activity
}

// ── 开合 ────────────────────────────────────────────────────────────────────
//
// 两层各自受控：①整段、②每一位。**人手点过之后就不再替他自动开合**（`touched`）——
// 否则下一条进度一到，他刚折起来的那一段又自己弹开了。

const open = ref(false)
const opened = ref<Set<string>>(new Set())
const touched = ref(false)

watch(active, (value) => {
  if (value && !touched.value) open.value = true
}, { immediate: true })

// 正在跑的那一段里，每一位默认都摊开 —— 那时你要看的正是「谁在做什么」
watch([active, lanes] as const, ([running, list]) => {
  if (!running || touched.value) return
  opened.value = new Set(list.map((l) => l.key))
}, { immediate: true })

function setOpen(value: boolean) {
  touched.value = true
  open.value = value
}

/**
 * ⚠️ **照 `Collapsible` 给的那个值设，不要在这里 toggle**：它是受控组件，`update:open` 带的
 * 就是**它想要的新状态**。自己翻一下的话，「已经开着又收到一次 open」会把它关掉 —— 而那正是
 * 正在跑的那一段（watcher 已经替它开好了）第一次被点到时的情形。
 */
function setLaneOpen(key: string, value: boolean) {
  touched.value = true
  const next = new Set(opened.value)
  if (value) next.add(key)
  else next.delete(key)
  opened.value = next
}

function fmt(seconds: number) {
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`
}
</script>

<template>
  <Stepper
    v-if="head"
    orientation="vertical"
    :model-value="active ? 1 : 2"
    class="flex w-full flex-col gap-0"
  >
    <StepperItem :step="1" :completed="!active" class="flex w-full items-stretch gap-3">
      <!--
        指示点 + **它下面那根连线**。连线用组件库自己的 `StepperSeparator`（底下就是 reka 的
        `Separator`）—— 它跟着根上的 `orientation` 走，还带着本 item 的 `data-state`，故
        「走完了变色」是组件库给的，不是这里拿三元表达式拼的。

        ⚠️ **一个 `Stepper` 只有一个 item**（段与段之间还插着叙事，见组件头），故这根线不是
        「item 之间那条」而是**本段自己的一条**：从指示点下缘一路撑到本段底部
        （`self-stretch` + `flex-1`）。几段挨着摆下来自然连成一条，中间插进一段叙事时它断开
        —— 那正是「这几步之后才有这段话」的读法。
      -->
      <div class="flex shrink-0 flex-col items-center self-stretch">
        <StepperIndicator class="size-7 shrink-0">
          <AlertTriangle v-if="failed" class="size-3.5 text-destructive" />
          <Loader2 v-else-if="active" class="size-3.5 animate-spin" />
          <component :is="icon" v-else class="size-3.5" />
        </StepperIndicator>
        <StepperSeparator class="mt-1 w-px flex-1 rounded-full" />
      </div>

      <!-- ① 这一段在干什么 -->
      <Collapsible :open="open" class="min-w-0 flex-1" @update:open="setOpen">
        <CollapsibleTrigger
          class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted"
        >
          <ChevronRight
            class="size-3.5 shrink-0 text-muted-foreground transition-transform"
            :class="open ? 'rotate-90' : ''"
          />
          <StepperTitle class="truncate text-xs font-medium">{{ label }}</StepperTitle>
          <Badge v-if="lanes.length > 1" variant="outline" class="h-4 shrink-0 px-1 text-[10px]">
            {{ lanes.length }}
          </Badge>
          <Check v-if="!active && !failed" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {{ fmt(elapsed) }}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <!-- ② 谁在干 —— **这一层从不折叠掉**，哪怕只有一位 -->
          <ul class="flex flex-col gap-0.5 pl-6 pr-1 pt-1">
            <li v-for="(lane, i) in lanes" :key="lane.key">
              <Collapsible
                :open="opened.has(lane.key)"
                @update:open="(value: boolean) => setLaneOpen(lane.key, value)"
              >
                <CollapsibleTrigger
                  class="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] hover:bg-muted"
                >
                  <ChevronRight
                    class="size-3 shrink-0 text-muted-foreground transition-transform"
                    :class="opened.has(lane.key) ? 'rotate-90' : ''"
                  />
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    :class="lane.steps.some((s) => s.error)
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/50'"
                  />
                  <span class="truncate font-medium">{{ laneTitle(lane) }}</span>
                  <!-- 此刻在做什么：跑完就没有了 -->
                  <span
                    v-if="activityOf(lane, i)"
                    class="shrink-0 truncate text-[10px] text-muted-foreground"
                  >
                    {{ activityOf(lane, i) }}…
                  </span>
                  <span class="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {{ fmt(lane.elapsed) }}
                  </span>
                </CollapsibleTrigger>

                <!-- ③ 他做的每一件事 -->
                <CollapsibleContent>
                  <ul class="flex flex-col gap-0.5 py-0.5 pl-[1.375rem]">
                    <li v-for="call in lane.steps" :key="call.id">
                      <button
                        type="button"
                        class="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted"
                        :class="selectedId === call.id ? 'bg-muted ring-1 ring-border' : ''"
                        @click="emit('select', call)"
                      >
                        <span class="truncate">{{ agentLabel(call.step) }}</span>
                        <span v-if="call.attempt > 1" class="shrink-0">
                          （第 {{ call.attempt }} 次尝试）
                        </span>
                        <span v-if="call.error" class="truncate text-destructive">
                          {{ call.error }}
                        </span>
                        <span class="ml-auto shrink-0 tabular-nums">{{ fmt(call.elapsed) }}</span>
                      </button>
                    </li>
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </StepperItem>
  </Stepper>
</template>
