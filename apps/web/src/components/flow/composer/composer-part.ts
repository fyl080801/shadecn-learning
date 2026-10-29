import { defineComponent, h, markRaw } from "vue"

import { defineNodePart, ORDER_TYPE, type NodePartContext, type NodePartDef } from "@/components/flow/node-kit/protocol"

import PromptComposer from "./PromptComposer.vue"

/**
 * 给某个类型登记一个底部输入框部件（`composer` 区）：外壳是 `PromptComposer`，写 `data.prompt`。
 *
 * 部件不收 props（REQ-NODEKIT §4.3），可每个类型的占位文案不一样 —— 所以这里为每次登记包一个
 * 不收 props 的小组件，把文案闭包进去。这是普通的组件复用，不是通用能力：哪个类型有输入框、
 * 什么时候收起，仍然写在那个类型自己的声明里（`node-types.ts` 的 `parts`）。
 */
export interface PromptComposerPartOptions {
  /** 部件 id，约定 `<type>.composer` */
  id: string
  placeholder: string
  /** 什么时候出现（在宿主露出规则之上再收窄）；不给就一直有 */
  when?: (ctx: NodePartContext) => boolean
}

export function definePromptComposerPart(options: PromptComposerPartOptions): NodePartDef {
  const component = markRaw(
    defineComponent({
      name: "NodePromptComposer",
      setup: () => () => h(PromptComposer, { field: "prompt", placeholder: options.placeholder })
    })
  )
  return defineNodePart({
    id: options.id,
    slot: "composer",
    order: ORDER_TYPE,
    component,
    ...(options.when ? { when: options.when } : {})
  })
}
