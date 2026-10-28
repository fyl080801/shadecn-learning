import { ref } from "vue"
import type { NodePartContext } from "@/components/flow/node-kit/protocol"
import type { NodeKit } from "@/components/flow/node-kit/registry"

/**
 * 协议层的测试只关心上下文里的 `id` / `type` / `emit`：节点句柄和编辑器上下文用不到，给空壳。
 * `emit` 接到传进来的注册表上，和宿主将来的接法一样。
 */
export function fakeContext(kit: NodeKit, id: string, type: string): NodePartContext {
  const ctx: NodePartContext = {
    id,
    type,
    features: kit.featuresOf(type),
    node: {} as NodePartContext["node"],
    label: ref(""),
    editor: {} as NodePartContext["editor"],
    selected: ref(false),
    mode: {
      current: ref(null),
      enter: () => false,
      exit: () => undefined
    },
    slots: { open: () => undefined, close: () => undefined, isOpen: () => false },
    has: (feature) => kit.hasFeature(type, feature),
    emit: (event, payload) => kit.emit(event, payload, ctx)
  }
  return ctx
}
