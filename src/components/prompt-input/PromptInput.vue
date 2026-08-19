<script setup lang="ts">
/**
 * PromptInput —— 通用的 Slate 风格 contenteditable 编辑器，带有面向
 * inline-void 元素和触发符弹出层的插件系统。
 *
 * 槽位概览（均为作用域插槽）：
 *   - `#element:<name>`     { element, attributes }      inline 节点渲染器
 *   - `#element`            { element, attributes }      兜底渲染器
 *   - `#portal:<name>`      { trigger, commit, close, editor }  弹出层内容
 *   - `#footer-action`                                  footer 操作区
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  useSlots,
  useAttrs,
  Comment
} from "vue"
import {
  Transforms,
  Editor,
  Range,
  initializeEditor,
  getText,
  pointsEqual
} from "./operations"
import { getTriggerPattern } from "./definePlugin"
import { readModelRange, applyDOMRange, toDOMRange } from "./selection"
import { modelToText, textToModel, serializeRange } from "./serialize"
import type {
  Editor as EditorT,
  Paragraph,
  CustomInline,
  PromptPlugin,
  Range as RangeType,
  TriggerContext,
  Descendant
} from "./types"

/**
 * Props（属性）
 *
 *   - `modelValue`：编辑器的值，为**字符串**。内联 token（如 `@[name](id)`、
 *     `{{Ref 3}}`）如何往返由插件驱动。使用 `v-model` 进行双向绑定。
 *   - `placeholder`：文档为空时显示的占位文本。
 *
 * 编辑器从不对外暴露内部的 `Descendant[]` 结构；使用方只与字符串打交道。
 */
defineOptions({ inheritAttrs: false })

const attrs = useAttrs()

const props = withDefaults(
  defineProps<{
    editor: EditorT
    modelValue?: string
    placeholder?: string
    /** 覆盖根容器的类名。省略时应用默认的浅色主题工具类。 */
    containerClass?: string
    /** 覆盖外层包裹容器的类名（边框、背景、圆角）。
     *  当 footer 需要位于可视容器内部时有用。 */
    wrapperClass?: string
    /** When true, the editor is read-only (contenteditable="false"). */
    disabled?: boolean
    /** 最大可见字符数（不计 \n 和零宽空格）。
     *  null / undefined = 不限制，且不渲染 footer。 */
    maxLength?: number | null
    /** Show character counter in footer. Requires maxLength to be set. */
    showCounter?: boolean
    /** Show clear button in footer. */
    showClear?: boolean
    /** 挂载时不自动聚焦 contenteditable，避免画布新建节点后焦点落入输入框导致 Delete 键失效。
     *  用户点击输入区时仍按原生行为一次聚焦。画布配置节点场景启用。 */
    deferFocusOnClick?: boolean
  }>(),
  {
    modelValue: "",
    placeholder: "输入触发字符（如 @）打开菜单…",
    containerClass: undefined,
    wrapperClass: undefined,
    disabled: false,
    maxLength: null,
    showCounter: false,
    showClear: false,
    deferFocusOnClick: false
  }
)

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
  (e: "change", value: string): void
  (e: "keydown", event: KeyboardEvent): void
  (e: "select", range: RangeType | null): void
  (e: "focus"): void
  (e: "blur"): void
  (e: "trigger-open", ctx: TriggerContext): void
  (e: "trigger-search", ctx: TriggerContext): void
  (e: "trigger-close"): void
  (e: "exceed-limit", currentCount: number, limit: number): void
}>()

const slots = useSlots()

const rootEl = ref<HTMLElement | null>(null)
const composing = ref(false)
const isUpdatingSelection = ref(false)
const isFocused = ref(false)
/**
 * 判断事件是否发生在某个"内联可编辑子区"中（标记 `data-inline-editable`）。
 * 此类子区由插件自行渲染并完全自治输入/键盘/合成事件，外层引擎应当跳过
 * 默认处理，避免重复 preventDefault 把插件的输入吞掉。
 */
const isInsideEditableInline = (event: Event): boolean => {
  const t = event.target as HTMLElement | null
  if (!t || typeof t.closest !== "function") return false
  return !!t.closest("[data-inline-editable]")
}

/**
 * 当焦点位于"内联可编辑子区"内时，外层 model 的 selection 应锁定到该
 * inline 节点的"前后某个文本叶"，以便外层光标定位、删除合并等操作
 * 把整个块当作一个原子。我们这里只用作判定，真实的 model selection
 * 由 PromptInput 通过 `selectionchange` 事件正常读取（DOM 选区在子区
 * 内时 `toModelPoint` 会向上找到 void-path 并解析到相邻文本叶）。
 */

// --- plugin helpers ----------------------------------------------------

const plugins = computed<PromptPlugin[]>(() => {
  const reg = props.editor.__plugins
  return reg ? Array.from(reg.values()) : []
})

const pluginByInlineType = (type: string | undefined): PromptPlugin | null => {
  if (!type) return null
  for (const p of plugins.value) {
    if ((p.inline?.type ?? p.name) === type) return p
  }
  return null
}

// --- character counting & maxLength enforcement ----------------------------

const ZERO_WIDTH_SPACE = "\u200B"
const ZERO_WIDTH_REGEX = new RegExp(ZERO_WIDTH_SPACE, "g")

const INPUT_LIMIT_TIP_TEXT = "输入内容超过最大限制，已被忽略"
const PASTE_TRUNCATE_TIP_TEXT = "粘贴内容超过最大限制，已被截断"
const LIMIT_TIP_DURATION = 3000

/** Count visible characters (strips \n and zero-width spaces). */
function getVisibleCharCount(text: string): number {
  return text.replace(/\n/g, "").replace(ZERO_WIDTH_REGEX, "").length
}

/** Cached serialized text from the revision watcher — avoids double traversal. */
const serializedText = ref("")

/** Current visible character count based on the editor model. */
const charCount = computed(() => getVisibleCharCount(serializedText.value))

/** Count visible characters in the current selection. */
function getSelectedVisibleCharCount(): number {
  const sel = props.editor.selection
  if (!sel || Range.isCollapsed(sel)) return 0
  const selectedText = serializeRange(props.editor.children, sel, plugins.value)
  return getVisibleCharCount(selectedText)
}

/**
 * 截断 `insertText`，使插入后可见字符数不超过 `limit`。会考虑被选中文本
 * 被替换掉的情况。
 */
