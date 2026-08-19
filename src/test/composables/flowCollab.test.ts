import { describe, expect, it } from "vitest"
import { classifyClose } from "@/composables/flow/useFlowCollab"

/**
 * 「这次关闭是终局的吗、是哪一种」的识别。
 *
 * 认错的代价不对称，两个方向都很疼：
 * - 漏认 → provider 无限重连，界面一直说「恢复连接后自动同步」，而用户接着画的东西
 *   只进得了本地 IndexedDB，永远发不出去；被顶下线的那种还会反过来把用户真正在用的窗口踢掉。
 * - 错认 → 本来能自动恢复的普通断线被判死刑，弹一个关不掉的框。
 *
 * 服务端用两条腿送信号（`server/collab/close.ts`）：CLOSE 消息只带 reason
 * （code 被 provider 填成 1000），关闭帧才带真正的 4xxx —— 所以两种形状都得认得出。
 */
describe("协同连接的终局关闭", () => {
  it("被别处的新窗口顶下线：关闭帧的 4409 和 CLOSE 消息的 reason 都认得出", () => {
    expect(classifyClose({ code: 4409, reason: "session-superseded" })).toBe("superseded")
    expect(classifyClose({ code: 1000, reason: "session-superseded" })).toBe("superseded")
  })

  it("登录态没了：Hocuspocus 内置的 4401 / Unauthorized", () => {
    expect(classifyClose({ code: 4401, reason: "Unauthorized" })).toBe("unauthorized")
    expect(classifyClose({ code: 1000, reason: "Unauthorized" })).toBe("unauthorized")
  })

  it("被移出项目：复验踢人用的 4403 / permission-revoked", () => {
    expect(classifyClose({ code: 4403, reason: "permission-revoked" })).toBe("forbidden")
    expect(classifyClose({ code: 1000, reason: "permission-revoked" })).toBe("forbidden")
  })

  it("握手被拒那条路只有 reason，没有 code —— 一样要认得出", () => {
    // `onConnect` 抛异常时 Hocuspocus 既不关 socket 也不给关闭码，
    // 只回一条 PermissionDenied 消息，provider 交给 onAuthenticationFailed({ reason })
    expect(classifyClose({ reason: "Unauthorized" })).toBe("unauthorized")
    expect(classifyClose({ reason: "permission-revoked" })).toBe("forbidden")
  })

  it("三种原因互不混淆 —— 出路不同，混了就给错指引", () => {
    expect(classifyClose({ code: 4409, reason: "session-superseded" })).not.toBe("unauthorized")
    expect(classifyClose({ code: 4403, reason: "permission-revoked" })).not.toBe("superseded")
  })

  it("普通断线（掉网、服务端重启、provider 自己的 4408）不算 —— 那是要自动重连的", () => {
    expect(classifyClose({ code: 1006, reason: "" })).toBeNull()
    expect(classifyClose({ code: 1000, reason: "" })).toBeNull()
    expect(classifyClose({ code: 4408, reason: "forced" })).toBeNull()
    expect(classifyClose(undefined)).toBeNull()
  })
})
