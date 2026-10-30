<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"

import { PromptInput, createEditor } from "@/components/prompt-input"

import { useNodePart } from "@/components/flow/node-kit/context"

import { EDIT_PROMPT_MODE } from "./prompt"

/**
 * 底部输入框的外壳 —— 在节点的某个 `data` 字段上就地写一段提示词，回车提交。
 *
 * 各类型的输入框部件（`composer-part.ts` 的 `definePromptComposerPart` 包出来的）用它，传进来写哪个字段、占位文案；
 * 框旁边要不要再放别的（视频的时长、比例）由那个部件自己加。
 *
 * - **草稿**走 `ctx.node.draft("data", field)`：打字期间只改草稿，结束时写一次文档、前后夹 `separateUndo`；
 * - **回车**：写回文档并发 `composer:submit`（谁接、接了做什么这里不知道）；**Shift+回车**换行；
 *   **Esc** 丢掉草稿；**失焦**只写回、不提交；
 * - **编辑模式**：开始写字就进 `edit-prompt` —— 整张画布同时只有一个节点可编辑，别的节点正在改名会先提交；
 *   被顶掉（选中了别的节点、改起了名字）时草稿按失焦的规矩写回。
 */
const props = defineProps<{
  /** 写到 `data` 的哪个键 */
  field: string
  placeholder?: string
}>()

const ctx = useNodePart()

const { editor } = createEditor()
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

/**
 * 回车提交。**输入法组字时的回车不算**：中文输入里按回车是「把拼音上屏」，不是「发出去」——
 * 不判 `isComposing` 的话，打一个英文单词就会被当成提交。
 */
function onEnter(event: KeyboardEvent) {
  // Safari 上 isComposing 不可靠，keyCode 229 兜底
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  const submitted = text.value
  finish("commit")
  ctx.emit("composer:submit", { text: submitted })
  blurInput()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    onEnter(event)
  } else if (event.key === "Escape") {
    event.preventDefault()
    cancel()
  }
}

function cancel() {
  finish("cancel")
  blurInput()
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
})
</script>

<template>
  <!-- nodrag / nopan / nowheel：在框里拖选文字、滚动不该变成拖节点、拖画布、缩放 -->
  <div class="nodrag nopan nowheel w-80" data-testid="prompt-composer">
    <!--
      defer-focus-on-click：浮层挂载时不能抢画布的焦点（否则 Delete / Ctrl+Z 全落进输入框），点它才聚焦。
      PromptInput 本身没有边框，这里嵌在节点浮层里也不加、不留内边距让文字占满；wrapper-class 只调成两行起步、几行后滚动。
    -->
    <PromptInput
      ref="inputRef"
      v-model="text"
      :editor="editor"
      :defer-focus-on-click="true"
      :placeholder="placeholder"
      wrapper-class="[&_[data-slate-editor]]:min-h-14 [&_[data-slate-editor]]:max-h-32 [&_[data-slate-editor]]:overflow-y-auto [&_[data-slate-editor]]:p-0 [&_[data-slate-editor]]:leading-6 [&_[data-slate-editor]]:before:left-0 [&_[data-slate-editor]]:before:top-0 [&_[data-slate-editor]]:before:leading-6"
      @focus="begin()"
      @blur="finish('commit')"
      @keydown="onKeydown"
    />
  </div>
</template>
