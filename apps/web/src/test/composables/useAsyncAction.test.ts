import { describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

import { useAsyncAction } from "@/composables/useAsyncAction"

const toastError = vi.fn()
vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args), info: vi.fn() }
}))

/**
 * 防连点的守卫。
 *
 * 这里守的是「请求发出去、response 还没回来」这段窗口：
 * 界面上的 :disabled 要等下一次渲染才生效，同一轮事件循环里的第二次点击照样进得来，
 * 所以锁必须在 run() 里同步上，而不是靠模板。
 */

/** 一个能手动决定什么时候完成的 promise */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useAsyncAction 防重复提交", () => {
  it("请求还没回来时再点 → 直接丢掉，动作只跑一次", async () => {
    const gate = deferred()
    const action = vi.fn(() => gate.promise)
    const { run } = useAsyncAction(action)

    // 同一轮里连点三次，中间没有任何 await
    void run()
    void run()
    void run()

    expect(action).toHaveBeenCalledTimes(1)

    gate.resolve()
    await nextTick()
  })

  it("pending 是同步翻上去的，不用等 response", () => {
    const gate = deferred()
    const { run, pending } = useAsyncAction(() => gate.promise)

    expect(pending.value).toBe(false)
    void run()
    // 没 await 任何东西，界面这时就该看到「进行中」
    expect(pending.value).toBe(true)

    gate.resolve()
  })

  it("跑完就解锁，下一次点击照常发出去", async () => {
    const action = vi.fn(async () => "ok")
    const { run, pending } = useAsyncAction(action)

    expect(await run()).toBe("ok")
    expect(pending.value).toBe(false)

    await run()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it("失败也解锁，并且 run 自己不会 reject", async () => {
    const action = vi.fn(async () => {
      throw new Error("创建失败：名称重复")
    })
    const { run, pending } = useAsyncAction(action, { errorMessage: "创建失败" })

    // 没有 .catch()：run 要是往外抛，这里就成了未处理的 rejection
    expect(await run()).toBeUndefined()
    expect(pending.value).toBe(false)
    expect(toastError).toHaveBeenCalledWith("创建失败：名称重复")

    await run()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it("给了 onError 就不再弹 toast", async () => {
    toastError.mockClear()
    const onError = vi.fn()
    const { run } = useAsyncAction(
      async () => {
        throw new Error("boom")
      },
      { onError }
    )

    await run()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("带 key 时按行分别上锁 —— 删 A 行不影响 B 行", async () => {
    const rowA = deferred()
    const rowB = deferred()
    const action = vi.fn((id: string) => (id === "a" ? rowA.promise : rowB.promise))
    const { run, isPending } = useAsyncAction(action, { key: (id) => id })

    void run("a")
    void run("a") // 同一行的重复点击丢掉
    void run("b") // 另一行照常发

    expect(action).toHaveBeenCalledTimes(2)
    expect(isPending("a")).toBe(true)
    expect(isPending("b")).toBe(true)

    rowA.resolve()
    await nextTick()
    expect(isPending("a")).toBe(false)
    expect(isPending("b")).toBe(true)

    rowB.resolve()
    await nextTick()
  })

  it("同步动作也吃这一套：跑完立刻解锁", async () => {
    const action = vi.fn(() => 42)
    const { run, pending } = useAsyncAction(action)

    const result = run()
    expect(pending.value).toBe(true)
    expect(await result).toBe(42)
    expect(pending.value).toBe(false)
  })
})
