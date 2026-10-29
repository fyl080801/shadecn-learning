<script setup lang="ts">
import { computed, onBeforeUnmount, provide, shallowReactive, watch } from "vue"
import { Position } from "@vue-flow/core"
import { NodeToolbar } from "@vue-flow/node-toolbar"

import type { FlowNodeViewProps } from "@/components/flow/node-view"
import { useFlowEditor } from "@/composables/flow/editor-context"
import { useFlowNode } from "@/composables/flow/useFlowNode"
import { cn } from "@/lib/utils"

import ActionBar from "./ActionBar.vue"
import NodePresence from "./NodePresence.vue"
import NodeSlot from "./NodeSlot.vue"
import { NODE_PART_KEY, useNodeKitRuntime } from "./context"
import type {
  NodeActionDef,
  NodeActionSlot,
  NodePartContext,
  NodePartDef,
  NodeSlot as NodeSlotName
} from "./protocol"

/**
 * 节点宿主（REQ-NODEKIT §4.2）—— 每种节点的根，**区域的几何与露出规则只在这里**。
 *
 * 它做三件事：
 * 1. 建这个节点的上下文（`NodePartContext`）并 provide，部件 / 动作 / 模式钩子 / 事件处理函数都从它取；
 * 2. 按节点类型向注册表要每个区域的部件和动作，算动态的 `when`，渲染到对应位置；
 * 3. 外壳本身：按类型的外观（`view`：卡片 / 框、尺寸、底色、body）画根元素，以及唯一内置的部件 ——
 *    在场头像（所有节点强制显示）。名字、工具条按钮、连接点、运行态展示、拉伸、双击编辑都是能力
 *    （`./features/`），按类型声明启用。
 *
 * **它就是 Vue Flow 的节点组件**：`node-types.ts` 把每个 type 都映射到它，props 是 Vue Flow 给的那一套。
 *
 * **这里不认识任何具体类型、任何具体能力**（没有 `if (type === 'group')`，也没有 `has('runnable')`）。
 *
 * 区域的露出分两层：宿主决定这个区域此刻**能不能**出现，部件的 `when` 只能在此之上收窄。
 * 框外的区域（composer / side）解析结果为空时连 `NodeToolbar` 都不挂 —— 几十个节点不挂几十个空浮层，
 * 也就不存在「有但隐藏」：没给这个类型注册底部输入框，它就没有底部输入框。
 */
const props = defineProps<FlowNodeViewProps>()

/** 卡片选中时的默认高亮；外观给了 `selectedClass` 就用它的 */
const DEFAULT_SELECTED_CLASS = "border-primary shadow-md ring-2 ring-primary/40"

const editor = useFlowEditor()
const runtime = useNodeKitRuntime()
const { kit, modes } = runtime
const node = useFlowNode(() => props.id)

/** 这种节点长什么样（注册表里没有就是空的：一张空卡片） */
const view = computed(() => kit.viewOf(props.type))

/** 「被要求才露出」的区域，这个节点上现在开着哪些（本地 UI 状态） */
const openSlots = shallowReactive(new Set<NodeSlotName>())

const selected = computed(() => props.selected)

/** 显示的名字：起了名用名字，没起名用兜底 */
const label = computed(() => node.label.value || view.value.fallbackLabel || "")

const ctx: NodePartContext = {
  get id() {
    return props.id
  },
  get type() {
    return props.type
  },
  get features() {
    return kit.featuresOf(props.type)
  },
  node,
  label,
  editor,
  selected,
  mode: modes.viewFor(
    () => props.id,
    () => ctx
  ),
  slots: {
    open(slot) {
      if (openSlots.has(slot)) return
      openSlots.add(slot)
      ctx.emit("slot:open", { slot })
    },
    close(slot) {
      if (!openSlots.delete(slot)) return
      ctx.emit("slot:close", { slot })
    },
    isOpen: (slot) => openSlots.has(slot)
  },
  has: (feature) => kit.hasFeature(props.type, feature),
  emit: (event, payload) => kit.emit(event, payload, ctx)
}

provide(NODE_PART_KEY, ctx)