function truncateToMaxLength(
  insertText: string,
  currentCount: number,
  selectedCount: number,
  limit: number
): { text: string; truncated: boolean } {
  const available = limit - currentCount + selectedCount
  if (available <= 0) return { text: "", truncated: insertText.length > 0 }
  let visibleCount = 0
  for (let i = 0; i < insertText.length; i += 1) {
    const ch = insertText[i]
    if (ch === "\n" || ch === ZERO_WIDTH_SPACE) continue
    visibleCount += 1
    if (visibleCount > available) {
      return { text: insertText.slice(0, i), truncated: true }
    }
  }
  return { text: insertText, truncated: false }
}

// --- limit tip state -------------------------------------------------------

const limitTipVisible = ref(false)
const limitTipText = ref("")
let limitTipTimer: ReturnType<typeof setTimeout> | null = null

function showLimitTip(message: string) {
  if (limitTipVisible.value && limitTipText.value === message) return
  limitTipText.value = message
  limitTipVisible.value = true
  if (limitTipTimer) {
    clearTimeout(limitTipTimer)
  }
  limitTipTimer = setTimeout(() => {
    limitTipVisible.value = false
    limitTipTimer = null
  }, LIMIT_TIP_DURATION)
}

// --- footer helpers --------------------------------------------------------

/**
 * 判断 footer-action 槽位是否实际渲染了内容。
 * 仅检查 `slots['footer-action']` 函数是否存在是不够的——父组件声明了
 * `<template #footer-action>` 但内部用 `v-if` 条件渲染时，槽位函数始终
 * 存在，只是返回 Comment 占位节点。这里调用槽位函数并过滤掉 Comment
 * 节点来判断是否有有效内容。
 */
const hasFooterActionContent = computed(() => {
  const fn = slots["footer-action"]
  if (!fn) return false
  const vnodes = fn()
  return vnodes.some((v) => v.type !== Comment)
})

const hasFooter = computed(
  () =>
    props.maxLength != null &&
    (props.showCounter || hasFooterActionContent.value || limitTipVisible.value)
)

function handleClear() {
  if (props.disabled) return
  initializeEditor(props.editor, textToModel("", plugins.value))
  lastEmittedText = ""
  serializedText.value = ""
  // 同步清空到父级 v-model：否则外部通过 modelValue/getValue 读到的仍是旧值，
  // 导致「使用提示词」等追加场景基于陈旧文本累积（清空后再次追加会重复）。
  emit("update:modelValue", "")
  emit("change", "")
  nextTick(() => rootEl.value?.focus())
}

// --- selection bridge --------------------------------------------------

/**
 * 滚动 rootEl 容器，使光标保持在可视区域内。
 * 模拟 <textarea> 在光标移出当前滚动视口时（例如按下 Enter 后）的
 * 自动滚动行为。
 */
const scrollCursorIntoView = (): void => {
  const root = rootEl.value
  if (!root) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.focusNode) return
  // 只量测选区 focus 端（光标活动端）的插入点矩形，而非整个 range 的
  // 包围盒：反向拖选超出可视区时，整段包围盒的 bottom 在容器下方，
  // 会把滚动条拉回选区尾部（anchor 端），偏离用户松开鼠标的位置。
  // 折叠光标下两者等价（打字/回车后的自动滚动行为不变）。
  const caret = document.createRange()
  try {
    caret.setStart(sel.focusNode, sel.focusOffset)
  } catch {
    return
  }
  caret.collapse(true)
  const rect = caret.getBoundingClientRect()
  if (!rect || rect.height === 0) return
  const containerRect = root.getBoundingClientRect()
  if (rect.bottom > containerRect.bottom) {
    root.scrollTop += rect.bottom - containerRect.bottom
  } else if (rect.top < containerRect.top) {
    root.scrollTop -= containerRect.top - rect.top
  }
}

/**
 * 鼠标拖选进行中标记。拖选期间任何对 DOM 选区的程序化写入
 * （removeAllRanges / setBaseAndExtent）都会重置浏览器内部的拖选锚点，
 * Firefox 下表现为：反向拖选或跨行/跨 inline-void 拖选时选区闪烁、
 * 最终选不中文本。拖选期间只读不写，mouseup 后再补一次归一。
 */
const isMouseSelecting = ref(false)

/**
 * 自愈 contenteditable 中被浏览器破坏的零宽占位结构（参照 slate.js）。
 *
 * 不变式（与模板渲染一致）：
 *   - `[data-slate-zero-width]` span 的第一个子节点必须是内容为
 *     的文本节点（光标停靠点；缺失时空行/行首无法放置光标，空行 div
 *     高度塌为 0，表现为"回车后光标消失"）；
 *   - "n" 型（空段落）span 在 FEFF 之后必须恰有一个 <br>（撑起行高，
 *     slate.js 同款）；"z" 型（inline 相邻的空叶）不允许 <br>；
 *   - 编辑器内其余位置不允许出现 <br>（Firefox 会在 Enter 的 beforeinput
 *     之前向 DOM 预注入 <br> 并吞掉 FEFF 文本节点，preventDefault 无法
 *     阻止这次预注入；而对应模型叶是未变化的空文本，Vue 的 vdom diff
 *     不会触碰该 span，破坏会永久残留——只能在此按不变式修复）。
 *
 * 插件自治区（[data-void-path] / [data-inline-editable]）内部结构不属于
 * 编辑器核心，跳过不动。IME 组合期间 DOM 处于浏览器接管状态，跳过。
 */
const repairLeafPlaceholders = (): void => {
  const root = rootEl.value
  if (!root || composing.value) return
  for (const span of Array.from(
    root.querySelectorAll<HTMLElement>("[data-slate-zero-width]")
  )) {
    const wantBr = span.getAttribute("data-slate-zero-width") === "n"
    let textNode = span.firstChild
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      textNode = document.createTextNode("\uFEFF")
      span.insertBefore(textNode, span.firstChild)
    } else if (textNode.textContent !== "\uFEFF") {
      textNode.textContent = "\uFEFF"
    }
    // FEFF 之后仅保留（"n" 型）一个 <br>，多余节点全部清除。
    let hasBr = false
    let cur = textNode.nextSibling
    while (cur) {
      const next = cur.nextSibling
      if (wantBr && !hasBr && cur.nodeName === "BR") {
        hasBr = true
      } else {
        span.removeChild(cur)
      }
      cur = next
    }
    if (wantBr && !hasBr) span.appendChild(document.createElement("br"))
  }
  // 清除零宽 span 之外的浏览器注入 <br>（块 div 直接子节点、文本叶内等）。
  for (const br of Array.from(root.querySelectorAll("br"))) {
    if (
      br.closest(
        "[data-slate-zero-width],[data-void-path],[data-inline-editable]"
      )
    ) {
      continue
    }
    br.remove()
  }
}

const applyModelSelectionToDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  // 未聚焦时不主动写 DOM 选区：避免浏览器在失焦的 contenteditable 上建立选区，
  // 可能引发 Chrome 内部 nextSibling 访问异常（已检测到 blur 后 nextTick 仍触发的竞态）。
  if (!isFocused.value) return
  // 拖选进行中不写 DOM 选区，避免与浏览器的拖选扩展互相打架。
  if (isMouseSelecting.value) return
  // 若当前焦点位于内联可编辑子区，外层不再覆盖 DOM 选区，避免抢走插件光标。
  const active = document.activeElement as HTMLElement | null
  if (active && active.closest && active.closest("[data-inline-editable]")) {
    return
  }
  isUpdatingSelection.value = true
  applyDOMRange(root, props.editor.selection)
  scrollCursorIntoView()
  setTimeout(() => {
    isUpdatingSelection.value = false
  }, 0)
}

const sameRange = (a: RangeType | null, b: RangeType | null): boolean => {
  if (!a || !b) return a === b
  return pointsEqual(a.anchor, b.anchor) && pointsEqual(a.focus, b.focus)
}

const flushSelectionFromDOM = (): void => {
  if (isUpdatingSelection.value || composing.value) return
  if (!isFocused.value) return
  const root = rootEl.value
  if (!root) return
  // 若 DOM 焦点位于内联可编辑子区，外层不再读取这一选区为 model selection。
  const active = document.activeElement as HTMLElement | null
  if (active && active.closest && active.closest("[data-inline-editable]")) {
    return
  }
  const range = readModelRange(root)
  if (!range) return
  const editor = props.editor
  if (!sameRange(editor.selection, range)) {
    editor.selection = range
    emit("select", range)
  }
  // 若 DOM 选区的任一端点落在 *游离* 节点上（不在任何 leaf/void 内），
  // 此时模型选区已正确，但 DOM 选区是畸形的，其光标渲染错误或不可见。
  // Firefox 在点击最后一行下方 padding 或空行时会产生此类选区；并且在
  // 跨行快速点击时还会产生半游离的 *非折叠* 选区（规范起点、游离终点），
  // 其光标会完全消失。将 DOM 选区归一到规范的模型位置。即使模型未变更
  // 也会执行，因为该缺陷纯属视觉层面。
  //
  // 拖选进行中跳过归一（applyModelSelectionToDOM 内部有同样的守卫）：
  // Firefox 拖选跨越行边界或 inline-void 时端点会短暂落在块 div 等
  // 非规范节点上，此时写回 DOM 会重置拖选锚点；mouseup 后会补一次。
  // 端点判定用 selection 的 anchor/focus 而非 getRangeAt(0)——Firefox
  // 跨 contenteditable=false inline 的选区被拆成多个 Range，第一段
  // 的边界落在 void 处属于正常拆分，不是游离节点。
  if (isMouseSelecting.value) return
  const sel = window.getSelection()
  const isCanonicalNode = (n: Node | null): boolean => {
    if (!n) return false
    const el =
      n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as HTMLElement)
    return !!el?.closest?.("[data-leaf-path],[data-void-path]")
  }
  if (
    sel &&
    sel.rangeCount > 0 &&
    (!isCanonicalNode(sel.anchorNode) || !isCanonicalNode(sel.focusNode))
  ) {
    applyModelSelectionToDOM()
  }
}

// --- trigger detection -------------------------------------------------

const activeTrigger = ref<TriggerContext | null>(null)
const popupStyle = ref<{ top: string; left: string }>({
  top: "-9999px",
  left: "-9999px"
})

const detectTrigger = (): void => {
  const editor = props.editor
  const sel = editor.selection
  if (!sel || !Range.isCollapsed(sel)) {
    closeTrigger()
    return
  }
  const [start] = Range.edges(sel)
  const wordBefore = Editor.before(editor, start, { unit: "word" })
  const before = wordBefore && Editor.before(editor, wordBefore)
  const beforeRange = before && Editor.range(editor, before, start)
  const beforeText = beforeRange && Editor.string(editor, beforeRange)
  if (!beforeText || !beforeRange) {
    closeTrigger()
    return
  }
  // 依次尝试每个插件的触发模式；第一个匹配的胜出。
  for (const plugin of plugins.value) {
    const pattern = getTriggerPattern(plugin)
    if (!pattern) continue
    const m = beforeText.match(pattern)
    if (m) {
      const search = m[1] ?? ""
      const ctx: TriggerContext = {
        name: plugin.name,
        search,
        range: beforeRange
      }
      const wasOpen = activeTrigger.value?.name === plugin.name
      activeTrigger.value = ctx
      if (wasOpen) emit("trigger-search", ctx)
      else emit("trigger-open", ctx)
      return
    }
  }
  closeTrigger()
}

const closeTrigger = (): void => {
  if (activeTrigger.value) {
    activeTrigger.value = null
    emit("trigger-close")
  }
}

// 在每次有触发符激活的渲染后重新定位弹出层。
const positionPopover = async (): Promise<void> => {
  await nextTick()
  const trigger = activeTrigger.value
  const root = rootEl.value
  if (!trigger || !root) return
  const dom = toDOMRange(root, trigger.range)
  if (!dom) return
  const rect = dom.getBoundingClientRect()
  popupStyle.value = {
    top: `${rect.top + window.pageYOffset + 24}px`,
    left: `${rect.left + window.pageXOffset}px`
  }
}

watch(activeTrigger, () => {
  positionPopover()
})

// --- mount / unmount ---------------------------------------------------

let onDocumentSelectionChange: (() => void) | null = null

/**
 * 最近一次通过 `update:modelValue` 发出的值。用途：
 *   1. 当值实际未变化时避免发出事件；
 *   2. 检测外部设置的 `modelValue` 是否与编辑器当前持有的值*不同*，
 *      以便重建模型——若没有此守卫，父组件若通过 `v-model` 直接把
 *      `update:modelValue` 回传进来，会形成写入循环。
 */
let lastEmittedText = ""

/**
 * 最近一次序列化时 `editor.children` 数组的引用。当 `revision` 自增但
 * `children` 未变化（即纯选区提交）时，跳过 O(n) 的 `modelToText` 遍历。
 */
let lastSerializedChildren: Descendant[] | null = null

const buildInitialModel = (): Descendant[] =>
  textToModel(props.modelValue ?? "", plugins.value)

