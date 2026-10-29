import { defineNodeFeature, defineNodeHandler, defineNodeMode } from "../protocol"

/**
 * 就地编辑正文：双击节点本体进入 `edit-body` 模式，body 组件看 `ctx.mode.current` 决定画编辑器还是正文。
 *
 * 能力只管「双击 → 进模式」，不知道正文是什么、怎么编辑 —— 那是 body 的事（`TextBody.vue`），
 * 所以同一个能力能给任何「双击就地改内容」的类型用。
 */
export const EDIT_BODY_MODE = "edit-body"

/**
 * 正在就地改正文：收起底部输入框 —— 写正文和写提示词是两件事，正文编辑器上下各挂一块输入区只会互相挡着。
 * 退出模式（失焦 / Esc / 被顶掉）后按原规则再出现。
 */
const editBodyMode = defineNodeMode({ id: EDIT_BODY_MODE, conceal: ["composer"] })

export const editBodyFeature = defineNodeFeature({
  id: "edit-body",
  modes: [editBodyMode],
  handlers: [
    defineNodeHandler({
      event: "node:dblclick",
      handle: ({ event }, ctx) => {
        // 双击已经被这里接住了，不再冒泡到画布（Vue Flow 的节点双击 / 画布缩放）
        event.stopPropagation()
        // 双击在节点内部发生，选中态本来就会切过来；但从 teleport 出去的入口进来时不会，显式切一次
        ctx.editor.canvas.selectOnly(ctx.id)
        ctx.mode.enter(EDIT_BODY_MODE)
      }
    })
  ]
})
