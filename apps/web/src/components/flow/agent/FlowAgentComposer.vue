<script setup lang="ts">
import { computed, ref } from "vue"
import { AtSign, SendHorizontal, Square } from "@lucide/vue"
import { parseNodeMentions } from "@shadecn/shared/agent"
import { Button } from "@/components/ui/button"
import { PromptInput, createEditor, type CustomInline } from "@/components/prompt-input"
import { flowNodeTypeOf } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { cn } from "@/lib/utils"
import FlowAgentMention from "./FlowAgentMention.vue"
import { NODE_MENTION, appendMentions, nodeMentionIdOf, useNodeMentionMenu } from "./nodeMention"

/**
 * 对话面板底部的输入区：PromptInput + 「提及节点」插件 + 发送 / 停止。
 *
 * - **Enter 发送、Shift+Enter 换行**。提及列表开着时 Enter / Tab 是「选中这一项」，
 *   由插件的 `onKeyDown` 先拦掉，不会走到这里的发送。
 * - `defer-focus-on-click`：面板收起时这个输入框也一直挂着（草稿不丢），
 *   挂载时要是自己抢了焦点，画布上的 Delete / Ctrl+Z 就全落进输入框里了。
 *   只有用户点它、或者打开面板时才聚焦。
 */
const props = defineProps<{
  /** 当前会话正在跑：不能再发，按钮换成「停止」（别的会话在跑不挡这里，docs/20 §3.10.3） */
  running: boolean
  aborting: boolean
  /** 不给就是画布对话框的那句 */
  placeholder?: string
  /** 不显示「引用选中的节点」（导演台的对话面板里画布被盖住了）。布尔 prop 缺省就是 false，所以写成反的 */
  hideQuote?: boolean
}>()

const draft = defineModel<string>({ required: true })

const emit = defineEmits<{
  (e: "send"): void
  (e: "stop"): void
}>()

const { store, canvas } = useFlowEditor()

const menu = useNodeMentionMenu(() => store.nodes)
const { editor } = createEditor({ plugins: [menu.plugin] })

const input = ref<InstanceType<typeof PromptInput> | null>(null)

/** 画布上选中了、但输入框里还没提及的节点 —— 快捷按钮只管这些 */
const unmentionedSelection = computed(() => {
  const mentioned = new Set(parseNodeMentions(draft.value))
  return canvas.selectedNodeIds.value.filter((id) => !mentioned.has(id))
})

function quoteSelection() {
  draft.value = appendMentions(draft.value, unmentionedSelection.value)
  input.value?.focus()
}

const canSend = computed(() => !props.running && draft.value.trim().length > 0)

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey) return
  // 输入法组合中的 Enter 是「上屏」（Safari 上 isComposing 不可靠，keyCode 229 兜底）
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (canSend.value) emit("send")
}

function iconOf(nodeId: string) {
  const node = store.nodes.find((item) => item.id === nodeId)
  return node ? flowNodeTypeOf(node.type ?? "").icon : null
}

defineExpose({
  focus: () => input.value?.focus()
})
</script>

<template>
  <div class="space-y-2">
    <!--
      「引用选中的节点」：画布上选中了还没提及的节点时才出现。新会话的空输入框会自动带上选中节点的提及
      （快捷会话打开时、点「新会话」时，docs/20 §3.10.9）；这个按钮管剩下的情况 —— 续聊、已有草稿、
      面板开着时又换了选中。
    -->
    <Button
      v-if="!props.hideQuote && unmentionedSelection.length > 0"
      variant="outline"
      size="xs"
      class="max-w-full"
      data-testid="agent-quote-selection"
      @click="quoteSelection()"
    >
      <AtSign />
      引用选中的 {{ unmentionedSelection.length }} 个节点
    </Button>

    <!-- 画布里的输入区不带边框也不留内边距，文字占满：外面的弹层 / 面板已经框住了它 -->
    <div>
      <PromptInput
        ref="input"
        v-model="draft"
        :editor="editor"
        :defer-focus-on-click="true"
        :placeholder="props.placeholder ?? '让 agent 改画布… 输入 @ 提及节点'"
        wrapper-class="[&_[data-slate-editor]]:min-h-16 [&_[data-slate-editor]]:max-h-40 [&_[data-slate-editor]]:overflow-y-auto [&_[data-slate-editor]]:p-0 [&_[data-slate-editor]]:leading-6 [&_[data-slate-editor]]:before:left-0 [&_[data-slate-editor]]:before:top-0 [&_[data-slate-editor]]:before:leading-6"
        @keydown="onKeydown"
        @trigger-open="menu.onOpen"
        @trigger-search="menu.onSearch"
        @trigger-close="menu.onClose"
      >
        <template #[`element:${NODE_MENTION}`]="{ element, attributes }">
          <span v-bind="attributes" contenteditable="false" class="mx-0.5 inline-block">
            <FlowAgentMention :node-id="nodeMentionIdOf((element as CustomInline).data) ?? ''" />
          </span>
        </template>

        <!--
          提及列表。PromptInput 把它 teleport 到 body、放在光标**下方**；输入框贴着屏幕底边，
          往下展开会出屏，所以整块往上翻到光标上方（32px ≈ 一行 + 间距）。
        -->
        <template #[`portal:${NODE_MENTION}`]="{ commit }">
          <template v-if="(menu.bindCommit(commit), true)" />
          <div
            class="w-72 -translate-y-[calc(100%+32px)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            data-testid="agent-mention-menu"
          >
            <div v-if="menu.candidates.value.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
              没有匹配的节点
            </div>
            <button
              v-for="(item, index) in menu.candidates.value"
              :key="item.id"
              type="button"
              :class="
                cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  index === menu.active.value ? 'bg-accent text-accent-foreground' : ''
                )
              "
              :data-mention-option="item.id"
              @mouseenter="menu.active.value = index"
              @click="menu.pick(item)"
            >
              <component :is="iconOf(item.id)" v-if="iconOf(item.id)" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <span class="block truncate">{{ item.label || "未命名节点" }}</span>
                <span v-if="item.excerpt" class="block truncate text-xs text-muted-foreground">
                  {{ item.excerpt }}
                </span>
              </span>
            </button>
          </div>
        </template>
      </PromptInput>

      <div class="flex items-center justify-between gap-2 pt-2">
        <span class="text-[11px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
        <Button
          v-if="props.running"
          variant="outline"
          size="sm"
          :loading="props.aborting"
          data-testid="agent-stop"
          @click="emit('stop')"
        >
          <Square class="size-3 fill-current" />
          停止
        </Button>
        <Button
          v-else
          size="sm"
          :disabled="!canSend"
          data-testid="agent-send"
          @click="emit('send')"
        >
          <SendHorizontal />
          发送
        </Button>
      </div>
    </div>
  </div>
</template>
