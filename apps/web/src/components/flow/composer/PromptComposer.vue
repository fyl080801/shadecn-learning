<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { Maximize2, X } from "@lucide/vue"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import { declaresSide } from "@shadecn/shared/flow-node-types"
import { removeNodeMentions } from "@shadecn/shared/agent"

import { PromptInput, createEditor, type CustomInline } from "@/components/prompt-input"

import FlowAgentMention from "@/components/flow/agent/FlowAgentMention.vue"
import { NODE_MENTION, nodeMentionIdOf, useNodeMentionMenu } from "@/components/flow/agent/nodeMention"
import { useNodePart, useNodeTypeView } from "@/components/flow/node-kit/context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { suspendCanvasShortcuts } from "@/composables/flow/shortcut-layer"
import { cn } from "@/lib/utils"

import ComposerInputs from "./ComposerInputs.vue"
import { INPUT_ORDER_KEY, orderedUpstreams, readInputOrder } from "./composer-inputs"
import { EDIT_PROMPT_MODE } from "./prompt"
import SendButton from "./SendButton.vue"
import { SEND_KEY_HINT, isSendKey } from "./send-key"

/**
 * 底部输入框的外壳（docs/13 §3.7「底部输入框」）—— 一块 shadcn 带边框的面板，分上下两块：
 *
 * 1. **连入预览**（`ComposerInputs`）：连进这个节点的上游，可拖动排序、点角标断开，末尾一格加号选媒体建连入节点。
 *    只有声明了输入端口的类型才有这一块（文本是源头，没有）；
 * 2. **提示词**（`PromptInput`）+ 右下角的发送按钮（`SendButton`，和 agent 对话框同一枚）。
 *    `@` **只能提及连进来的节点**：候选就是上面那一排、同样的顺序。
 *
 * **放大编辑**：面板右上角一枚图标按钮，点了在带遮罩的弹窗里独立编辑；点遮罩 / 弹窗右上角的叉 / Esc 关掉，面板回到节点下方。
 * 弹窗里**不是第二份输入框**：同一块面板经 `Teleport` 整块搬进弹窗再搬回来 —— 组件实例不变，草稿、光标所在的编辑器、
 * 提及弹层的状态都还是那一份，不用在两处之间同步。所以面板的外观（边框、底色）在这里，不在宿主的 `composer` 区：
 * 搬走时节点下面不能剩一个空框。
 *
 * 写字的规矩没变：
 * - **草稿**走 `ctx.node.draft("data", field)`：打字期间只改草稿，结束时写一次文档、前后夹 `separateUndo`；
 * - **回车换行，Shift+回车 / 点发送**：写回文档并发 `composer:submit`（谁接、接了做什么这里不知道 —— 眼下只有导演台接）；
 *   键位规则和 agent 对话框共用一份（`send-key.ts`）；**Esc** 丢掉草稿；**失焦**只写回、不提交；
 * - **编辑模式**：开始写字就进 `edit-prompt` —— 整张画布同时只有一个节点可编辑，别的节点正在改名会先提交；
 *   被顶掉（选中了别的节点、改起了名字）时草稿按失焦的规矩写回。
 */
const props = defineProps<{
  /** 写到 `data` 的哪个键 */
  field: string
  placeholder?: string
}>()

const ctx = useNodePart()
const store = ctx.editor.store

// —— 连入的节点 ——

/** 有没有输入端口（文本没有）：没有就不画连入预览 */
const hasInputs = computed(() => declaresSide(ctx.type, "inputs"))

const upstreamIds = computed(() =>
  orderedUpstreams(ctx.node.inputs.value, readInputOrder(ctx.node.data.value[INPUT_ORDER_KEY]), (id) =>
    store.nodeById.has(id)
  )
)

const upstreamNodes = computed(() =>
  upstreamIds.value.flatMap((id) => {
    const node = store.nodeById.get(id)
    return node ? [node as FlowNode] : []
  })
)

/**
 * 点了某一格的移除角标：断开这个上游的所有线，同时去掉提示词里对它的提及、把它从 `inputOrder` 里拿掉 ——
 * 一个事务一条撤销（`store.disconnectUpstream`）。正在写的草稿先按失焦的规矩写回，再在文档里的文字上去提及，
 * 草稿不会把去掉的提及又写回来。
 */
