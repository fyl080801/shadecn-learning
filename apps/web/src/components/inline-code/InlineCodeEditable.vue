<script setup lang="ts">
/**
 * 行内代码块的可编辑子区。
 *
 * 关键点：DOM 文本由本组件**手动管理**，模板里不写 `{{ }}` 插值——
 * 否则每次外层 `editor.apply()` → revision++ → 重渲染都会把 textContent
 * 拉回到模板字符串，导致 caret 跳到开头。
 *
 * 同步策略：
 *   - mount 时把 prop `text` 写入 textContent。
 *   - watch `text`：仅当与当前 DOM 不同（说明是外部 v-model 改写）时才同步。
 *   - 用户输入时通过 `update` 事件抛出新文本；父组件回写 model.data.text。
 *     由于回写后值与 DOM 已经一致，watcher 不会触发覆写，caret 自然保留。
 */
import { onMounted, ref, watch } from "vue"

const props = defineProps<{ text: string }>()
const emit = defineEmits<{ (e: "update", text: string): void }>()

const spanRef = ref<HTMLElement | null>(null)

const writeDom = (val: string): void => {
  const el = spanRef.value
  if (!el) return
  if ((el.textContent ?? "") !== val) {
    el.textContent = val
  }
}

onMounted(() => writeDom(props.text))

watch(
  () => props.text,
  (val) => writeDom(val)
)

const onInput = (ev: Event): void => {
  const el = ev.target as HTMLElement
  emit("update", el.textContent ?? "")
}

const onKeydown = (ev: KeyboardEvent): void => {
  if (ev.key === "Enter") ev.preventDefault()
}

const onPaste = (ev: ClipboardEvent): void => {
  const txt = ev.clipboardData?.getData("text/plain") ?? ""
  if (txt.includes("\n")) {
    ev.preventDefault()
    const oneLine = txt.replace(/\r?\n.*$/s, "")
    document.execCommand("insertText", false, oneLine)
  }
}
</script>

<template>
  <span
    ref="spanRef"
    data-inline-editable="inline-code"
    contenteditable="true"
    spellcheck="false"
    :style="{
      outline: 'none',
      minWidth: '4px',
      display: 'inline-block',
      whiteSpace: 'pre'
    }"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
  />
</template>