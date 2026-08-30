<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

import { EditorView, basicSetup } from "codemirror"
import { Compartment, EditorState } from "@codemirror/state"
import { yaml as yamlLang } from "@codemirror/lang-yaml"

/**
 * 一个 yaml 编辑器。**故事目录整个是 yaml**，故这里不做语言切换。
 *
 * ⚠️ **不做「边打字边校验」**：这个故事对不对是**跨文件**的判断（`present` 里的 cid 有没有
 * 对应角色卡、`flow.yaml` 的边指不指得到场景 id），只有把整个目录装载一遍才答得出 ——
 * 而那是引擎那一侧保存时做的事。在这里塞一个本地 yaml 语法检查，等于让界面有第二套判据：
 * 它只看得见语法，于是「本地绿灯、保存红灯」会成为常态，而人会去信那个绿灯。
 *
 * 编辑器只管**文本**：语法高亮 + 缩进 + 撤销。对不对由保存那一刻说了算。
 */

const props = defineProps<{
  modelValue: string
  /** 只读（看公共故事时）。⚠️ 它只是别让人白打字，**不是权限判据**——那在引擎那一侧 */
  readonly?: boolean
}>()

const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

/**
 * ⚠️ **不引主题切换**：这个应用今天没有明暗主题（`src/style.css` 里一处 `dark` 都没有），
 * 编辑器单独挂一个 `oneDark` 就成了整页唯一的深色块 —— 那不是「支持深色」，是不一致。
 * 哪天应用真有了主题，再在这里挂一个 `Compartment` 切它。
 */
const editable = new Compartment()

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  "&.cm-focused": { outline: "none" }
})

function extensions() {
  return [
    basicSetup,
    yamlLang(),
    baseTheme,
    editable.of(EditorView.editable.of(!props.readonly)),
    EditorView.updateListener.of((update) => {
      // ⚠️ 只在**文档真的变了**时上抛：`docChanged` 之外的更新（选区、焦点）每秒好几次，
      // 无条件 emit 会让父组件的「有没有未保存改动」恒为真。
      if (update.docChanged) emit("update:modelValue", update.state.doc.toString())
    })
  ]
}

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
    parent: host.value
  })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// 父组件换了文件 / 从服务端刷新了内容 → 整份换掉。
// ⚠️ **要先比一遍**：不比的话自己 emit 出去的那次改动会绕回来重置光标，打一个字跳一次。
watch(
  () => props.modelValue,
  (next) => {
    if (!view || next === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
  }
)

watch(
  () => props.readonly,
  (ro) => view?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!ro)) })
)

defineExpose({ focus: () => view?.focus() })
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden rounded-md border" />
</template>
