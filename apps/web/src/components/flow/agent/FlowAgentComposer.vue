<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { ArrowUp, Paperclip, Square } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { PromptInput, createEditor, type CustomInline } from "@/components/prompt-input"
import AssetUploadList from "@/components/flow/asset-upload/AssetUploadList.vue"
import { flowNodeTypeOf } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow/editor-context"
import type { AssetUploadList as AssetUploadListState } from "@/composables/useAssetUpload"
import { cn } from "@/lib/utils"
import FlowAgentMention from "./FlowAgentMention.vue"
import { NODE_MENTION, nodeMentionIdOf, syncSelectionMentions, useNodeMentionMenu } from "./nodeMention"

/**
 * 对话面板底部的输入区：附件 + PromptInput + 「提及节点」插件 + 发送 / 停止。
 *
 * 外围按 shadcn ai-elements 的 Prompt Input 排：左下一个圆形的「添加附件」，右下一个圆形的发送（↑）/ 停止（■）图标按钮。
 * 输入框本身仍是自己的 `PromptInput`（富文本 + `@` 提及节点）—— ai-elements 的 `InputGroupTextarea` 是纯文本，没有提及。
 *
 * - **附件**（docs/20 §3.10.12）：发送按钮同一行最左边一个回形针图标按钮选文件；传着的、传完的附件以缩略图排在输入框上方
 *   （`AssetUploadList`，不画它自己的加号方框），没有附件时这一排不占位。附件列表的状态由父组件建（`useAssetUploadList`）传进来：发送时摘走、没发出去还回来是父组件的事。
 *   有附件在传或传失败了不能发；只有附件、没写字也能发。不给 `attachments` 就没有这一排。
 * - **Enter 发送、Shift+Enter 换行**。提及列表开着时 Enter / Tab 是「选中这一项」，
 *   由插件的 `onKeyDown` 先拦掉，不会走到这里的发送。
 * - `defer-focus-on-click`：面板收起时这个输入框也一直挂着（草稿不丢），
 *   挂载时要是自己抢了焦点，画布上的 Delete / Ctrl+Z 就全落进输入框里了。
 *   只有用户点它、或者打开面板时才聚焦。
 * - **画布选区跟着输入框走**（docs/20 §3.10.9）：新选中的节点在输入框末尾加一枚提及，取消选中就把它的提及去掉。
 *   只看选区的**变化**：挂载时已有的选区由父组件按「新会话」规则放（`selectionMentions`）；删掉某个选中节点的提及后，
 *   它保持选中不会再被加回来。已经提及过的节点再选中不重复加。
 */
const props = defineProps<{
  /** 当前会话正在跑：不能再发，按钮换成「停止」（别的会话在跑不挡这里，docs/20 §3.10.3） */
  running: boolean
  aborting: boolean
  /** 不给就是画布对话框的那句 */
  placeholder?: string
  /** 不跟画布选区同步提及（导演台的对话面板里画布被盖住了）。布尔 prop 缺省就是 false，所以写成反的 */
  ignoreSelection?: boolean
  /** 这条消息的附件（父组件的 `useAssetUploadList`）；不给就不显示附件区 */
  attachments?: AssetUploadListState
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
const fileInput = ref<HTMLInputElement | null>(null)

function onFilesPicked(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files ? [...target.files] : []
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  if (files.length > 0) props.attachments?.add(files)
}

// 拷一份再比：选区数组要是原地改的，新旧会是同一个对象
watch(
  () => [...canvas.selectedNodeIds.value],
  (next, previous) => {
    if (props.ignoreSelection) return
    draft.value = syncSelectionMentions(draft.value, next, previous)
  }
)

/** 附件在传 / 传失败了：先等它传完、或者重试 / 删掉，再发（不然就是悄悄少发了一个） */
const attachmentsBlocking = computed(() => Boolean(props.attachments?.uploading || props.attachments?.failed))

const canSend = computed(
  () =>
    !props.running &&
    !attachmentsBlocking.value &&
    (draft.value.trim().length > 0 || (props.attachments?.ready.length ?? 0) > 0)
)

const hint = computed(() => {
  if (props.attachments?.uploading) return "附件上传中…"
  if (props.attachments?.failed) return "有附件没传上去：重试或移除后再发送"
  return "Enter 发送 · Shift+Enter 换行"
})

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
      附件排自带 pt-2 / pr-2（给压在边框外的删除角标留位置，横向滚动会裁掉溢出），
      这里用负边距把它推回外层 p-3 里，附件卡片本身离上边 / 右边仍是 12px，角标落在外层的内边距里
    -->
    <AssetUploadList
      v-if="props.attachments && props.attachments.items.length > 0"
      class="-mt-2 -mr-2"
      :list="props.attachments"
      :addable="false"
    />

    <!--
      画布里的输入区不带边框也不留内边距，文字占满：外面的弹层 / 面板已经框住了它（统一 p-3，同 shadcn InputGroup 的 px-3 / py-3）。
      行高 24px（提及 chip 22px 高，行高再小带 chip 的行会高低不齐）比 14px 字多出约 5px 半行距，
      首行看上去离上边比文字离左边远；-mt-1 把它抵掉，四边视觉上都是 12px 左右。
    -->
    <div>
      <PromptInput
        ref="input"
        v-model="draft"
        :editor="editor"
        :defer-focus-on-click="true"
        :placeholder="props.placeholder ?? '让 agent 改画布… 输入 @ 提及节点'"
        wrapper-class="-mt-1 [&_[data-slate-editor]]:min-h-16 [&_[data-slate-editor]]:max-h-40 [&_[data-slate-editor]]:overflow-y-auto [&_[data-slate-editor]]:p-0 [&_[data-slate-editor]]:leading-6 [&_[data-slate-editor]]:before:left-0 [&_[data-slate-editor]]:before:top-0 [&_[data-slate-editor]]:before:leading-6"
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
        <div class="flex min-w-0 items-center gap-1.5">
          <template v-if="props.attachments">
            <!-- 满了（一条消息最多 AGENT_ATTACHMENT_MAX_COUNT 个）就点不了 -->
            <Button
              variant="outline"
              size="icon-sm"
              class="rounded-full text-muted-foreground"
              aria-label="添加附件"
              :title="props.attachments.remaining > 0 ? '添加附件' : '附件已满'"
              :disabled="props.attachments.remaining === 0"
              data-testid="asset-upload-add"
              @click="fileInput?.click()"
            >
              <Paperclip class="size-4" />
            </Button>
            <input
              ref="fileInput"
              type="file"
              multiple
              accept="image/*,video/*"
              class="hidden"
              data-testid="asset-upload-input"
              @change="onFilesPicked"
            />
          </template>
          <span class="truncate text-[11px] text-muted-foreground" data-testid="agent-composer-hint">{{ hint }}</span>
        </div>
        <Button
          v-if="props.running"
          size="icon-sm"
          class="shrink-0 rounded-full"
          :loading="props.aborting"
          aria-label="停止"
          title="停止"
          data-testid="agent-stop"
          @click="emit('stop')"
        >
          <!-- 停着的时候按钮自己转圈（loading），不再叠一个方块 -->
          <Square v-if="!props.aborting" class="size-3 fill-current" />
        </Button>
        <Button
          v-else
          size="icon-sm"
          class="shrink-0 rounded-full"
          :disabled="!canSend"
          aria-label="发送"
          title="发送"
          data-testid="agent-send"
          @click="emit('send')"
        >
          <ArrowUp class="size-4" />
        </Button>
      </div>
    </div>
  </div>
</template>