function removeUpstream(nodeId: string) {
  if (prompt.editing.value) finish("commit")
  const set: Record<string, unknown> = {}
  const nextText = removeNodeMentions(current.value, [nodeId])
  if (nextText !== current.value) set[props.field] = nextText
  const order = readInputOrder(ctx.node.data.value[INPUT_ORDER_KEY])
  if (order.includes(nodeId)) set[INPUT_ORDER_KEY] = order.filter((id) => id !== nodeId)
  store.separateUndo()
  store.disconnectUpstream(ctx.id, nodeId, Object.keys(set).length > 0 ? { set } : undefined)
  store.separateUndo()
}

// —— 输入框 ——

/** `@` 弹层的候选只有连进来的节点（不列附件） */
const menu = useNodeMentionMenu(() => upstreamNodes.value)
const { editor } = createEditor({ plugins: [menu.plugin] })
const inputRef = ref<InstanceType<typeof PromptInput> | null>(null)

/** 让编辑区失焦（PromptInput 暴露的是 contenteditable 本体） */
function blurInput() {
  inputRef.value?.editableEl?.blur()
}

const current = computed(() => {
  const value = ctx.node.data.value[props.field]
  return typeof value === "string" ? value : ""
})

const prompt = ctx.node.draft<string>("data", props.field, {
  read: (raw) => (typeof raw === "string" ? raw : ""),
  fallback: "",
  label: "修改提示词"
})

/** 没在编辑时显示文档里的值（别人改了也跟着变）；一开始写就交给草稿 */
const text = computed({
  get: () => (prompt.editing.value ? prompt.draft.value : current.value),
  set: (value: string) => {
    begin()
    prompt.draft.value = value
  }
})

const canSend = computed(() => text.value.trim().length > 0)

function begin() {
  if (prompt.editing.value) return
  if (ctx.mode.current.value !== EDIT_PROMPT_MODE && !ctx.mode.enter(EDIT_PROMPT_MODE)) return
  void prompt.start()
}

function finish(reason: "commit" | "cancel") {
  if (reason === "commit") prompt.commit()
  else prompt.cancel()
  if (ctx.mode.current.value === EDIT_PROMPT_MODE) ctx.mode.exit(reason)
}

/** 发送键和发送按钮是同一件事：写回、发 `composer:submit`、收起光标。眼下没有真正的提交（没人消费这个事件，导演台除外） */
function submit() {
  const submitted = text.value
  finish("commit")
  ctx.emit("composer:submit", { text: submitted })
  blurInput()
}

/** 发送键（Shift / ⌘ + 回车，`isSendKey`）提交；单按回车不拦，编辑器自己换行 */
function onKeydown(event: KeyboardEvent) {
  if (isSendKey(event)) {
    event.preventDefault()
    submit()
  } else if (event.key === "Escape") {
    // 放大编辑时 Esc 是「关弹窗」（弹窗自己接），草稿按失焦写回，不丢
    if (expanded.value) return
    event.preventDefault()
    finish("cancel")
    blurInput()
  }
}

// —— 放大编辑 ——

/** 弹窗开着（遮罩和弹窗框都在） */
const dialogOpen = ref(false)
/** 面板此刻在弹窗里（Teleport 生效）。比 `dialogOpen` 晚开、早关：搬进去要等弹窗框挂上，搬回来要赶在弹窗卸掉之前 */
const expanded = ref(false)
/** 弹窗里接面板的那个空位 */
const dialogSlot = ref<HTMLElement | null>(null)

let releaseShortcuts: (() => void) | null = null

async function expand() {
  if (dialogOpen.value) return
  dialogOpen.value = true
  // 弹窗盖住画布，键盘归它：画布的 Delete / 撤销不能透过遮罩作用到画布上（焦点停在弹窗的按钮上时也一样）
  releaseShortcuts = suspendCanvasShortcuts()
  await nextTick()
  if (!dialogSlot.value) await new Promise((resolve) => requestAnimationFrame(resolve))
  if (!dialogOpen.value || !dialogSlot.value) return
  expanded.value = true
  // 搬动 DOM 会让输入框失焦（按失焦的规矩写回了草稿）；搬进去之后把光标放回去，接着写
  await nextTick()
  inputRef.value?.editableEl?.focus()
}