// 登记到编辑器级的表里，快捷键靠它找到「选中的那个节点」的上下文（id 理论上不变，变了也跟着换）
watch(
  () => props.id,
  (id, previous) => {
    if (previous !== undefined && runtime.hosts.get(previous) === ctx) runtime.hosts.delete(previous)
    runtime.hosts.set(id, ctx)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (runtime.hosts.get(props.id) === ctx) runtime.hosts.delete(props.id)
})

// —— 区域里挂什么 ——

/** 注册表按类型解析（有缓存），这里只再算一遍动态的 `when` */
function partsIn(slot: NodeSlotName): NodePartDef[] {
  return kit.partsFor(props.type, slot).filter((part) => !part.when || part.when(ctx))
}

function actionsIn(slot: NodeActionSlot): NodeActionDef[] {
  return kit.actionsFor(props.type, slot).filter((action) => !action.when || action.when(ctx))
}

const parts = computed(() => ({
  label: partsIn("label"),
  toolbar: partsIn("toolbar"),
  badge: partsIn("badge"),
  header: partsIn("header"),
  footer: partsIn("footer"),
  composer: partsIn("composer"),
  side: partsIn("side"),
  overlay: partsIn("overlay"),
  handles: partsIn("handles")
}))

const actions = computed(() => ({
  toolbar: actionsIn("toolbar"),
  footer: actionsIn("footer"),
  composer: actionsIn("composer")
}))

// —— 区域露不露出（宿主的几何约定）——

/**
 * 「当前单独选中的就是它，而且手上没在拉框」。
 *
 * 判 `selection` 而不是节点的 `selected`：前者是「现在轮到哪个节点」（Vue Flow 选中态的投影，
 * 只在恰好选中一个时有值），后者框选一片时每个都为真 —— 那会同时冒出一排工具栏，
 * 而上面的按钮都是对单个节点说的；框选一片时该出现的是**选区**工具栏（`FlowSelectionToolbar`）。
 *
 * 拉框期间还要再挡一道：框扫过第一个节点时它会短暂地成为「唯一选中」，
 * 按钮于是闪一下又消失 —— 拉框时要看的是高亮，不是弹来弹去的按钮。
 */
const singleSelected = computed(
  () => editor.selection.selectedNodeId.value === props.id && !editor.canvas.boxSelecting.value
)

function override(slot: NodeSlotName) {
  return modes.slotOverride(props.id, slot)
}

const toolbarVisible = computed(() => singleSelected.value && override("toolbar") !== "conceal")

/**
 * 名字那一行贴节点上边的距离；操作栏 = 名字行的偏移 + 名字行自身的高度 + 一点间距。
 *
 * 两块是各自独立定位的（NodeToolbar 各管各的），没有文档流会把它们推开 ——
 * 所以「堆叠」是靠这个偏移量算出来的，名字行的高度变了就得跟着调。这是宿主里唯一保留的偏移计算。
 */
const LABEL_OFFSET = 4
const TOOLBAR_OFFSET = LABEL_OFFSET + 20 + 6

const composerHasContent = computed(
  () => parts.value.composer.length > 0 || actions.value.composer.length > 0
)

/** 底部输入框：单独选中时露出，模式要求时也露出；拉框时一律不出 */
const composerVisible = computed(() => {
  if (!composerHasContent.value || editor.canvas.boxSelecting.value) return false
  const rule = override("composer")
  if (rule === "conceal") return false
  return rule === "reveal" || singleSelected.value || openSlots.has("composer")
})

/** 侧边预览：只在被要求时（模式要求，或 `slots.open('side')`） */
const sideVisible = computed(() => {
  if (parts.value.side.length === 0 || editor.canvas.boxSelecting.value) return false
  const rule = override("side")
  if (rule === "conceal") return false
  return rule === "reveal" || openSlots.has("side")
})

// —— 外观 ——

/** `data-status` 是节点运行态的标记（每个节点都有 runtime），给样式和测试用；怎么展示是能力 `status` 的事 */
const status = computed(() => node.runtime.value.status)

const rootClass = computed(() =>
  cn(
    "relative",
    view.value.shell !== "frame" &&
      "rounded-md border bg-card text-sm text-card-foreground shadow-sm transition-shadow",
    view.value.class,
    ...kit.rootClassesFor(props.type).map((rootClass) => rootClass(ctx)),
    props.selected ? (view.value.selectedClass ?? DEFAULT_SELECTED_CLASS) : view.value.idleClass
  )
)