onMounted(() => {
  const initial = buildInitialModel()
  initializeEditor(props.editor, initial)
  // 预置缓存，使首次 revision 变化时不会误发事件。
  const initialText = modelToText(props.editor.children, plugins.value)
  lastEmittedText = initialText
  serializedText.value = initialText
  lastSerializedChildren = props.editor.children
  onDocumentSelectionChange = () => {
    if (!isFocused.value) return
    flushSelectionFromDOM()
  }
  document.addEventListener("selectionchange", onDocumentSelectionChange)
  nextTick(() => {
    // 延迟聚焦模式：挂载时不主动设置 DOM 选区，避免浏览器自动聚焦 contenteditable
    if (rootEl.value && !props.deferFocusOnClick) {
      applyDOMRange(rootEl.value, props.editor.selection)
    }
  })
})

onBeforeUnmount(() => {
  if (onDocumentSelectionChange) {
    document.removeEventListener("selectionchange", onDocumentSelectionChange)
  }
  document.removeEventListener("mouseup", onDocumentMouseUp)
  document.removeEventListener("dragend", onDocumentMouseUp)
  if (limitTipTimer) {
    clearTimeout(limitTipTimer)
    limitTipTimer = null
  }
})

// 每次 revision 自增时同步 model -> DOM 并执行触发符检测。
// 这里有意不调用 positionPopover —— watch(activeTrigger) 会在触发符
// 状态变化（打开 / 搜索词更新 / 关闭）时处理它。
watch(
  () => props.editor.revision,
  () => {
    nextTick(() => {
      // 先修复浏览器（Firefox Enter 预注入等）对零宽占位结构的破坏，
      // 再写选区——否则光标可能落在缺失 FEFF 的空 span 上（高度 0）。
      repairLeafPlaceholders()
      applyModelSelectionToDOM()
      // 仅选区变化时（children 引用未变）跳过序列化。
      if (props.editor.children !== lastSerializedChildren) {
        lastSerializedChildren = props.editor.children
        const text = modelToText(props.editor.children, plugins.value)
        serializedText.value = text
        if (text !== lastEmittedText) {
          lastEmittedText = text
          emit("update:modelValue", text)
          emit("change", text)
        }
      }
      detectTrigger()
    })
  }
)

// 外部值变更：仅当新值与最近一次发出的值不同时才重建模型（否则父组件
// 的 v-model 回响会在每次按键时重新初始化并清空光标）。
watch(
  () => props.modelValue,
  (next) => {
    const incoming = next ?? ""
    if (incoming === lastEmittedText) return
    lastEmittedText = incoming
    serializedText.value = incoming
    initializeEditor(props.editor, textToModel(incoming, plugins.value))
    lastSerializedChildren = props.editor.children
  }
)

// --- wrapper click (forwards focus when clicking outside the editable) ---

const onWrapperClick = (e: MouseEvent): void => {
  if (props.disabled) return
  // 仅当点击事件直接命中容器自身（如 padding / border 等装饰区）时，才把
  // 焦点转交给 contenteditable。点击落在子节点（footer / 槽位 / 工具栏按钮
  // 等）时不要抢焦点，原因有二：
  //   1. 子节点通常自身需要 focus（如按钮、mention 面板）；
  //   2. 一旦把焦点抢回 contenteditable，reka-ui DismissableLayer 的
  //      useFocusOutside 会判定为 focus-outside，导致刚刚被打开的 Popover
  //      （例如 PromptField 的"提示词优化"）立即被 dismiss。
  if (e.target === e.currentTarget) {
    rootEl.value?.focus()
  }
}

// --- focus / blur ------------------------------------------------------

const onFocus = (): void => {
  isFocused.value = true
  // 这里不要把存储的模型选区强制写回 DOM。当焦点来自用户点击时，浏览器
  // 会把光标放在点击位置；用之前的模型选区覆盖它，会让光标弹回上次的
  // 位置（即"点击某行但光标不动"的 bug）。
  //
  // 正确做法是：等点击落定后，采用 DOM 当前的选区。仅当 DOM 选区不在
  // 编辑器内（即程序式 `.focus()` 且无光标）时，才将模型选区恢复到 DOM。
  nextTick(() => {
    const root = rootEl.value
    if (!root) return
    repairLeafPlaceholders()
    const sel = window.getSelection()
    const domInEditor =
      !!sel &&
      sel.rangeCount > 0 &&
      root.contains(sel.getRangeAt(0).startContainer)
    if (domInEditor) {
      flushSelectionFromDOM()
    } else if (props.editor.selection) {
      applyModelSelectionToDOM()
    }
  })
  emit("focus")
}

const onBlur = (e: FocusEvent): void => {
  // 当焦点切到内联可编辑子区时不应视作失焦——它们仍在编辑器内部。
  const next = e.relatedTarget as HTMLElement | null
  if (next && rootEl.value && rootEl.value.contains(next)) {
    return
  }
  isFocused.value = false
  emit("blur")
}

const onClick = (): void => {
  nextTick(() => {
    flushSelectionFromDOM()
    detectTrigger()
  })
}

// --- mouse drag-selection tracking --------------------------------------

const onDocumentMouseUp = (): void => {
  isMouseSelecting.value = false
  document.removeEventListener("mouseup", onDocumentMouseUp)
  document.removeEventListener("dragend", onDocumentMouseUp)
  // 拖选结束：补一次模型读取与游离端点归一（拖选期间被跳过）。
  nextTick(() => flushSelectionFromDOM())
}

const onRootMouseDown = (): void => {
  if (props.disabled) return
  isMouseSelecting.value = true
  // mouseup 可能发生在编辑器外（拖出边界后松开），监听 document。
  document.addEventListener("mouseup", onDocumentMouseUp)
  // 原生 HTML5 拖拽（拖动 mention 徽章、或拖拽已选中的文本）不会触发
  // `mouseup`——浏览器在 dragstart 后把鼠标追踪交给 OS 级拖拽会话，
  // 只在拖拽结束时派发 `dragend`。若不在这里同样监听并复位，
  // `isMouseSelecting` 会在一次徽章拖拽后永久卡在 true，导致后续所有
  // 编辑（插入 mention、撤销/重做、方向键跳过 inline）都无法把光标同步
  // 回 DOM，直到下一次“完整的” mousedown+mouseup 才会自愈。
  document.addEventListener("dragend", onDocumentMouseUp)
}

// --- beforeinput -------------------------------------------------------

