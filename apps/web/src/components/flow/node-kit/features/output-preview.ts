import { PanelRightClose, PanelRightOpen } from "@lucide/vue"

import { defineNodeAction, defineNodeFeature, defineNodePart } from "../protocol"
import OutputList from "./OutputList.vue"
import OutputSidePreview from "./OutputSidePreview.vue"
import { hasImageOutput } from "./outputs"

/**
 * 产出预览：footer 区列出各输出端口的产出（有产出才挂），框外右侧可以展开大图。
 *
 * 展开 / 收起是两个动作、各按条件出现，而不是一个会变名字的按钮 —— 动作是数据（图标、名字固定），
 * 「此刻该出现哪个」交给 `when`。侧边区域开没开是宿主管的本地 UI 状态（`ctx.slots`）。
 */
export const outputPreviewFeature = defineNodeFeature({
  id: "output-preview",
  parts: [
    defineNodePart({
      id: "output-preview.list",
      slot: "footer",
      component: OutputList,
      when: (ctx) => Object.keys(ctx.node.runtime.value.outputs ?? {}).length > 0
    }),
    defineNodePart({ id: "output-preview.side", slot: "side", component: OutputSidePreview })
  ],
  actions: [
    defineNodeAction({
      id: "output-preview.open",
      slot: "toolbar",
      icon: PanelRightOpen,
      label: "展开预览",
      when: (ctx) => hasImageOutput(ctx) && !ctx.slots.isOpen("side"),
      run: (ctx) => ctx.slots.open("side")
    }),
    defineNodeAction({
      id: "output-preview.close",
      slot: "toolbar",
      icon: PanelRightClose,
      label: "收起预览",
      when: (ctx) => ctx.slots.isOpen("side"),
      run: (ctx) => ctx.slots.close("side")
    })
  ]
})