const rootStyle = computed(() => view.value.style?.(ctx))

/** 双击节点本体：交给事件总线，「双击做什么」由能力决定（`edit-body` 接住就进编辑模式） */
function onDblclick(event: MouseEvent) {
  ctx.emit("node:dblclick", { event })
}

/** 框外下方 / 右侧两个区域贴节点的距离 */
const OUTER_OFFSET = 8
</script>

<template>
  <div :class="rootClass" :style="rootStyle" :data-status="status" @dblclick="onDblclick">
    <!--
      节点名挂在节点外部左上角：定位交给 Vue Flow 官方的 NodeToolbar
      （position=Top + align=start），缩放/拖动时的跟随由它负责，这里不写定位样式。
      is-visible 常开（在场头像每个节点都要显示），否则默认只在节点被选中时出现。
    -->
    <NodeToolbar
      :node-id="id"
      :is-visible="true"
      :position="Position.Top"
      align="start"
      :offset="LABEL_OFFSET"
    >
      <div class="flex items-center gap-1.5" data-node-slot="label">
        <NodeSlot :parts="parts.label" />
        <NodePresence />
      </div>
    </NodeToolbar>

    <!--
      操作栏：堆在名字那一行的上面，水平居中对齐节点。样式照搬底部的 FlowToolbar
      （圆角胶囊 + 半透明卡片底 + backdrop-blur + size-8 圆按钮），画布上的浮动工具栏就该长一个样。
    -->
    <NodeToolbar
      v-if="actions.toolbar.length > 0 || parts.toolbar.length > 0"
      :node-id="id"
      :is-visible="toolbarVisible"
      :position="Position.Top"
      align="center"
      :offset="TOOLBAR_OFFSET"
    >
      <div
        class="nodrag nopan flex items-center gap-1 rounded-full border bg-card/95 p-1.5 shadow-lg backdrop-blur"
        data-node-slot="toolbar"
      >
        <ActionBar :actions="actions.toolbar" />
        <NodeSlot :parts="parts.toolbar" />
      </div>
    </NodeToolbar>

    <!-- 角标：节点内部的外观，贴着卡片自己的角，不是画布上的定位 -->
    <div
      v-if="parts.badge.length > 0"
      class="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1"
    >
      <NodeSlot :parts="parts.badge" />
    </div>

    <NodeSlot :parts="parts.header" />

    <component :is="view.body" v-if="view.body" />

    <NodeSlot :parts="parts.footer" />
    <div v-if="actions.footer.length > 0" class="nodrag nopan flex items-center gap-1 px-2 py-1">
      <ActionBar :actions="actions.footer" />
    </div>

    <NodeSlot :parts="parts.overlay" />
    <NodeSlot :parts="parts.handles" />

    <!--
      框外的两个区域：定位交给 NodeToolbar（缩放 / 平移时的跟随由它负责），一个区域一个，
      区域内多个部件在里面用 flex 排，不靠偏移量把几个独立浮层「算」到一起。
      解析结果为空就不挂（v-if 在 NodeToolbar 上，不是在它的内容上）。
    -->
    <NodeToolbar
      v-if="composerHasContent"
      :node-id="id"
      :is-visible="composerVisible"
      :position="Position.Bottom"
      align="center"
      :offset="OUTER_OFFSET"
    >
      <div
        class="nodrag nopan flex items-center gap-1 rounded-xl bg-card/95 p-1.5 shadow-lg backdrop-blur"
        data-node-slot="composer"
      >
        <NodeSlot :parts="parts.composer" />
        <ActionBar :actions="actions.composer" />
      </div>
    </NodeToolbar>

    <NodeToolbar
      v-if="parts.side.length > 0"
      :node-id="id"
      :is-visible="sideVisible"
      :position="Position.Right"
      align="start"
      :offset="OUTER_OFFSET"
    >
      <div
        class="nodrag nopan nowheel rounded-xl border bg-card/95 p-2 shadow-lg backdrop-blur"
        data-node-slot="side"
      >
        <NodeSlot :parts="parts.side" />
      </div>
    </NodeToolbar>
  </div>
</template>
