import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { fromYNode, nodeData, nodesMap, toYNode } from "@shadecn/shared/flow-doc"
import { defaultNodeData } from "@shadecn/shared/flow-graph"

/**
 * `@shadecn/shared` 里的 Y.Doc 读写和前端自己 import 的必须是**同一份 yjs**。
 *
 * shared 通篇靠 `instanceof Y.Map` 判断结构；两份副本之间的 `instanceof` 永远为 false，
 * 画布会静默读成一张空图。生产构建靠 `resolve.dedupe`（vite.config.ts）收成一份，
 * 这里在测试的模块图里钉住同一件事。
 */
describe("shared 与前端共用一份 yjs", () => {
  it("shared 造的 Y.Map 是前端这份 yjs 的实例", () => {
    const made = toYNode({
      id: "n1",
      type: "text",
      position: { x: 0, y: 0 },
      data: defaultNodeData("节点")
    })
    expect(made).toBeInstanceOf(Y.Map)
  })

  it("前端这份 yjs 建的节点，shared 读得出来", () => {
    const doc = new Y.Doc()
    const source = new Y.Map<unknown>()
    const data = new Y.Map<unknown>()
    nodesMap(doc).set("n1", source)
    source.set("position", { x: 1, y: 2 })
    source.set("data", data)
    data.set("label", "前端建的")

    expect(nodeData(doc, "n1")).toBe(data)
    expect(fromYNode("n1", source)?.data.label).toBe("前端建的")
  })
})
