<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { Handle, Position, type NodeProps } from "@vue-flow/core"

import FlowNodeChrome from "@/components/flow/FlowNodeChrome.vue"
import { useFlowEditor } from "@/composables/flow"

/**
 * 文本节点 —— 一块可以就地写字的卡片，工具栏那枚加号建出来的就是它。
 *
 * 正文存在 `data.text`（平铺，自己一个 key）：Y.Map 的合并粒度是 key，
 * 所以一个人改标题、另一个人改正文不会互相盖掉。
 *
 * 编辑用的是「双击进入 textarea、失焦或 Esc 退出」，**不是**随时可编辑的 contenteditable：
 * 节点首先要能被拖、被框选，一直可编辑的话在上面按下鼠标就成了放光标而不是拖节点。
 */
const props = defineProps<NodeProps<Record<string, unknown>>>()

const { canvas, store } = useFlowEditor()

const text = computed(() => (typeof props.data.text === "string" ? props.data.text : ""))

const label = computed(() => (typeof props.data.label === "string" ? props.data.label : "文本"))

const editing = ref(false)
const draft = ref("")
const inputRef = ref<HTMLTextAreaElement | null>(null)

async function startEdit() {
  // 双击是在节点内部发生的，选中态本来就会切过来；但从 NodeToolbar 之类
  // teleport 出去的入口点进来时不会，所以这里显式切一次（和改名同理）
  canvas.selectOnly(props.id)
  draft.value = text.value
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  // 光标落到末尾，接着往下写；全选会让「双击补一句」变成「双击清空重写」
  const end = inputRef.value?.value.length ?? 0
  inputRef.value?.setSelectionRange(end, end)
}

function commitEdit() {
  if (!editing.value) return
  editing.value = false

  const next = draft.value
  if (next === text.value) return

  // 一次编辑 = 一条撤销，别和刚才的拖动之类并进同一条
  store.separateUndo()
  store.updateNodeData(props.id, { text: next }, "修改文本")
  store.separateUndo()
}

function cancelEdit() {
  editing.value = false
}
</script>

<template>
  <div
    class="relative flex min-h-[120px] w-[320px] flex-col rounded-md border bg-card px-3 py-2 text-sm text-card-foreground shadow-sm transition-shadow"
    :class="selected ? 'border-primary shadow-md ring-2 ring-primary/40' : ''"
    @dblclick.stop="startEdit"
  >
    <FlowNodeChrome :node-id="props.id" :label="label" />

    <!--
      nodrag / nopan：在文本框里拖选文字不该变成拖节点或拖画布。
      Esc 退出、失焦提交；回车留给换行 —— 这是一块多行文本，不是一行标题。
    -->
    <textarea
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      class="nodrag nopan nowheel min-h-[104px] w-full flex-1 resize-none rounded-sm border border-primary bg-background p-1 text-sm outline-none"
      @blur="commitEdit"
      @keydown.esc.prevent="cancelEdit"
      @dblclick.stop
    />
    <p
      v-else
      class="min-h-[104px] whitespace-pre-wrap break-words p-1"
      :class="text ? '' : 'text-muted-foreground'"
      title="双击编辑文本"
    >
      {{ text || "双击输入文本" }}
    </p>

    <Handle
      type="target"
      :position="Position.Left"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />

    <Handle
      type="source"
      :position="Position.Right"
      class="!size-2.5 !border-2 !border-background !bg-primary"
    />
  </div>
</template>