function collapse() {
  expanded.value = false
  dialogOpen.value = false
  releaseShortcuts?.()
  releaseShortcuts = null
}

function onDialogOpenChange(open: boolean) {
  if (!open) collapse()
}

/**
 * 提及弹层被 PromptInput teleport 到 body，在弹窗框外面：点它不能算「点了外面」把弹窗关掉。
 * （模态弹窗给 body 设了 `pointer-events: none`，弹层自己的根元素带 `pointer-events-auto` 才点得到。）
 */
function onInteractOutside(event: Event) {
  const target = event.target as Element | null
  if (target?.closest?.('[data-cy="prompt-portal"]')) event.preventDefault()
}

/** Esc 先给输入框里的提及弹层（它关掉弹层时 `preventDefault`），这一下不关弹窗 */
function onEscapeKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented) event.preventDefault()
}

// 模式被别处顶掉了，框里还有草稿 —— 按失焦的规矩写回
watch(ctx.mode.current, (mode) => {
  if (mode !== EDIT_PROMPT_MODE && prompt.editing.value) prompt.commit()
})

/**
 * 输入框所在的浮层收起时（选中换到了别的节点 —— 键盘、agent、代码里改的选中，不一定先有一次 blur），
 * 这个组件会在上面那个 watch 跑之前就被卸掉。卸载时还在编辑，就和失焦一样写回，草稿不能悄悄丢掉。
 */
onBeforeUnmount(() => {
  if (prompt.editing.value) finish("commit")
  releaseShortcuts?.()
})

/**
 * 输入区的高度：在节点下方 2 行起步、5 行后滚动（面板总高封顶）；放大后是**固定高度**（屏幕高的六成、至少 320px，
 * 空着也是这么高；编辑区在 PromptInput 里是 `flex-1`，`height` 不起作用，所以用 min / max 钉成同一个值）—— 放大就是为了写大段内容，编辑区一打开就该是一整块，而不是跟着字数慢慢长。
 * 写成整串字面量：Tailwind 扫源码认 class，拼出来的它认不到。
 */
const INPUT_CLASS =
  "[&_[data-slate-editor]]:min-h-12 [&_[data-slate-editor]]:max-h-30 [&_[data-slate-editor]]:overflow-y-auto [&_[data-slate-editor]]:p-0 [&_[data-slate-editor]]:text-sm [&_[data-slate-editor]]:leading-6 [&_[data-slate-editor]]:before:left-0 [&_[data-slate-editor]]:before:top-0 [&_[data-slate-editor]]:before:leading-6"
const EXPANDED_INPUT_CLASS =
  "[&_[data-slate-editor]]:min-h-[max(60vh,320px)] [&_[data-slate-editor]]:max-h-[max(60vh,320px)] [&_[data-slate-editor]]:overflow-y-auto [&_[data-slate-editor]]:p-0 [&_[data-slate-editor]]:text-sm [&_[data-slate-editor]]:leading-6 [&_[data-slate-editor]]:before:left-0 [&_[data-slate-editor]]:before:top-0 [&_[data-slate-editor]]:before:leading-6"

const viewOf = useNodeTypeView()

function iconOf(nodeId: string) {
  const node = store.nodeById.get(nodeId)
  return node ? (viewOf(node.type ?? "").icon ?? null) : null
}
</script>

