<script lang="ts">
/** 改名模式的 id。写在这里而不是 `rename.ts`：那边要 import 这个组件，反过来引会成环 */
export const RENAME_MODE = "rename"
</script>

<script setup lang="ts">
import { ref, watch } from "vue"

import { useNodePart } from "../context"

/**
 * 框外左上角的节点名，双击就地改名（能力 `rename`，挂在 `label` 区）。
 *
 * 草稿走 `ctx.node.draft("metadata", "label")`（`useDraftField` 那一套：草稿接管画面、只在结束时写一次文档、
 * 前后夹 `separateUndo`），写走 store 的按组写，所以进撤销栈、同步给别人、被服务端落库。
 * 草稿从**显示的名字**起步（没起名的节点从兜底名起步，改一个字就行）；
 * `normalize` 返回 null = 这次不提交：名字被清空不是一次改名，是一次误操作。
 *
 * 改名是一个**编辑模式**：整张画布同时只有一个节点可编辑。别处顶掉这个模式（选中了别的节点、
 * 同一节点进了别的模式）时，草稿按 blur 的规矩提交。
 */
const ctx = useNodePart()

const inputRef = ref<HTMLInputElement | null>(null)

const title = ctx.node.draft<string>("metadata", "label", {
  read: () => ctx.label.value,
  fallback: "",
  label: "修改节点标题",
  normalize: (raw) => raw.trim() || null,
  focus: () => {
    inputRef.value?.focus()
    inputRef.value?.select()
  }
})

/**
 * 双击标题就地改名。
 *
 * 先把选中态切到它身上：名字这一行是 teleport 出节点 DOM 的（NodeToolbar），
 * 点它不会冒泡成 `node-click`，所以得自己切；切了才会上报到 awareness，
 * 别人也就看得到「有人在动这个节点」。
 */
function startEdit() {
  ctx.editor.canvas.selectOnly(ctx.id)
  if (ctx.mode.enter(RENAME_MODE)) void title.start()
}

function commit() {
  title.commit()
  if (ctx.mode.current.value === RENAME_MODE) ctx.mode.exit("commit")
}

function cancel() {
  title.cancel()
  if (ctx.mode.current.value === RENAME_MODE) ctx.mode.exit("cancel")
}

// 模式被别处顶掉了，输入框还开着 —— 按 blur 的规矩提交
watch(ctx.mode.current, (mode) => {
  if (mode !== RENAME_MODE && title.editing.value) title.commit()
})
</script>

<template>
  <!-- nodrag / nopan：在输入框里拖选文字不该变成拖节点或拖画布 -->
  <input
    v-if="title.editing.value"
    ref="inputRef"
    v-model="title.draft.value"
    class="nodrag nopan h-5 w-32 rounded border border-primary bg-card px-1 text-xs outline-none"
    @blur="commit()"
    @keydown.enter.prevent="commit()"
    @keydown.esc.prevent="cancel()"
    @dblclick.stop
  />
  <span
    v-else
    class="cursor-text text-xs font-medium text-muted-foreground hover:text-foreground"
    title="双击改名"
    @dblclick.stop="startEdit"
  >
    {{ ctx.label.value }}
  </span>
</template>
