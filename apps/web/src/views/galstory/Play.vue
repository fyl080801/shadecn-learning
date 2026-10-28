<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { ArrowLeft, Loader2, Send, Sparkles } from "@lucide/vue"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"

import BackendNotice from "@/components/galstory/BackendNotice.vue"
import PipelineTree from "@/components/galstory/PipelineTree.vue"
import StepDetail from "@/components/galstory/StepDetail.vue"

import { phaseLook } from "@/lib/galstory-agents"
import { useAsyncAction } from "@/composables/useAsyncAction"
import { useGalStoryRun } from "@/composables/useGalStoryRun"
import type { PipelineStep } from "@/composables/useGalStoryRun"
import { usePageTitle } from "@/composables/usePageTitle"

/**
 * 对局界面。
 *
 * ## 一轮的形状
 *
 * `POST .../turns` 立刻回 202 → 跟 `GET .../events`（SSE）。**发起与跟随是两条口**，
 * 因为「刷新页面」的自然动作是 GET，而那条口在语义上不可能演一轮 —— 只有一条 POST 口的话，
 * 重连与再演一轮在客户端长得一模一样，刷一次就把同一个意图演两遍。
 *
 * ## 执行过程与产出穿成一条瀑布流
 *
 * agent 干的活儿**是这段对话的一部分**，不是旁边一个恒亮的仪表盘，也不是攒成一大块摆在末尾。
 * 顺序就是它真实发生的顺序：建档 → 开场白 → 排这一轮 → 逐步演出 → 汇总的那段叙事 →
 * 收束与写回。排序只认到达时刻（`timeline`），故「谁在谁前面」是记录下来的事实、不是猜的。
 *
 * 点某一次调用才在右侧开详情面板；不点就不占地方（窄屏上本来也没有那块地方）。
 *
 * ## 右边那块详情是什么
 *
 * 一轮含 8~10 次串行模型调用、动辄几十秒，不给进度就是几十秒的假死。它显示的是**环节**
 * （导演在排这一轮 / 角色演出中 / 汇总成叙事…），**不是角色** —— 引擎那一侧刻意只发环节名：
 * agent 标签冒号后那半截是角色真名，而一个 `knows=false` 的角色在正文里落的是公共指代，
 * 进度条却把真名喊出来，就把认知隔离从侧门绕开了。提示词与输出原文同理不在这条流上。
 *
 * ## 开场轮
 *
 * 由引擎驱动、**不消费玩家输入**（`awaitingOpening`）。故进来先自动演一轮空的，
 * 玩家不必先说点什么才能开始。
 */

const props = defineProps<{ saveId: string }>()

const router = useRouter()
const run = useGalStoryRun(props.saveId)
const {
  state, messages, options, pipeline, phase, running, finished, error, streaming, timeline
} = run

const draft = ref("")
const loading = ref(true)
/** 右侧详情正看着哪一次调用；null = 不开面板（缺省就是不开） */
const selected = ref<PipelineStep | null>(null)

/** 再点同一条就收起来 —— 那是这种面板最自然的开合方式 */
function select(step: PipelineStep) {
  selected.value = selected.value?.id === step.id ? null : step
}
const scroller = ref<HTMLElement | null>(null)

usePageTitle("对局", () => state.value?.title ?? null)