<template>
  <!--
    nodrag / nopan / nowheel：在框里拖选文字、拖格子排序、滚动不该变成拖节点、拖画布、缩放。
    固定宽 440px（屏幕像素：宿主的 composer 区在 NodeToolbar 里，不随缩放变）：一排放得下六格预览 + 加号，
    再多就横向滚；输入框 2 行起步、最高 5 行后滚动 —— 面板总高封顶，不会把节点下面一大片盖住。
  -->
  <Teleport :to="dialogSlot" :disabled="!expanded">
  <div
    :class="
      cn(
        'nodrag nopan nowheel relative flex flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground shadow-lg',
        expanded ? 'w-full' : 'w-110'
      )
    "
    :data-expanded="expanded || undefined"
    data-testid="prompt-composer"
  >
    <!--
      右上角：放大 / 关闭，同一个位置。图标按钮（ghost + icon），不是圆形按钮。
      绝对定位压在面板右上角，下面第一块内容右边留出它的位置（pr-8）。
    -->
    <Button
      variant="ghost"
      size="icon-xs"
      class="absolute top-2 right-2 text-muted-foreground"
      :aria-label="expanded ? '收起' : '放大编辑'"
      :title="expanded ? '收起' : '放大编辑'"
      data-testid="prompt-composer-expand"
      @click="expanded ? collapse() : expand()"
    >
      <X v-if="expanded" />
      <Maximize2 v-else />
    </Button>

    <!--
      连入那一排自带 pt-1.5 / pr-1.5 给移除角标留位置（横向滚动会裁掉溢出）：这里用 -mt-1.5 抵掉，角标落进面板的 padding 里，
      格子的位置和没角标时一样；右边 mr-6.5 + 那 6px = 原来给放大按钮留的 32px。
    -->
    <ComposerInputs v-if="hasInputs" class="-mt-1.5 mr-6.5" :upstreams="upstreamIds" @remove="removeUpstream" />

    <!--
      defer-focus-on-click：浮层挂载时不能抢画布的焦点（否则 Delete / Ctrl+Z 全落进输入框），点它才聚焦。
      PromptInput 本身没有边框，外面的面板已经框住它，不再加；行高 24px 和提及 chip（22px）对齐。
    -->
    <PromptInput
      ref="inputRef"
      v-model="text"
      :editor="editor"
      :defer-focus-on-click="true"
      :placeholder="placeholder"
      :class="!hasInputs && 'pr-8'"
      :wrapper-class="expanded ? EXPANDED_INPUT_CLASS : INPUT_CLASS"
      @focus="begin()"
      @blur="finish('commit')"
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

      <!-- 提及列表：PromptInput 把它 teleport 到 body、放在光标下方 -->
      <template #[`portal:${NODE_MENTION}`]="{ commit }">
        <template v-if="(menu.bindCommit(commit), true)" />
        <div
          class="pointer-events-auto w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          data-testid="composer-mention-menu"
        >
          <div v-if="menu.options.value.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
            {{ upstreamNodes.length === 0 ? "还没有连入的节点" : "没有匹配的连入节点" }}
          </div>
          <template v-for="(option, index) in menu.options.value" :key="option.key">
            <button
              v-if="option.kind === 'node'"
              type="button"
              :class="
                cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  index === menu.active.value ? 'bg-accent text-accent-foreground' : ''
                )
              "
              :data-mention-option="option.item.id"
              @mouseenter="menu.active.value = index"
              @click="menu.pick(option)"
            >
              <component
                :is="iconOf(option.item.id)"
                v-if="iconOf(option.item.id)"
                class="size-3.5 shrink-0 text-muted-foreground"
              />
              <span class="min-w-0 flex-1 truncate">{{ option.item.label || "未命名节点" }}</span>
            </button>
          </template>
        </div>
      </template>
    </PromptInput>

    <div class="flex items-center justify-between gap-2">
      <span class="truncate text-[11px] text-muted-foreground">
        {{ hasInputs ? `@ 提及连入的节点 · ${SEND_KEY_HINT}` : SEND_KEY_HINT }}
      </span>
      <SendButton :disabled="!canSend" data-testid="prompt-composer-send" @click="submit()" />
    </div>
  </div>
  </Teleport>

  <!--
    放大编辑的弹窗：遮罩用 shadcn Dialog 自带的（点它关）；弹窗框本身透明无边距，只是给面板留的一个空位，
    面板自己的边框 / 底色就是弹窗的样子。自带的关闭叉不要 —— 面板右上角那枚已经变成了叉。
    打开 / 关闭时都不让 Dialog 挪焦点：打开后由 `expand()` 把光标放回输入框，关闭后不抢画布的焦点。
  -->
  <Dialog :open="dialogOpen" @update:open="onDialogOpenChange">
    <DialogContent
      :show-close-button="false"
      class="gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-3xl"
      @open-auto-focus.prevent
      @close-auto-focus.prevent
      @interact-outside="onInteractOutside"
      @escape-key-down="onEscapeKeyDown"
    >
      <DialogTitle class="sr-only">编辑提示词</DialogTitle>
      <DialogDescription class="sr-only">{{ ctx.label.value }}</DialogDescription>
      <div ref="dialogSlot" data-testid="prompt-composer-dialog" />
    </DialogContent>
  </Dialog>
</template>
