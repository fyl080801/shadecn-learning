import { Ungroup } from "@lucide/vue"

import { defineNodeAction, defineNodeFeature, defineNodePart } from "../protocol"
import ArrangeMenu from "./ArrangeMenu.vue"
import DragStrip from "./DragStrip.vue"
import NodeResizerPart from "./NodeResizerPart.vue"

/**
 * 背景板式节点（眼下就是分组）用的三个能力，各自独立、可以单独启用。
 */

/**
 * 解组：拆掉分组框，组内节点保留（`store.removeElements` 会把它们的 parentNode 解掉、坐标换算回画布坐标）。
 * 所以既不用垃圾桶图标也不用 destructive 那身红 —— 那两样都在说「东西要没了」，
 * 而这一下什么都没丢，撤销一次还能原样回来。
 */
export const ungroupFeature = defineNodeFeature({
  id: "ungroup",
  actions: [
    defineNodeAction({
      id: "group.ungroup",
      slot: "toolbar",
      icon: Ungroup,
      label: "解组（拆掉分组框，组内节点保留）",
      shortcut: "Mod+Shift+G",
      run: (ctx) => ctx.editor.canvas.deleteNode(ctx.id)
    })
  ]
})

/** 拉伸：选中时出现八个手柄，松手才写一次文档 */
export const resizableFeature = defineNodeFeature({
  id: "resizable",
  parts: [defineNodePart({ id: "resizable.handles", slot: "overlay", component: NodeResizerPart })]
})

/** 顶部拖动把手：给整块不吃鼠标事件的节点留一条能拖的边 */
export const dragStripFeature = defineNodeFeature({
  id: "drag-strip",
  parts: [defineNodePart({ id: "drag-strip.handle", slot: "overlay", component: DragStrip })]
})

/** 组内排列：工具条最左边一枚「布局」下拉，横向 / 纵向 / 宫格重排组员（`ArrangeMenu.vue`） */
export const arrangeFeature = defineNodeFeature({
  id: "arrange",
  parts: [defineNodePart({ id: "arrange.menu", slot: "toolbar", component: ArrangeMenu })]
})
