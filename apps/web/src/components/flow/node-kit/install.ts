import { FLOW_NODE_TYPES } from "@/components/flow/node-types"

import { deleteFeature, duplicateFeature } from "./features/edit-actions"
import { connectableFeature, statusFeature } from "./features/display"
import { editBodyFeature } from "./features/edit-body"
import { dragStripFeature, resizableFeature, ungroupFeature } from "./features/frame"
import { outputPreviewFeature } from "./features/output-preview"
import { renameFeature } from "./features/rename"
import { runnableFeature } from "./features/runnable"
import { createNodeKit, type NodeKit } from "./registry"

/**
 * 编辑器用的那份注册表 —— **唯一一个列出全部能力的地方**（REQ-NODEKIT §3）。
 *
 * 顺序：先登记能力，再登记类型（类型按名字引用能力，引了没登记的会立即报错），最后 `assertValid()`
 * 检查 `replaces` / `hides` 点名的条目都在。能力之间互不 import，组合只发生在这里和类型声明里。
 *
 * 类型来自 `node-types.ts` 的注册表（各自的 `features`）。这个文件只被编辑器根（`provideFlowEditor`）引，
 * 节点组件、部件组件都不引它 —— 它引的东西里有节点组件，反过来引就成环了。
 */
const FEATURES = [
  renameFeature,
  duplicateFeature,
  deleteFeature,
  connectableFeature,
  statusFeature,
  editBodyFeature,
  ungroupFeature,
  resizableFeature,
  dragStripFeature,
  outputPreviewFeature,
  runnableFeature
]

export function createDefaultNodeKit(): NodeKit {
  const kit = createNodeKit()
  for (const feature of FEATURES) kit.registerFeature(feature)
  for (const def of Object.values(FLOW_NODE_TYPES)) {
    kit.registerType({ type: def.type, features: def.features, view: def.view, parts: def.parts, modes: def.modes })
  }
  kit.assertValid()
  return kit
}
