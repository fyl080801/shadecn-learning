import { describe, expect, it } from "vitest"
import { classifyClose, parseStoreState } from "@/composables/flow/sync"
import { syncTextOf, syncWarningOf } from "@/composables/flow/sync-text"

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

  it("画布顶到内容硬限：4413 / quota-exceeded，和个人画布的 413 归成同一种", () => {
    // 这一种跟人无关 —— 房间里每个人都会收到，出路是删内容再刷新，不是重连
    expect(classifyClose({ code: 4413, reason: "quota-exceeded" })).toBe("too-large")
    expect(classifyClose({ code: 1000, reason: "quota-exceeded" })).toBe("too-large")
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


/**
 * 服务端的落库状态广播（docs/19 §4.4）。
 *
 * 它补的是「同步」和「保存」之间那个缺口：内容进了服务端内存、也广播给了同房间的人，
 * 连接层面毫无异常，但字节可能只是悬在那儿。没有这条消息，界面会一直写着「已同步」。
 */
describe("落库状态的 stateless 消息", () => {
  it("认得出服务端说的存不进去 / 又能存了", () => {
    expect(parseStoreState(JSON.stringify({ type: "flow:store-state", ok: false }))).toBe(false)
    expect(parseStoreState(JSON.stringify({ type: "flow:store-state", ok: true }))).toBe(true)
  })

  /**
   * stateless 是个通用旁路通道，将来可能驮别的东西。读不懂的一律返回 null
   * （调用方据此原样不动），**绝不能抛** —— 那会打断整条连接的消息处理。
   */
  it.each([
    ["不是 JSON", "这不是 json"],
    ["空字符串", ""],
    ["JSON 但不是对象", '"字符串"'],
    ["null", "null"],
    ["别的消息类型", JSON.stringify({ type: "flow:something-else", ok: false })],
    ["缺 ok 字段", JSON.stringify({ type: "flow:store-state" })],
    ["ok 不是布尔", JSON.stringify({ type: "flow:store-state", ok: "false" })],
  ])("%s → null，而且不抛", (_name, payload) => {
    expect(() => parseStoreState(payload)).not.toThrow()
    expect(parseStoreState(payload)).toBeNull()
  })
})


/**
 * 画布上那行小字（`syncTextOf`）—— 状态和**说法**的对应关系。
 *
 * 这行字是很多容灾状态唯一能被用户看见的地方，所以每一句都在承诺具体的事：
 * 「改动存在本地」承诺刷新不丢，「已同步」承诺服务器收到了。
 * 承诺错了比不说更糟 —— 用户会照着那句话决定要不要关页面。
 */
describe("同步状态的文案", () => {
  const base = {
    fatal: null,
    mode: "collab" as const,
    connected: true,
    synced: true,
    pending: false,
    saveFailed: false,
    cacheFailed: false
  }

  it("一切正常：项目画布说「已同步」，个人画布说「已保存」", () => {
    expect(syncTextOf(base)).toBe("已同步")
    expect(syncTextOf({ ...base, mode: "solo" })).toBe("已保存")
  })

  /** 两种画布的说法不能混：跟个人画布的用户说「协作会话」，他会去找不存在的协作者 */
  it.each([
    ["superseded", "协作会话已过期，请刷新页面"],
    ["unauthorized", "登录态已过期，请重新登录"],
    ["forbidden", "已失去访问权限，改动不再同步"],
    ["too-large", "画布太大，最近的改动没能保存"]
  ] as const)("终局失败 %s 有自己的说法，且优先于其它一切", (fatal, text) => {
    // 连断线都盖不过它 —— 那些原因不会自己好，说「恢复连接后自动同步」就是骗人
    expect(syncTextOf({ ...base, fatal, connected: false })).toBe(text)
  })

  /**
   * 服务端收到了但存不进库。连接好好的、内容也同步给了同房间的人 ——
   * 这时候显示「已同步」是在骗人，字节只悬在服务器内存里。
   */
  it("服务器存不进库时不能再说「已同步」", () => {
    const text = syncTextOf({ ...base, saveFailed: true })
    expect(text).not.toBe("已同步")
    expect(text).toContain("无法保存")
  })

  it("断线时说改动存在本地 —— 因为确实存进了 IndexedDB", () => {
    expect(syncTextOf({ ...base, connected: false })).toContain("改动存在本地")
    expect(syncTextOf({ ...base, mode: "solo", connected: false })).toContain("改动存在本地")
  })

  /**
   * 无痕模式、禁用 IndexedDB、配额写满 —— 那一层根本没建起来。
   * 还说「存在本地」的代价是：用户安心继续画，然后刷新一次全没。
   */
  it("本地缓存不可用时，断线的说法必须改口", () => {
    for (const mode of ["collab", "solo"] as const) {
      const text = syncTextOf({ ...base, mode, connected: false, cacheFailed: true })
      expect(text).not.toContain("改动存在本地")
      expect(text).toContain("刷新会丢失")
    }
  })

  /** 在线时本地缓存用不上也没影响，内容照样同步出去了 —— 不必占着状态栏制造焦虑 */
  it("在线时本地缓存不可用不改变文案（进场已 toast 过一次）", () => {
    expect(syncTextOf({ ...base, cacheFailed: true })).toBe("已同步")
  })

  it("警告色覆盖每一种「有事发生」，正常时不亮", () => {
    expect(syncWarningOf(base)).toBe(false)
    expect(syncWarningOf({ ...base, connected: false })).toBe(true)
    expect(syncWarningOf({ ...base, fatal: "forbidden" })).toBe(true)
    expect(syncWarningOf({ ...base, saveFailed: true })).toBe(true)
    expect(syncWarningOf({ ...base, cacheFailed: true })).toBe(true)
  })
})
