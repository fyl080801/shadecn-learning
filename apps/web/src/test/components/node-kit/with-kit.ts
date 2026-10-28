import { createNodeKitRuntime, NODE_KIT_KEY } from "@/components/flow/node-kit/context"
import { createDefaultNodeKit } from "@/components/flow/node-kit/install"

/**
 * 单独挂载节点组件时，把编辑器那份默认注册表 provide 进去（`mount(X, { global: nodeKitGlobal() })`）。
 * 名字、工具条按钮、连接点、运行态都是能力，不装注册表的话节点就只剩外壳。
 */
export function nodeKitGlobal() {
  const runtime = createNodeKitRuntime(createDefaultNodeKit())
  return { provide: { [NODE_KIT_KEY as symbol]: runtime } }
}