const onBeforeInput = (event: InputEvent): void => {
  if (composing.value) return
  // 内联可编辑子区自治：插件自行处理输入，避免外层 preventDefault 吞事件。
  if (isInsideEditableInline(event)) return
  flushSelectionFromDOM()

  const type = event.inputType
  const data = event.data ?? ""

  switch (type) {
    case "insertText": {
      event.preventDefault()
      const limit = props.maxLength
      let textToInsert = data
      let wasTruncated = false
      if (limit != null && limit > 0) {
        const result = truncateToMaxLength(
          data,
          charCount.value,
          getSelectedVisibleCharCount(),
          limit
        )
        textToInsert = result.text
        wasTruncated = result.truncated
      }
      if (textToInsert) {
        Transforms.insertText(props.editor, textToInsert)
      }
      if (wasTruncated) {
        showLimitTip(INPUT_LIMIT_TIP_TEXT)
        emit("exceed-limit", charCount.value, limit!)
      }
      break
    }
    case "insertCompositionText":
      break
    case "deleteContentBackward":
    case "deleteWordBackward":
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      event.preventDefault()
      Transforms.delete(props.editor, { reverse: true })
      break
    case "deleteContentForward":
    case "deleteWordForward":
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      event.preventDefault()
      Transforms.delete(props.editor, { reverse: false })
      break
    case "insertParagraph":
    case "insertLineBreak": {
      event.preventDefault()
      // 若 Firefox 在此 beforeinput 之前触发了 selectionchange 并把
      // editor.selection 移到了错误位置，则恢复 keydown 时拍摄的快照，
      // 使 splitBlock 作用于正确的光标位置。
      if (savedSelectionForEnter !== null) {
        const s = savedSelectionForEnter
        // eslint-disable-next-line vue/no-mutating-props
        props.editor.selection = {
          anchor: { path: s.path, offset: s.offset },
          focus: { path: s.path, offset: s.offset }
        }
      }
      Transforms.splitBlock(props.editor)
      break
    }
    case "insertFromPaste":
      event.preventDefault()
      break
    case "historyUndo":
      event.preventDefault()
      props.editor.undo()
      break
    case "historyRedo":
      event.preventDefault()
      props.editor.redo()
      break
    default:
      break
  }
  // 每次 beforeinput 后都清除（insertParagraph 场景已隐式清除；
  // 此处处理 Enter 之后跟随的任何其他 inputType）。
  savedSelectionForEnter = null
}

// --- IME composition ---------------------------------------------------

const onCompositionStart = (event: CompositionEvent): void => {
  if (isInsideEditableInline(event)) return
  composing.value = true
}

const onCompositionEnd = (event: CompositionEvent): void => {
  if (isInsideEditableInline(event)) return
  composing.value = false
  const limit = props.maxLength
  if (event.data && limit != null && limit > 0) {
    // 输入法组合替换的是进行中的文本，而非模型选区，因此
    // selectedCount 为 0，currentCount 已反映组合前的模型状态。
    const result = truncateToMaxLength(event.data, charCount.value, 0, limit)
    if (result.truncated) {
      showLimitTip(INPUT_LIMIT_TIP_TEXT)
      emit("exceed-limit", charCount.value, limit)
    }
    if (result.text) {
      Transforms.insertText(props.editor, result.text)
    }
    // 若组合结果被部分截断，DOM 中可能仍包含完整的组合文本 ——
    // 同步该 leaf 以丢弃多余的字符。
    if (result.text !== event.data) {
      syncCurrentLeafFromDOM()
    }
  } else if (event.data) {
    Transforms.insertText(props.editor, event.data)
  } else {
    syncCurrentLeafFromDOM()
  }
}

const syncCurrentLeafFromDOM = (): void => {
  const root = rootEl.value
  if (!root) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const dom = sel.getRangeAt(0)
  if (!root.contains(dom.startContainer)) return
  let el: Node | null = dom.startContainer
  if (el.nodeType === Node.TEXT_NODE) el = el.parentNode
  let cur: HTMLElement | null = el as HTMLElement | null
  while (cur && cur !== root) {
    const pathAttr = cur.getAttribute("data-leaf-path")
    if (pathAttr) {
      const path = JSON.parse(pathAttr) as number[]
      const stringEl = cur.querySelector<HTMLElement>("[data-slate-string]")
      const textNode = stringEl?.firstChild
      if (textNode && textNode.textContent != null) {
        const leaf = getText(props.editor, path)
        if (leaf && leaf.text !== textNode.textContent) {
          const domText = textNode.textContent
          if (domText.includes("\n")) {
            // Chrome 原生编辑（composition 期间无法 preventDefault）
            // 可能把字面 \n 留在 DOM 文本节点里。模型不变式禁止
            // 叶内 \n——清空该叶后经 Transforms.insertText 重新写入，
            // 其内部会把 \n 拆成 splitBlock（换行 = 段落块边界）。
            leaf.text = ""
            // eslint-disable-next-line vue/no-mutating-props
            props.editor.selection = {
              anchor: { path: path.slice(), offset: 0 },
              focus: { path: path.slice(), offset: 0 }
            }
            Transforms.insertText(props.editor, domText)
          } else {
            leaf.text = domText
            props.editor.apply()
          }
        }
      }
      return
    }
    cur = cur.parentElement
  }
}

// --- keyboard ----------------------------------------------------------

// Firefox 在按下 Enter 时会在 `beforeinput` 之前触发 `selectionchange`，
// 可能把编辑器选区移到错误位置（例如段落开头而非实际光标处）。我们在
// `keydown` 时——DOM 尚未修改——对当前模型选区拍摄快照，并在
// `onBeforeInput` 中为 insertParagraph / insertLineBreak 场景恢复它。
let savedSelectionForEnter: { path: number[]; offset: number } | null = null

/**
 * 检测"光标位于紧邻 inline-void 兄弟节点的空文本叶中"这一情形——此时
 * 单次 ArrowLeft/ArrowRight 在视觉上没有反应，因为浏览器停在零宽 FEFF
 * 字符上。
 *
 * 返回移动后期望的模型点；若无需特殊处理（交给浏览器即可）则返回 `null`。
 */
const inlineHopTarget = (
  reverse: boolean
): { path: number[]; offset: number } | null => {
  const editor = props.editor
  const sel = editor.selection
  if (!sel || !Range.isCollapsed(sel)) return null
  const { path, offset } = sel.anchor
  if (path.length < 2) return null
  const [bi, ii] = path as [number, number]
  const block = editor.children[bi]
  if (!block || !("children" in block)) return null
  const blockChildren = (block as Paragraph).children
  const leaf = blockChildren[ii]
  if (!leaf || "children" in leaf) return null
  const leafText = (leaf as { text: string }).text

  if (reverse) {
    // 当光标位于叶起点时，向左跳过紧邻当前叶之前的 inline。
    if (offset !== 0) return null
    const prev = blockChildren[ii - 1]
    if (!prev || !("children" in prev)) return null
    if ((prev as { type?: string }).type === undefined) return null
    // 落在 inline 之前的文本叶末尾（规范化保证其存在）。
    const beforeIdx = ii - 2
    if (beforeIdx < 0) return null
    const beforeLeaf = blockChildren[beforeIdx]
    if (!beforeLeaf || "children" in beforeLeaf) return null
    return {
      path: [bi, beforeIdx],
      offset: (beforeLeaf as { text: string }).text.length
    }
  } else {
    // 当光标位于叶末尾时，向右跳过紧邻当前叶之后的 inline。
    if (offset !== leafText.length) return null
    const next = blockChildren[ii + 1]
    if (!next || !("children" in next)) return null
    if ((next as { type?: string }).type === undefined) return null
    const afterIdx = ii + 2
    if (afterIdx >= blockChildren.length) return null
    const afterLeaf = blockChildren[afterIdx]
    if (!afterLeaf || "children" in afterLeaf) return null
    return { path: [bi, afterIdx], offset: 0 }
  }
}

