import { defineNodeFeature, defineNodeMode, defineNodePart, ORDER_FRAMEWORK } from "../protocol"
import RenameTitle, { RENAME_MODE } from "./RenameTitle.vue"

/** 改名：框外左上角的名字 + 双击就地改名（一个编辑模式） */
export const renameFeature = defineNodeFeature({
  id: "rename",
  // 名字排在 label 区最前面，在场头像（宿主内置）和别的部件跟在它后面
  parts: [defineNodePart({ id: "rename.title", slot: "label", order: ORDER_FRAMEWORK, component: RenameTitle })],
  modes: [defineNodeMode({ id: RENAME_MODE })]
})
