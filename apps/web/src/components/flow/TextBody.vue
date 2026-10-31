<script setup lang="ts">
import { computed, ref, watch } from "vue"

import { useNodePart } from "@/components/flow/node-kit/context"
import { EDIT_BODY_MODE } from "@/components/flow/node-kit/features/edit-body"

/**
 * 文本节点的 body —— 一块可以就地写字的卡片，工具栏那枚加号建出来的就是它。
 *
 * 正文存在 `data.text`（业务字段，自己一个 key）；名字在 `metadata.label`。
 * Y.Map 的合并粒度是 key，所以一个人改标题、另一个人改正文不会互相盖掉。
 *
 * 外观是一个输入框（占满节点、无边框的正文区，空着显示占位文字）；编辑用的是「双击进入 textarea、失焦或 Esc 退出」，
 * **不是**随时可编辑的 contenteditable：节点首先要能被拖、被框选，一直可编辑的话在上面按下鼠标就成了放光标而不是拖节点。
 *
 * 「双击 → 进入编辑」是能力 `edit-body` 的事（它接 `node:dblclick`、进 `edit-body` 模式）；
 * 这里只看模式：进了就开草稿，被顶掉（选中了别的节点、改起了名字）就按 blur 的规矩提交。
 */
const ctx = useNodePart()

const text = computed(() => (typeof ctx.node.data.value.text === "string" ? ctx.node.data.value.text : ""))

const inputRef = ref<HTMLTextAreaElement | null>(null)

/**
 * 正文的草稿态 —— `useFlowNode().draft` 在 `data.text` 上开的草稿
 * （草稿接管画面、只在结束时写一次文档、前后夹 `separateUndo`）。
 *
 * 正文不 trim、允许清空 —— 把一段文字删光是一次正当的编辑，
 * 和标题被清空（那是误操作）不一样，所以这里没有 `normalize`。
 */
const body = ctx.node.draft<string>("data", "text", {
  read: (raw) => (typeof raw === "string" ? raw : ""),
  fallback: "",
  label: "修改文本",
  focus: () => {
    inputRef.value?.focus()
    // 光标落到末尾，接着往下写；全选会让「双击补一句」变成「双击清空重写」
    const end = inputRef.value?.value.length ?? 0
    inputRef.value?.setSelectionRange(end, end)
  }
})

watch(ctx.mode.current, (mode) => {
  if (mode === EDIT_BODY_MODE) void body.start()
  else if (body.editing.value) body.commit()
})

function commit() {
  body.commit()
  if (ctx.mode.current.value === EDIT_BODY_MODE) ctx.mode.exit("commit")
}

function cancel() {
  body.cancel()
  if (ctx.mode.current.value === EDIT_BODY_MODE) ctx.mode.exit("cancel")
}
</script>

<template>
  <!--
    看起来就是一个输入框：平时是一块占满节点、无边框的正文区（空着时显示占位文字），双击变成真的 textarea。
    不做成随时可编辑：节点首先要能被拖、被框选，一直可编辑的话按下鼠标就成了放光标而不是拖节点。

    nodrag / nopan：在文本框里拖选文字不该变成拖节点或拖画布。
    Esc 退出、失焦提交；回车留给换行 —— 这是一块多行文本，不是一行标题。

    高度：节点根元素保证至少 120、拉伸过就是拉成的高度，这里 flex-1 填满、min-h-0 允许比内容矮 ——
    拉矮了正文裁掉（展示态），编辑时 textarea 自己滚动。
  -->
  <textarea
    v-if="body.editing.value"
    ref="inputRef"
    v-model="body.draft.value"
    class="nodrag nopan nowheel min-h-0 w-full flex-1 resize-none rounded-[inherit] border-0 bg-background px-3 py-2 text-sm outline-none ring-0"
    data-testid="text-body-input"
    @blur="commit()"
    @keydown.esc.prevent="cancel()"
    @dblclick.stop
  />
  <div
    v-else
    class="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words rounded-[inherit] bg-background px-3 py-2 text-sm"
    :class="text ? '' : 'text-muted-foreground'"
    title="双击编辑文本"
    data-testid="text-body"
  >
    {{ text || "双击输入文本" }}
  </div>
</template>