/**
 * 当光标位于空文本叶（零宽 FEFF）中时，浏览器会把 FEFF 字符当作真实停靠点：
 * ArrowRight 从 offset 0 移到 offset 1（若存在 <br> 还可能进一步深入）才
 * 离开该 span，多耗费一次按键。本函数返回正确的下一个/上一个模型点，
 * 使 onKeydown 能完全跳过该停靠点。
 */
const zeroWidthHopTarget = (
  reverse: boolean
): { path: number[]; offset: number } | null => {
  const editor = props.editor
  const sel = editor.selection
  if (!sel || !Range.isCollapsed(sel)) return null
  const { path } = sel.anchor
  if (path.length < 2) return null
  const [bi, ii] = path as [number, number]
  const block = editor.children[bi]
  if (!block || !("children" in block)) return null
  const blockChildren = (block as Paragraph).children
  const leaf = blockChildren[ii]
  // 仅当叶为空（零宽填充）时才生效。
  if (!leaf || "children" in leaf || (leaf as { text: string }).text !== "")
    return null

  if (!reverse) {
    // ArrowRight：当前块中右侧的第一个文本叶……
    for (let j = ii + 1; j < blockChildren.length; j++) {
      const node = blockChildren[j]
      if (node && !("children" in node)) {
        return { path: [bi, j], offset: 0 }
      }
    }
    // ……再取下一个块的第一个文本叶。
    const nextBlock = editor.children[bi + 1]
    if (nextBlock && "children" in nextBlock) {
      const nc = (nextBlock as Paragraph).children
      for (let j = 0; j < nc.length; j++) {
        const node = nc[j]
        if (node && !("children" in node)) {
          return { path: [bi + 1, j], offset: 0 }
        }
      }
    }
  } else {
    // ArrowLeft：当前块中左侧的第一个文本叶……
    for (let j = ii - 1; j >= 0; j--) {
      const node = blockChildren[j]
      if (node && !("children" in node)) {
        return { path: [bi, j], offset: (node as { text: string }).text.length }
      }
    }
    // ……再取上一个块的最后一个文本叶。
    if (bi > 0) {
      const prevBlock = editor.children[bi - 1]
      if (prevBlock && "children" in prevBlock) {
        const pc = (prevBlock as Paragraph).children
        for (let j = pc.length - 1; j >= 0; j--) {
          const node = pc[j]
          if (node && !("children" in node)) {
            return {
              path: [bi - 1, j],
              offset: (node as { text: string }).text.length
            }
          }
        }
      }
    }
  }
  return null
}

const isUndoCombo = (e: KeyboardEvent): boolean =>
  (e.metaKey || e.ctrlKey) &&
  !e.shiftKey &&
  !e.altKey &&
  e.key.toLowerCase() === "z"

const isRedoCombo = (e: KeyboardEvent): boolean => {
  if (e.altKey) return false
  // Win/Linux 上为 Ctrl+Y，macOS 上为 Shift+Cmd+Z，其余环境为 Shift+Ctrl+Z。
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
    return true
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "y")
    return true
  return false
}

const onKeydown = (e: KeyboardEvent): void => {
  // 内联可编辑子区自治：插件自行决定键盘行为。
  if (isInsideEditableInline(e)) {
    emit("keydown", e)
    return
  }
  // 让当前激活的插件优先拦截。
  const trigger = activeTrigger.value
  if (trigger) {
    const plugin = plugins.value.find((p) => p.name === trigger.name)
    if (plugin?.onKeyDown && plugin.onKeyDown(e, trigger)) {
      return
    }
    // 默认行为：Escape 关闭弹出层。
    if (e.key === "Escape") {
      e.preventDefault()
      closeTrigger()
      return
    }
  }

  // 撤销 / 重做 —— 接管编辑器的历史栈。必须在此接管，因为浏览器原生的
  // contenteditable 撤销会在我们模型之下直接修改 DOM。
  if (isRedoCombo(e)) {
    e.preventDefault()
    props.editor.redo()
    emit("keydown", e)
    return
  }
  if (isUndoCombo(e)) {
    e.preventDefault()
    props.editor.undo()
    emit("keydown", e)
    return
  }

  // 在 Firefox 通过提前触发的 selectionchange 事件（在 keydown 与
  // beforeinput 之间为 Enter 触发）破坏模型选区之前，先拍摄快照。
  if (e.key === "Enter" && !composing.value) {
    const sel = props.editor.selection
    savedSelectionForEnter = sel
      ? { path: sel.anchor.path.slice(), offset: sel.anchor.offset }
      : null
  }

  // ArrowLeft / ArrowRight：当光标因停在与 inline 相邻的空文本叶中的
  // 零宽 FEFF 填充上而视觉卡顿时，用一次按键跳过 inline-void。
  // 我们只拦截 *单步* 且无修饰键的箭头键，使 Shift 选区 /
  // Option 按词跳转保持浏览器原生行为。
  if (
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight")
  ) {
    const reverse = e.key === "ArrowLeft"
    const target = inlineHopTarget(reverse) ?? zeroWidthHopTarget(reverse)
    if (target) {
      e.preventDefault()
      Transforms.select(props.editor, {
        anchor: { path: target.path, offset: target.offset },
        focus: { path: target.path, offset: target.offset }
      })
      return
    }
  }

  emit("keydown", e)
}

const onPaste = (e: ClipboardEvent): void => {
  if (composing.value) return
  if (isInsideEditableInline(e)) return
  const text = e.clipboardData?.getData("text/plain")
  if (text == null) return
  e.preventDefault()
  flushSelectionFromDOM()
  const limit = props.maxLength
  if (limit != null && limit > 0) {
    const result = truncateToMaxLength(
      text,
      charCount.value,
      getSelectedVisibleCharCount(),
      limit
    )
    if (result.truncated) {
      showLimitTip(PASTE_TRUNCATE_TIP_TEXT)
      emit("exceed-limit", charCount.value, limit)
    }
    insertSerializedText(result.text)
  } else {
    insertSerializedText(text)
  }
}

