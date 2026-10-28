import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { ApiError } from "@/lib/api"
import { createSoloTransport } from "@/composables/flow/sync/solo"
import { nodesMap } from "@/lib/flow-doc"
import type { FatalClose } from "@/composables/flow/sync/types"

/**
 * 个人画布的传输层（REQ-SOLO）。
 *
 * 协同那边由 CRDT 连接层白送的几件事，这里得自己保证：推的是相对**服务端**基线的
 * 差量、离线攒下的东西不会丢、服务端明确拒绝时不要无谓重试。
 */

const pullDoc = vi.fn()
const pushDoc = vi.fn()

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return { ...actual, flowApi: { pullDoc: (...a: unknown[]) => pullDoc(...a), pushDoc: (...a: unknown[]) => pushDoc(...a) } }
})

/** 造一个「服务端」文档，返回它的全量更新和状态向量 */
function serverDoc(nodeIds: string[] = []) {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const id of nodeIds) nodesMap(doc).set(id, new Y.Map<unknown>())
  })
  const state = { update: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }
  doc.destroy()
  return state
}

function addNode(doc: Y.Doc, id: string) {
  doc.transact(() => nodesMap(doc).set(id, new Y.Map<unknown>()))
}

/** 等本地那些 `void push()` 跑完 —— 它们不在调用栈上 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function transportFor(doc: Y.Doc, onFatal = vi.fn()) {
  return { transport: createSoloTransport({ flowId: "flow-1", doc, onFatal }), onFatal }
}

describe("个人画布的传输层", () => {
  beforeEach(() => {
    pullDoc.mockReset()
    pushDoc.mockReset()
    pushDoc.mockResolvedValue({ stateVector: new Uint8Array([0]), revision: 1, noop: false })
  })

  it("先把服务端那份拉进文档，拉到了才算已同步", async () => {
    const remote = serverDoc(["n1"])
    pullDoc.mockResolvedValue(remote)

    const doc = new Y.Doc()
    const { transport } = transportFor(doc)
    await settle()

    expect([...nodesMap(doc).keys()]).toEqual(["n1"])
    expect(transport.synced.value).toBe(true)
    expect(transport.linked.value).toBe(true)
    // 只是拉，没有本地改动，一次都不该推
    expect(pushDoc).not.toHaveBeenCalled()
    transport.destroy()
  })

  it("本地一改就推，且推的是相对服务端基线的差量", async () => {
    const remote = serverDoc(["n1"])
    pullDoc.mockResolvedValue(remote)
    pushDoc.mockResolvedValue({
      stateVector: new Uint8Array(remote.stateVector),
      revision: 2,
      noop: false
    })

    const doc = new Y.Doc()
    const { transport } = transportFor(doc)
    await settle()

    addNode(doc, "n2")
    await settle()

    expect(pushDoc).toHaveBeenCalledTimes(1)
    // 差量里只该有新加的那个节点 —— 把它单独灌进一个空文档就看得出来
    const [, update] = pushDoc.mock.calls[0] as [string, Uint8Array]
    const probe = new Y.Doc()
    Y.applyUpdate(probe, update)
    expect([...nodesMap(probe).keys()]).toEqual(["n2"])
    probe.destroy()
    transport.destroy()
  })

  it("离线期间攒在本地的改动，一拉完就补推上去", async () => {
    // 服务端还是空的，本地（IndexedDB 灌进来的）已经有东西 —— 断网时画的
    pullDoc.mockResolvedValue(serverDoc([]))

    const doc = new Y.Doc()
    addNode(doc, "offline-node")

    const { transport } = transportFor(doc)
    await settle()

    /*
     * 这条是回归测试：基线一旦取成「合并之后的本地状态」，差量就会算成空，
     * 离线期间的改动从此再也推不出去 —— 而界面还显示「已保存」。
     */
    expect(pushDoc).toHaveBeenCalledTimes(1)
    const [, update] = pushDoc.mock.calls[0] as [string, Uint8Array]
    const probe = new Y.Doc()
    Y.applyUpdate(probe, update)
    expect([...nodesMap(probe).keys()]).toEqual(["offline-node"])
    probe.destroy()
    transport.destroy()
  })

  it("服务端明确拒绝 → 终局失败，各是各的原因", async () => {
    const cases: [number, FatalClose][] = [
      [413, "too-large"],
      [404, "forbidden"],
      [401, "unauthorized"]
    ]

    for (const [status, reason] of cases) {
      pullDoc.mockResolvedValue(serverDoc([]))
      pushDoc.mockRejectedValue(new ApiError("nope", status, null))

      const doc = new Y.Doc()
      const { transport, onFatal } = transportFor(doc)
      await settle()
      addNode(doc, "n1")
      await settle()

      expect(onFatal).toHaveBeenCalledWith(reason)
      transport.destroy()
      doc.destroy()
    }
  })

  it("网络出问题不算终局：保持未保存，等下一次机会", async () => {
    pullDoc.mockResolvedValue(serverDoc([]))
    pushDoc.mockRejectedValue(new TypeError("Failed to fetch"))

    const doc = new Y.Doc()
    const { transport, onFatal } = transportFor(doc)
    await settle()
    addNode(doc, "n1")
    await settle()

    expect(onFatal).not.toHaveBeenCalled()
    // 改动还欠着，界面据此显示「已离线，改动存在本地」
    expect(transport.pending.value).toBe(true)
    expect(transport.linked.value).toBe(false)
    transport.destroy()
  })

  it("拆掉之后再改也不会发请求", async () => {
    pullDoc.mockResolvedValue(serverDoc([]))

    const doc = new Y.Doc()
    const { transport } = transportFor(doc)
    await settle()
    transport.destroy()

    addNode(doc, "n1")
    await settle()

    expect(pushDoc).not.toHaveBeenCalled()
  })
})
