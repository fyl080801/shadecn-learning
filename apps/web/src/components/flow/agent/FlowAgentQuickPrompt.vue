<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { Sparkles } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useFlowAgentPanel } from "@/composables/flow/agent-panel"
import { useAssetUploadList } from "@/composables/useAssetUpload"
import { AGENT_ATTACHMENT_LIMIT, attachmentsOf } from "./attachments"
import FlowAgentComposer from "./FlowAgentComposer.vue"
import { syncSelectionMentions } from "./nodeMention"

/**
 * 底部工具栏右侧的 agent 快捷入口（独立深色圆钮，不在胶囊里）：点开弹出一个输入框，发出去就**开一个新会话**执行，
 * 右上角的对话框随之展开、显示这一轮。
 *
 * 不在这里续聊 —— 续聊、看历史、停止都在对话框里；这里只负责「起一个头」。
 * 别的任务在跑（别人的、我别的会话里的）不挡它：并发单位是会话，新会话总能发起（docs/20 §3.10.3）。
 * 输入框和对话框底部是同一个 `FlowAgentComposer`（含 @ 提及节点、跟画布选区同步提及）。
 * 导演台底部工具栏也挂它，读到的是导演台那一份（新会话的入口记成那个节点）。
 *
 * **打开时输入框为空，就在开头放上选中节点的提及**（docs/20 §3.10.9；画布选区按选中的先后，导演台里是这个导演台）：
 * 和手动 @ 出来的一样，可以删。只在打开的那一下放、已有草稿不动；之后再选中 / 取消选中，开着时由输入区、收起时由这里同步增删提及。
 *
 * **附件**（docs/20 §3.10.12）同对话框：输入区上方的附件列表，发出去就摘走；这一轮没开始（被拒）就和文字一起还回来，
 * 弹层收起也留着（和草稿一样），换画布时清空。
 */
const { flowId, canvas } = useFlowEditor()
const { agent, copy, startConversation, selectionMentions } = useFlowAgentPanel()

const open = ref(false)
const draft = ref("")
const attachments = useAssetUploadList(flowId, { max: AGENT_ATTACHMENT_LIMIT })
const composer = ref<InstanceType<typeof FlowAgentComposer> | null>(null)

const enabled = computed(() => agent.session.value?.enabled === true)

const title = computed(() => {
  if (agent.session.value && !enabled.value) return `${copy.name}（服务端未配置模型）`
  return copy.quickTitle
})

watch(open, (value) => {
  if (!value) return
  if (draft.value === "") draft.value = selectionMentions()
  void nextTick(() => composer.value?.focus())
})

/**
 * 收起时输入区跟着弹层卸载了，选区的变化由这里接着同步进草稿 —— 点画布空白处 / 另一个节点本身就会把弹层收起，
 * 不接的话再打开时还是上一次选中的提及（草稿非空，打开时也不会重放）。开着时由输入区同步；同一拍两边都跑也不会重复。
 */
watch(
  () => [...canvas.selectedNodeIds.value],
  (next, previous) => {
    if (open.value || copy.ignoreSelection) return
    draft.value = syncSelectionMentions(draft.value, next, previous)
  }
)

// 换画布：收起、草稿清空 —— 草稿里的提及指向的是上一张画布的节点
watch(flowId, () => {
  open.value = false
  draft.value = ""
})

async function send() {
  if (attachments.uploading || attachments.failed) return
  const text = draft.value
  if (!text.trim() && attachments.ready.length === 0) return
  draft.value = ""
  const items = attachments.detach()
  open.value = false
  const accepted = await startConversation(text, attachmentsOf(items))
  if (accepted) {
    attachments.release(items)
    return
  }
  // 根本没开始：把字和附件还回去（字只在用户没又打新的时还）
  if (draft.value === "") draft.value = text
  attachments.restore(items)
}

/**
 * 提及列表被 PromptInput teleport 到 body，在弹层**外面** —— 点里面的选项
 * 不能当成「点了外面」把弹层关掉。
 */
function onInteractOutside(event: Event) {
  const target = event.target as Element | null
  if (target?.closest('[data-testid="agent-mention-menu"]')) event.preventDefault()
}

/** 弹层里的按键不往外冒（画布快捷键挂在 window 上）；Esc 留给弹层自己关 */
function isolateKeys(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation()
}
</script>

<template>
  <!--
    Tooltip 在最外层，Popover 整个放进它触发器的 span 里：reka-ui 的触发器就近找外层浮层登记锚点，
    Popover 套在 Tooltip 外面的话，PopoverTrigger 会登记到 Tooltip 上，弹层没锚点、被定位到屏幕外。
    提示挂在 span 上还有一个好处：按钮禁用（没配模型）时收不到鼠标事件，提示照样能解释「为什么用不了」。
  -->
  <Tooltip>
    <TooltipTrigger as-child>
      <!--
        外圈流光：一层转动的锥形渐变（400 色阶，比纯色柔、比浅色显眼），模糊后垫在按钮下面，带一点朦胧感。
        范围和工具栏胶囊同高 —— 胶囊 46px、按钮 32px，四周外扩 7px；模糊会再往外晕开一点，
        所以实体只扩 6px，晕开后大致落在 46px 上。
        不可用（没配模型）时不发光；系统开了「减少动态效果」就停转。
      -->
      <span class="relative inline-flex">
        <span
          v-if="enabled"
          aria-hidden="true"
          class="pointer-events-none absolute -inset-[6px] overflow-hidden rounded-full opacity-90 blur-[4px]"
        >
          <span
            class="absolute inset-[-50%] animate-[spin_3s_linear_infinite] bg-[conic-gradient(from_0deg,#c084fc,#60a5fa,#22d3ee,#f472b6,#c084fc)] motion-reduce:animate-none"
          />
        </span>
        <Popover v-model:open="open">
          <PopoverTrigger as-child>
            <!--
              和胶囊里的按钮同尺寸（32px）。阴影加深到 black/30：默认的 black/10 压在深色按钮底下
              和按钮同色，看不出投影；胶囊靠的是白底 + 边框才显得出来。
            -->
            <Button
              size="icon"
              class="relative size-8 rounded-full shadow-lg shadow-black/30"
              :aria-label="title"
              :disabled="!enabled"
              data-testid="agent-quick-toggle"
            >
              <Sparkles />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            :side-offset="12"
            class="nowheel w-[420px] max-w-[calc(100vw-2rem)] p-3"
            data-testid="agent-quick-prompt"
            @interact-outside="onInteractOutside"
            @keydown="isolateKeys"
          >
            <!-- 停止在对话框里，这里不放 -->
            <FlowAgentComposer
              ref="composer"
              v-model="draft"
              :running="false"
              :aborting="false"
              :placeholder="copy.placeholder"
              :ignore-selection="copy.ignoreSelection"
              :attachments="attachments"
              @send="send()"
            />
          </PopoverContent>
        </Popover>
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ title }}</TooltipContent>
  </Tooltip>
</template>