/**
 * 把"真实字符串"粘贴回编辑器：先用 plugin.parse（textToModel）把字符串
 * 还原成 Descendant[]，再按段落顺序插回光标位置。
 *
 * 实现要点：
 *  - 每个 `\n` 对应一个段落块（textToModel 已按行拆分），行与行之间用
 *    `Transforms.splitBlock()` 产生新块——与手动按 Enter 的行为完全一致，
 *    粘贴后的 DOM 结构（每行一个 <div data-block-path>）与直接输入无异。
 *  - 段内纯文本片段：走 `Transforms.insertText`；文本叶内不会出现字面 `\n`。
 *  - 段内 inline 节点：单独调用 `Transforms.insertNodes`，引擎会把光标
 *    精确放到 inline 之后的空文本叶起点，便于续接下一片段。
 *  逐项串行避免一次性插入混合数组时因光标推算误差导致的段落顺序错位。
 */
const insertSerializedText = (text: string): void => {
  if (!text) return
  const fragment = textToModel(text, plugins.value)
  // 将整次粘贴——可能产生多次 insertText / insertNodes / splitBlock
  // 调用——折叠为单条历史记录，使 Ctrl+Z 能一次性回滚整次粘贴，
  // 而非逐个片段地撤销。
  props.editor.batch(() => {
    for (let i = 0; i < fragment.length; i++) {
      const block = fragment[i]
      if (
        !block ||
        !("children" in block) ||
        (block as { type?: string }).type !== "paragraph"
      ) {
        continue
      }
      const children = (block as Paragraph).children
      for (const child of children) {
        if ("children" in child) {
          Transforms.insertNodes(props.editor, child as Descendant)
        } else {
          const t = (child as { text: string }).text
          if (t !== "") Transforms.insertText(props.editor, t)
        }
      }
      if (i < fragment.length - 1) {
        Transforms.splitBlock(props.editor)
      }
    }
  })
}

// --- copy / cut / drag (real-string serialization) ---------------------

/**
 * 把当前模型选区序列化为"真实字符串"——即 plugin.serialize 输出的源串
 * （如 `@[name](id)`、`{{Ref 1}}`），而不是 DOM 上的可视展示文本。
 *
 * 返回 null 表示无可复制内容（选区为空/折叠/位于自治子区内）。
 */
const serializeSelection = (): string | null => {
  flushSelectionFromDOM()
  const sel = props.editor.selection
  if (!sel || Range.isCollapsed(sel)) return null
  const out = serializeRange(props.editor.children, sel, plugins.value)
  return out.length > 0 ? out : null
}

// 内联可编辑子区自治：复制行为交给浏览器原生，子区文本即源文本。
const writeSelectionToClipboard = (e: ClipboardEvent): boolean => {
  if (composing.value) return false
  if (isInsideEditableInline(e)) return false
  const text = serializeSelection()
  if (text == null) return false
  const cd = e.clipboardData
  if (!cd) return false
  e.preventDefault()
  cd.setData("text/plain", text)
  return true
}

const onCopy = (e: ClipboardEvent): void => {
  writeSelectionToClipboard(e)
}

const onCut = (e: ClipboardEvent): void => {
  // 写入剪贴板后再删除选区，确保 undo 仍可回滚此次删除。
  if (writeSelectionToClipboard(e)) Transforms.delete(props.editor)
}

const onDragStart = (e: DragEvent): void => {
  if (composing.value) return
  if (isInsideEditableInline(e)) return
  const text = serializeSelection()
  if (text == null) return
  const dt = e.dataTransfer
  if (!dt) return
  dt.setData("text/plain", text)
  // 不 preventDefault：保留浏览器默认拖拽视觉。
}

// --- rendering helpers -------------------------------------------------

const isInline = (n: Descendant): n is CustomInline =>
  "children" in n &&
  (n as { type?: string }).type !== undefined &&
  (n as { type?: string }).type !== "paragraph"

const isParaEmpty = (block: Paragraph): boolean => {
  const c = block.children
  if (c.length === 1) {
    const only = c[0]
    return (
      !!only && !("children" in only) && (only as { text: string }).text === ""
    )
  }
  return false
}

const elementAttrs = (path: number[]) => ({
  "data-slate-node": "element",
  "data-slate-inline": "true",
  "data-slate-void": "true",
  "data-void-path": JSON.stringify(path),
  contenteditable: "false"
})

const slotForElement = (el: CustomInline): string => {
  const plugin = pluginByInlineType(el.type)
  return plugin ? `element:${plugin.name}` : "element"
}

const isDocumentEmpty = computed(() => {
  const c = props.editor.children
  if (c.length === 0) return true
  if (c.length > 1) return false
  const block = c[0]
  if (!block || !("children" in block)) return false
  const p = block as Paragraph
  return isParaEmpty(p)
})

// --- popover commit helper exposed to slot -----------------------------

const commitForActive = (payload: {
  range?: RangeType
  data: unknown
}): void => {
  const trigger = activeTrigger.value
  if (!trigger) return
  const plugin = plugins.value.find((p) => p.name === trigger.name)
  if (!plugin?.commit) return
  const limit = props.maxLength
  plugin.commit(props.editor, {
    range: payload.range ?? trigger.range,
    data: payload.data
  })
  closeTrigger()
  // 提交后的字数检查：若提交导致超出上限，则撤销它。
  if (limit != null && limit > 0 && charCount.value > limit) {
    props.editor.undo()
    showLimitTip(INPUT_LIMIT_TIP_TEXT)
    emit("exceed-limit", charCount.value, limit)
  }
}

defineExpose({
  editor: props.editor,
  /** The contenteditable root element (NOT the wrapper). */
  editableEl: rootEl,
  /** Current visible character count. */
  charCount,
  /** Allow external callers to trigger the limit tip. */
  showLimitTip,
  toDOMRange: (range: RangeType) =>
    rootEl.value ? toDOMRange(rootEl.value, range) : null,
  closeTrigger,
  /**
   * 提交当前激活的触发符：用携带 `data` 的 inline 节点替换触发范围。
   * 供外部（如插件 onKeyDown）在不访问 slot scope 的情况下完成提交。
   */
  commitActive: commitForActive,
  /**
   * 返回当前选区对应的"真实字符串"（经 plugin.serialize 还原），
   * 折叠/无选区时返回空串。
   */
  getSelectedText: (): string => serializeSelection() ?? "",
  /** 返回整篇文档的"真实字符串"，等价于当前 modelValue。 */
  getFullText: (): string => modelToText(props.editor.children, plugins.value),
  /** 重新定位 popover（画布场景视口变化时由外部调用）。 */
  repositionPopover: positionPopover,
  /** 聚焦编辑区。 */
  focus: () => rootEl.value?.focus()
})
</script>

