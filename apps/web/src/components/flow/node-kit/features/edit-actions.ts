import { Copy, Trash2 } from "@lucide/vue"

import { defineNodeAction, defineNodeFeature } from "../protocol"

/**
 * 节点工具条上的两个默认动作，各是一个能力 —— 不能复制的类型（分组）不启用 `duplicate`，
 * 删除另有说法的类型（分组的「解组」）不启用 `delete`，没有「替换」要写。
 */

/** 复制的是节点本身（类型、布局、名字、业务字段），连线不复制，见 `useFlowCanvas.duplicateNode` */
export const duplicateFeature = defineNodeFeature({
  id: "duplicate",
  actions: [
    defineNodeAction({
      id: "node.duplicate",
      slot: "toolbar",
      icon: Copy,
      label: "复制节点",
      shortcut: "Mod+D",
      run: (ctx) => ctx.editor.canvas.duplicateNode(ctx.id)
    })
  ]
})

export const deleteFeature = defineNodeFeature({
  id: "delete",
  actions: [
    defineNodeAction({
      id: "node.delete",
      slot: "toolbar",
      icon: Trash2,
      label: "删除节点",
      tone: "destructive",
      run: (ctx) => ctx.editor.canvas.deleteNode(ctx.id)
    })
  ]
})
