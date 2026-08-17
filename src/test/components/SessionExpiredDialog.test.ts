import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import SessionExpiredDialog from "@/components/SessionExpiredDialog.vue"
import {
  EMBEDDED_LOGIN_MESSAGE,
  dismissReLogin,
  requestReLogin
} from "@/lib/auth"

/**
 * 会话过期的全局提示：401 之后不能一声不响地把人跳走。
 * 第一层给两条路 —— 退出（整页回登录页，带上 return url）、重新登录（模态里就地登）；
 * 两层都能直接关掉，关掉就什么都不做，页面留在原处。
 */

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

let assign: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

const meResponse = (authenticated: boolean) =>
  new Response(
    JSON.stringify({
      enabled: true,
      authenticated,
      user: authenticated
        ? {
            id: "u1",
            subject: "s1",
            username: "alice",
            email: null,
            name: "Alice",
            avatarUrl: null,
            roles: []
          }
        : null,
      expiresAt: null
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )

/** 对话框走 teleport，内容在 body 上，wrapper 里找不到 */
function dialogButton(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === text
  )
}

function loginFrame() {
  return document.body.querySelector("iframe")
}

beforeEach(() => {
  document.body.innerHTML = ""
  dismissReLogin()

  fetchMock = vi.fn(() => Promise.resolve(meResponse(false)))
  vi.stubGlobal("fetch", fetchMock)

  assign = vi.fn()
  vi.stubGlobal("location", {
    assign,
    replace: vi.fn(),
    origin: "http://localhost:3000",
    pathname: "/2048",
    search: "?a=1",
    href: "http://localhost:3000/2048?a=1"
  })
})

async function openDialog() {
  const wrapper = mount(SessionExpiredDialog, { attachTo: document.body })
  requestReLogin("/2048?a=1")
  await flushPromises()
  return wrapper
}

/** 内嵌登录页登完之后，服务端那张落地页发回来的消息 */
function postLoginDone(origin = "http://localhost:3000") {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      data: { source: "app-auth", type: EMBEDDED_LOGIN_MESSAGE }
    })
  )
}

describe("SessionExpiredDialog", () => {
  it("没过期时不渲染任何东西", async () => {
    mount(SessionExpiredDialog, { attachTo: document.body })
    await flushPromises()

    expect(document.body.textContent).not.toContain("登录状态已失效")
  })

  it("会话过期后弹出来，退出和重新登录都在", async () => {
    await openDialog()

    expect(document.body.textContent).toContain("登录状态已失效")
    expect(dialogButton("退出")).toBeTruthy()
    expect(dialogButton("重新登录")).toBeTruthy()
  })

  it("点「退出」整页跳登出，return url 是会话过期时那个地址", async () => {
    await openDialog()

    dialogButton("退出")?.click()
    await flushPromises()

    expect(assign).toHaveBeenCalledWith(
      `/api/auth/logout?redirect=${encodeURIComponent("/2048?a=1")}`
    )
  })

  it("点「重新登录」开模态窗，里面是登录页的 iframe，页面不跳走", async () => {
    await openDialog()

    dialogButton("重新登录")?.click()
    await flushPromises()

    expect(loginFrame()?.getAttribute("src")).toBe(
      `/api/auth/login?redirect=${encodeURIComponent("/auth/embedded-done")}`
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it("模态里登录成功 → 自动关掉，人留在原页", async () => {
    await openDialog()
    dialogButton("重新登录")?.click()
    await flushPromises()

    fetchMock.mockResolvedValue(meResponse(true))
    postLoginDone()
    await flushPromises()

    expect(loginFrame()).toBeNull()
    expect(document.body.textContent).not.toContain("登录状态已失效")
    expect(assign).not.toHaveBeenCalled()
  })

  it("登录没成功（还是匿名）→ 模态继续开着", async () => {
    await openDialog()
    dialogButton("重新登录")?.click()
    await flushPromises()

    postLoginDone()
    await flushPromises()

    expect(loginFrame()).toBeTruthy()
  })

  it("别的站点发来的同名消息不算数", async () => {
    await openDialog()
    dialogButton("重新登录")?.click()
    await flushPromises()

    fetchMock.mockResolvedValue(meResponse(true))
    postLoginDone("https://evil.example.com")
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(loginFrame()).toBeTruthy()
  })

  it("关掉模态什么都不做：不跳转，提示也一起收起来", async () => {
    const wrapper = await openDialog()
    dialogButton("重新登录")?.click()
    await flushPromises()

    // 右上角的 ×
    const close = document.body.querySelector<HTMLElement>(
      '[data-slot="dialog-close"]'
    )
    close?.click()
    await flushPromises()

    expect(assign).not.toHaveBeenCalled()
    expect(loginFrame()).toBeNull()
    expect(document.body.textContent).not.toContain("登录状态已失效")
    wrapper.unmount()
  })
})