<template>
  <div
    :class="[
      'prompt-input',
      'relative w-full flex flex-col',
      props.wrapperClass,
      isFocused && 'prompt-input-focused'
    ]"
    v-bind="attrs"
    @click="onWrapperClick"
  >
    <div
      ref="rootEl"
      :contenteditable="!props.disabled"
      role="textbox"
      :aria-disabled="props.disabled ? 'true' : undefined"
      spellcheck="false"
      data-cy="prompt-input"
      data-slate-editor="true"
      data-slate-node="value"
      :data-placeholder="placeholder"
      :class="[
        props.containerClass ?? [
          'relative min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm leading-7 cursor-text',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'whitespace-pre-wrap',
          isDocumentEmpty &&
            !isFocused &&
            'before:content-[attr(data-placeholder)] before:text-muted-foreground before:pointer-events-none before:absolute before:left-3 before:top-3 before:leading-7'
        ],
        hasFooter ? 'flex-1 min-h-0' : 'flex-1'
      ]"
      @beforeinput="onBeforeInput"
      @keydown="onKeydown"
      @mousedown="onRootMouseDown"
      @click="onClick"
      @focus="onFocus"
      @blur="onBlur"
      @paste="onPaste"
      @copy="onCopy"
      @cut="onCut"
      @dragstart="onDragStart"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
    >
      <div
        v-for="(block, bi) in editor.children"
        :key="`block-${bi}`"
        :data-block-path="JSON.stringify([bi])"
        data-slate-node="element"
        class="my-0"
      >
        <template
          v-for="(child, ci) in (block as Paragraph).children"
          :key="`child-${bi}-${ci}`"
        >
          <!-- inline-void element: route to `#element:<plugin>` slot -->
          <slot
            v-if="isInline(child)"
            :name="slotForElement(child as CustomInline)"
            :attributes="elementAttrs([bi, ci])"
            :element="child"
          >
            <!-- generic fallback if neither named slot nor `#element` exists -->
            <slot
              name="element"
              :attributes="elementAttrs([bi, ci])"
              :element="child"
            >
              <span
                v-bind="elementAttrs([bi, ci])"
                contenteditable="false"
                class="px-1 mx-0.5 rounded bg-muted text-xs"
              >
                [{{ (child as CustomInline).type }}]
              </span>
            </slot>
          </slot>
          <!-- text leaf -->
          <span v-else data-slate-node="text">
            <span
              data-slate-leaf="true"
              :data-leaf-path="JSON.stringify([bi, ci])"
            >
              <!--
                                三个分支全部用 <span> 而非 <template v-if>，避免产生 Fragment VNode。
                                Chrome 的 contenteditable 会在 normalize 时删除 Fragment 边界的空文本节点，
                                导致 Vue 的 removeFragment 在遍历时拿到 null.nextSibling 而崩溃。
                                三个 <span> 类型相同，Vue 原地 patch 属性/子节点，不会 unmount Fragment。
                            -->
              <!--
                                空段落叶 = FEFF + <br>（slate.js 同款结构）：FEFF 是光标的
                                停靠文本节点，<br> 撑起空行行高。缺 <br> 时 Firefox 会在 Enter
                                的 beforeinput *之前*自行注入 <br> 并顺手吞掉 FEFF 文本节点——
                                模型空叶未变，Vue 不会重渲染，破坏就此固化（空行高度塌为 0，
                                表现为"回车后光标消失"）。运行期破坏由 repairLeafPlaceholders 自愈。
                            -->
              <span
                v-if="
                  (child as { text: string }).text === '' &&
                  isParaEmpty(block as Paragraph)
                "
                data-slate-zero-width="n"
                data-slate-length="0"
                >&#xFEFF;<br
              /></span>
              <span
                v-else-if="(child as { text: string }).text === ''"
                data-slate-zero-width="z"
                data-slate-length="0"
                >&#xFEFF;</span
              >
              <span
                v-else
                data-slate-string="true"
                style="white-space: pre-wrap"
                >{{ (child as { text: string }).text }}</span
              >
            </span>
          </span>
        </template>
      </div>
    </div>

    <!-- Footer: character counter, clear button, limit tip, and footer-action slot -->
    <div
      v-if="hasFooter"
      class="prompt-input-footer shrink-0 flex items-stretch justify-between rounded-b-md px-3 py-2"
    >
      <div class="flex min-w-0 flex-1 items-center">
        <span
          v-if="limitTipVisible"
          class="pointer-events-none truncate text-xs text-destructive"
        >
          {{ limitTipText }}
        </span>
        <div
          v-else-if="showCounter"
          class="flex items-center gap-x-0.5 text-xs text-muted-foreground"
        >
          <span class="pointer-events-none min-w-[3.75rem] text-left"
            >{{ charCount }} / {{ maxLength }}</span
          >
          <span
            v-if="showClear && charCount > 0"
            class="mx-1 h-3 w-px bg-border"
            aria-hidden="true"
          ></span>
          <button
            v-if="showClear && charCount > 0"
            type="button"
            class="pointer-events-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
            :disabled="props.disabled"
            aria-label="清空内容"
            @click="handleClear"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <span v-else aria-hidden="true"></span>
      </div>
      <div class="flex items-center">
        <slot name="footer-action" />
      </div>
    </div>
  </div>

  <!-- Popover portals: one Teleport per plugin that owns the active trigger.
       Only the active plugin's slot actually renders content. -->
  <Teleport
    v-if="activeTrigger && slots[`portal:${activeTrigger.name}`]"
    to="body"
  >
    <div
      data-cy="prompt-portal"
      :style="{
        position: 'absolute',
        top: popupStyle.top,
        left: popupStyle.left,
        zIndex: 1000
      }"
      @mousedown.prevent
    >
      <slot
        :name="`portal:${activeTrigger.name}`"
        :trigger="activeTrigger"
        :commit="commitForActive"
        :close="closeTrigger"
        :editor="editor"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.prompt-input {
  font-size: 14px;
  border: 1px solid hsl(var(--border));
  cursor: text;
}

.prompt-input-focused {
  box-shadow: 0 0 0 1px hsl(var(--border));
}

/* 使文本叶与 inline-void 元素对齐（徽章使用 vertical-align: middle）。
   否则纯文本会落在基线上，而徽章是中线对齐，导致纯文本显得比徽章内部文本略高。 */
.prompt-input :deep([data-slate-node="text"]) {
  vertical-align: middle;
}
</style>
