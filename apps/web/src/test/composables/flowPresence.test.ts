import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, effectScope, shallowRef } from "vue"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { useFlowPresence } from "@/composables/flow/useFlowPresence"
import type { FlowSync } from "@/composables/flow/sync"
import { FEEDBACK_THROTTLE } from "@/lib/presence"

/**
 * 反馈层的发包量：每次 awareness `update` 都会被 provider 发成一个 WebSocket 包，
 * 所以这里数 `update` 事件就是在数包。
 */

let awareness: Awareness
let packets: number
let scope: ReturnType<typeof effectScope>
let presence: ReturnType<typeof useFlowPresence>

beforeEach(() => {
  vi.useFakeTimers()
  awareness = new Awareness(new Y.Doc())
  const sync = {
    connected: computed(() => true),
    session: shallowRef({ awareness, clientId: awareness.clientID })
  } as unknown as FlowSync
  scope = effectScope()
  presence = scope.run(() => useFlowPresence(sync)) as ReturnType<typeof useFlowPresence>
  packets = 0
  awareness.on("update", () => packets++)
})

afterEach(() => {
  scope.stop()
  awareness.destroy()
  vi.useRealTimers()
})

describe("在场上报节流", () => {
  it("一个 FEEDBACK_THROTTLE 窗口最多一包，且最后的位置一定送达", () => {
    for (let i = 0; i < 20; i++) {
      presence.setCursor({ x: i * 10, y: 0 })
      vi.advanceTimersByTime(FEEDBACK_THROTTLE / 10)
    }
    vi.advanceTimersByTime(FEEDBACK_THROTTLE)
    // 20 次移动跨了 2 个窗口：前沿 + 每窗尾巴，远少于 20
    expect(packets).toBeLessThanOrEqual(4)
    expect(awareness.getLocalState()?.cursor).toEqual({ x: 190, y: 0 })
  })

  it("拖动时光标和几何合成一包，而不是各发各的", () => {
    presence.setTransform({ "node:n1": { x: 1, y: 1 } })
    presence.setCursor({ x: 5, y: 5 })
    vi.advanceTimersByTime(FEEDBACK_THROTTLE)
    // 前沿一包 + 尾巴一包（带走了光标和几何的最新值）
    expect(packets).toBe(2)
    expect(awareness.getLocalState()).toMatchObject({
      cursor: { x: 5, y: 5 },
      transform: { "node:n1": { x: 1, y: 1 } }
    })
  })

  it("选中、拉线和光标同一窗口内一起变，也只发一包", () => {
    presence.setCursor({ x: 1, y: 1 })
    const afterLeading = packets
    presence.setSelection(["node:n1"])
    presence.setConnecting({ from: { x: 0, y: 0 }, nodeId: "n1" })
    presence.setCursor({ x: 2, y: 2 })
    vi.advanceTimersByTime(FEEDBACK_THROTTLE)
    expect(packets - afterLeading).toBe(1)
    expect(awareness.getLocalState()).toMatchObject({
      cursor: { x: 2, y: 2 },
      selection: ["node:n1"],
      connecting: { from: { x: 0, y: 0 }, nodeId: "n1" }
    })
  })

  it("取整后没变的位置不发包", () => {
    presence.setCursor({ x: 10, y: 10 })
    vi.advanceTimersByTime(FEEDBACK_THROTTLE * 2)
    const before = packets
    presence.setCursor({ x: 10.2, y: 9.8 })
    vi.advanceTimersByTime(FEEDBACK_THROTTLE * 2)
    expect(packets).toBe(before)
  })

  it("松手立刻发清空，节流尾巴不会把旧几何补发回去", () => {
    presence.setTransform({ "node:n1": { x: 1, y: 1 } })
    presence.setTransform({ "node:n1": { x: 2, y: 2 } })
    presence.clearTransform()
    expect(awareness.getLocalState()?.transform).toEqual({})
    vi.advanceTimersByTime(FEEDBACK_THROTTLE * 2)
    expect(awareness.getLocalState()?.transform).toEqual({})
  })
})
