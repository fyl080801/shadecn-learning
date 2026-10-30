import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, ref } from "vue"
import type { FlowMode } from "@shadecn/shared/canvas"
import type { FlowTransport, TransportContext } from "@/composables/flow/sync/types"

/**
 * 同步层什么时候挂传输、挂哪一种（docs/16：个人画布也走 WebSocket）。
 *
 * 守的是「看着正常、其实没连上」的那几条：个人画布打开后没挂传输（agent 改了什么这边看不见）、
 * 元信息还没回来就抢着连（进不去的画布会同时冒两种报错）、换了画布还连着上一张的房间。
 *
 * 传输换成假的 —— 要测的是 `useFlowSync` 怎么挂、怎么换，不是 Hocuspocus 本身。
 */

interface FakeTransport extends FlowTransport {
  context: TransportContext
}

const created: FakeTransport[] = []

vi.mock("@/composables/flow/sync/collab", () => ({
  createCollabTransport: (context: TransportContext) => {
    const transport: FakeTransport = {
      context,
      synced: ref(false),
      linked: ref(true),
      saveFailed: ref(false),
      awareness: { clientID: 42 } as never,
      destroy: vi.fn()
    }
    created.push(transport)
    return transport
  },
  classifyClose: () => null,
  parseStoreState: () => null
}))
// jsdom 没有 IndexedDB；缓存这一层和本测试无关
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.resolve()
    destroy() {
      return Promise.resolve()
    }
  }
}))

type UseFlowSync = typeof import("@/composables/flow/sync").useFlowSync
let useFlowSync: UseFlowSync

beforeEach(async () => {
  created.length = 0
  // 同步层在测试环境里默认不连任何东西（CAN_CONNECT），这里要它真的挂传输
  vi.stubEnv("MODE", "development")
  vi.resetModules()
  useFlowSync = (await import("@/composables/flow/sync")).useFlowSync
})

function setup(initial: FlowMode | null) {
  const flowId = ref("f1")
  const mode = ref<FlowMode | null>(initial)
  let sync!: ReturnType<UseFlowSync>
  mount(
    defineComponent({
      setup() {
        sync = useFlowSync(flowId, mode)
        return () => null
      }
    })
  )
  return { flowId, mode, sync }
}

const last = () => created[created.length - 1]!

describe("同步层的传输", () => {
  it("个人画布打开即挂协同传输，awareness 交给 session", async () => {
    const { sync } = setup("solo")
    await flushPromises()

    expect(created).toHaveLength(1)
    expect(last().context.flowId).toBe("f1")
    expect(last().context.doc).toBe(sync.session.value!.doc)
    expect(sync.session.value!.awareness).toBe(last().awareness)
  })

  it("synced / linked / saveFailed 镜像当前传输报的状态", async () => {
    const { sync } = setup("solo")
    await flushPromises()
    expect(sync.session.value!.synced.value).toBe(false)

    last().synced.value = true
    last().saveFailed.value = true
    await flushPromises()
    expect(sync.session.value!.synced.value).toBe(true)
    expect(sync.saveFailed.value).toBe(true)
    expect(sync.connected.value).toBe(true)
  })

  it("元信息没回来之前只建文档、不连；回来了才挂传输", async () => {
    const { sync, mode } = setup(null)
    await flushPromises()
    expect(sync.session.value).not.toBeNull()
    expect(created).toHaveLength(0)

    mode.value = "solo"
    await flushPromises()
    expect(created).toHaveLength(1)
  })

  it("换一张画布 → 拆掉旧房间的传输，元信息到了再连新房间", async () => {
    const { flowId, mode } = setup("collab")
    await flushPromises()
    const first = last()

    flowId.value = "f2"
    mode.value = null
    await flushPromises()
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)

    mode.value = "solo"
    await flushPromises()
    expect(created).toHaveLength(2)
    expect(last().context.flowId).toBe("f2")
  })

  it("终局失败记在 fatal 上；主动离开（删除自己的画布）时不记", async () => {
    const { sync } = setup("solo")
    await flushPromises()

    sync.leave()
    last().context.onFatal("forbidden")
    expect(sync.fatal.value).toBeNull()

    sync.stay()
    last().context.onFatal("superseded")
    expect(sync.fatal.value).toBe("superseded")
  })

  it("stateless 消息按 type 分发给订阅方；读不懂的、出错的订阅方都不会抛回连接里；换传输后订阅还在", async () => {
    const { sync, mode } = setup("collab")
    await flushPromises()
    const runs = vi.fn()
    const other = vi.fn()
    const broken = vi.fn(() => {
      throw new Error("订阅方自己坏了")
    })
    sync.onStateless("agent:runs", broken)
    sync.onStateless("agent:runs", runs)
    const stop = sync.onStateless("something-else", other)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const payload = JSON.stringify({ type: "agent:runs", flowId: "f1", runs: [] })
    expect(() => last().context.onStateless(payload)).not.toThrow()
    expect(runs).toHaveBeenCalledWith(payload)
    expect(other).not.toHaveBeenCalled()

    expect(() => last().context.onStateless("{坏的")).not.toThrow()
    expect(() => last().context.onStateless(JSON.stringify([1, 2]))).not.toThrow()
    expect(runs).toHaveBeenCalledTimes(1)

    stop()
    last().context.onStateless(JSON.stringify({ type: "something-else" }))
    expect(other).not.toHaveBeenCalled()

    // 元信息丢了又回来 = 重建传输：订阅表跟着 useFlowSync，不跟传输
    mode.value = null
    await flushPromises()
    mode.value = "collab"
    await flushPromises()
    last().context.onStateless(payload)
    expect(runs).toHaveBeenCalledTimes(2)
  })
})