/** 新消息到了就滚到底。⚠️ 要等 DOM 更新完，否则量到的是上一帧的高度 */
watch(
  () => [timeline.value.length, streaming.value.length],
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

const sceneLabel = computed(() => {
  const s = state.value
  if (!s) return ""
  const parts = [s.stage.name, s.scene.name].filter(Boolean)
  return parts.length ? `${parts.join(" · ")} · 第 ${s.turn} 轮` : `第 ${s.turn} 轮`
})

/**
 * 此刻在干什么 —— **摆在对话流里**，不只在右边那条流水线上。
 *
 * ⚠️ 首次开局要先建档（几十次模型调用、几分钟），而侧栏在窄屏上根本不显示。此前那几分钟
 * 对话区**一个字都没有**，看着就是卡死 —— 「初始化」本来就是这一局的一部分，该说出来。
 */
const activity = computed(() => {
  if (!running.value) return ""
  const last = pipeline.value[pipeline.value.length - 1]
  const booting = phase.value === "opening_session"
  if (booting && !last) return "正在初始化这一局：装配中…"
  if (!last) return "正在准备这一轮…"
  const where = phaseLook(last.phase).label
  return booting ? `正在初始化这一局 · ${where}：${last.label}` : `${where} · ${last.label}`
})

/** 建档那几步单独标一下：它是一次性开销，不是每轮都有 */
const bootstrapping = computed(() => phase.value === "opening_session" && running.value)

async function boot() {
  loading.value = true
  try {
    // 只 GET 探一下：**装配（含建档）不在这里做**，见 `useGalStoryRun.probe` 的判据。
    const assembled = await run.probe()

    // 后台可能正演着（演一轮几十秒，这期间刷新或从列表点回来都会走到这里）。
    // **先附着**：那条口只看、不发起，附上去就能接着看流水线走完。
    loading.value = false
    if (await run.attach()) return

    // 没装配过（刚建的存档），或装配了但等着开场轮 —— 两种都由第一轮去演：
    // 那一轮的 worker 自己会装配，建档的每一次调用都从流水线上走出来。
    if (!assembled || (state.value?.awaitingOpening && !state.value.finished)) {
      await run.play("")
    }
  } catch {
    // 错误已经落在 run.error 上，这里只负责收掉 loading
  } finally {
    loading.value = false
  }
}

void boot()

onBeforeUnmount(() => run.dispose())

const { run: send, pending: sending } = useAsyncAction(async (text: string) => {
  const body = text.trim()
  if (!body || running.value) return
  const consumed = await run.play(body)
  // ⚠️ **只在引擎确认吃掉之后才清输入框**：`consumedInput` 为 false 说明这次是附着到
  // 已经在跑的那一轮上，那条消息**没有**被消费 —— 清掉的话玩家就得重打一遍。
  if (consumed) draft.value = ""
}, { errorMessage: "这一轮没演成" })

const { run: choose } = useAsyncAction(
  async (text: string) => {
    if (running.value) return
    await run.play(text)
  },
  { errorMessage: "这一轮没演成", key: (text: string) => text }
)
</script>

<template>
  <!-- SidebarLayout 的 main 是 `h-0 flex-1`，故这里 h-full 拿得到确定高度；
       每层中间容器都要 min-h-0，否则内层滚动条抢不过外层那个 -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- 抬头不画边框：与输入框那一侧同一条取向 —— 上下两端都由渐隐把内容淡出去，
         而不是拿硬边界切开（消息区顶部那道渐隐就贴在它下面） -->
    <header class="relative z-10 flex shrink-0 items-center gap-3 bg-background px-4 py-3">
      <Button variant="ghost" size="icon-sm" title="返回故事库" @click="router.push('/galstory/stories')">
        <ArrowLeft class="size-4" />
      </Button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold">{{ state?.title || "对局" }}</h1>
        <p class="truncate text-xs text-muted-foreground">{{ sceneLabel }}</p>
      </div>
      <Badge v-if="finished" variant="secondary">已完结</Badge>
      <Badge v-else-if="running" variant="outline" class="gap-1">
        <Loader2 class="size-3 animate-spin" />
        演出中
      </Badge>
    </header>

    <div v-if="loading" class="flex flex-1 flex-col gap-3 p-6">
      <Skeleton class="h-20 w-2/3" />
      <Skeleton class="h-20 w-full" />
    </div>

    <BackendNotice
      v-else-if="error && messages.length === 0"
      :error="error"
      class="m-6"
      @retry="boot()"
    />

    <!-- ⚠️ **输入框住在「对话」这一列里，不能是这一行的兄弟**：作为兄弟时它横跨整行，
         与滚动区不在同一条高度链上，就会「飘」在消息后面而不是钉在底部。
         （详情面板现在是浮层 `Sheet`，不再占位，故这一列恒是满宽。） -->
    <div v-else class="flex min-h-0 flex-1 overflow-hidden">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- 消息区。上下两道渐隐盖在滚动区上方（`pointer-events-none`，不挡点击） -->
        <div class="relative min-h-0 flex-1">
          <div ref="scroller" class="h-full overflow-y-auto px-4 pb-6 pt-6">
            <div class="mx-auto flex max-w-3xl flex-col gap-4">
              <template v-for="(part, i) in timeline" :key="part.kind + i + part.at">
                <div
                  v-if="part.kind === 'message'"
                  :class="[
                    'rounded-lg px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap',
                    part.message.role === 'player'
                      ? 'ml-auto max-w-[80%] bg-primary text-primary-foreground'
                      : 'bg-muted',
                    part.message.pending ? 'opacity-60' : ''
                  ]"
                >
                  {{ part.message.text }}
                </div>

                <!-- **一个 agent 一段**，与叙事在同一条流上交错往下走。
                     ⚠️ 刻意**不画成卡片**：一轮有七八个 agent，每个都套一个描边框会把对话
                     切成一堆盒子；它们是过程、不是内容，压成一行更贴近「流水」那个形态。 -->
                <section v-else class="px-1">
                  <PipelineTree
                    :steps="part.steps"
                    :running="running && i === timeline.length - 1"
                    :selected-id="selected?.id ?? null"
                    @select="select"
                  />
                </section>
              </template>

              <!-- 还没有任何步骤时也要有反馈：建档那几分钟里此前对话区一个字都没有 -->
              <div
                v-if="running && timeline.length === 0"
                class="flex items-center gap-2 self-start rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
              >
                <component
                  :is="bootstrapping ? Sparkles : Loader2"
                  class="size-3.5 shrink-0"
                  :class="bootstrapping ? '' : 'animate-spin'"
                />
                <span>{{ activity || "正在准备这一轮…" }}</span>
              </div>

              <!-- 汇总边生成边吐的那一段。⚠️ 它是**草稿**：未收宏、未按展示策略落词，
                   `CUSTOM:turn` 的终稿一到就整个换掉它（称呼只会比终稿窄，不会更宽） -->
              <div
                v-if="streaming"
                class="rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap opacity-70"
              >
                {{ streaming }}<span class="ml-0.5 animate-pulse">▌</span>
              </div>

              <!-- ⚠️ **选项摆在消息流里**（human-in-the-loop），不再钉在底部：它是这一轮
                   末尾抛给你的一次询问，属于对话的一部分 —— 钉在底部会让人以为它是常驻工具栏，
                   分不清「这是刚给的」还是「上一轮剩下的」。
                   跑起来之后整块消失（`play()` 里同步清空），点过的那一句随即变成你自己的气泡。 -->
              <div
                v-if="!running && !finished && options.length"
                class="flex flex-col gap-2 rounded-lg border border-dashed p-3"
              >
                <p class="px-1 text-xs text-muted-foreground">选一个，或者在下面直接写你要做什么</p>
                <div class="flex flex-col gap-1.5">
                  <button
                    v-for="option in options"
                    :key="option.id"
                    type="button"
                    class="rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                    @click="choose(option.text)"
                  >
                    {{ option.text }}
                  </button>
                </div>
              </div>

              <p v-if="finished" class="text-center text-sm text-muted-foreground">
                这一局已经完结，没有可继续的场景了。
              </p>

              <!-- 这一轮出错了但之前的叙事还在：就地提示，别把整页换成错误态 -->
              <p v-if="error && messages.length" class="text-sm text-destructive">
                {{ error instanceof Error ? error.message : "这一轮没演成" }}
              </p>
            </div>
          </div>

          <!-- 上下渐隐：内容从这两端淡出，而不是被一条硬边界切断 -->
          <div
            class="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background to-transparent"
          />
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          />
        </div>

        <!-- 输入框：**这一列的底部**，无上边框（渐隐已经把它和消息区分开了）。
             ⚠️ `relative z-10` 不能省：上面那两道渐隐是 `absolute` **定位**元素，会盖在后面
             这个非定位的兄弟之上 —— 而输入框的阴影正好往上溢出到渐隐那一块区域里，于是顶边
             那圈阴影被抹掉了（看着像输入框缺了一条边）。抬一层就压回去了；`pt-2` 是给阴影留地方。 -->
        <div v-if="!finished" class="relative z-10 shrink-0 bg-background px-4 pb-4 pt-2">
          <div class="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              v-model="draft"
              :disabled="running"
              rows="2"
              placeholder="写下你要做什么（回车发送）"
              class="min-h-0 resize-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap"
              @keydown.enter.exact.prevent="send(draft)"
            />
            <Button
              size="icon"
              :loading="sending || running"
              :disabled="!draft.trim() || running"
              title="发送"
              @click="send(draft)"
            >
              <!-- ⚠️ 转圈时**不要再画一个图标**：Button 的 loading 是在 slot **之外**加一个
                   Loader2，图标按钮上就会并排出现两个 -->
              <Send v-if="!sending && !running" class="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <!-- 详情：点了流水线上某一次调用才出现。**浮层**（`Sheet`）—— 顶到视口顶端，
           且不挤占对话的宽度 -->
      <StepDetail :step="selected" @close="selected = null" />
    </div>
  </div>
</template>
