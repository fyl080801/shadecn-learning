import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter, type Router } from "vue-router"

import AppSidebar from "@/components/AppSidebar.vue"
import { fetchSession } from "@/lib/auth"

/**
 * 侧栏底部用户菜单的两件事：
 *   - 「关于」是模态窗，不是路由 —— 点完地址栏不变，人还在原来那页；
 *   - 「退出登录」先问一句，确认之后才整页跳去登出。退出是不可撤销的整页跳转，
 *     误点一下就得重新走一遍 Keycloak。
 */

let assign: ReturnType<typeof vi.fn>
let router: Router

const ME = {
  enabled: true,
  authenticated: true,
  user: {
    id: "u1",
    subject: "s1",
    username: "alice",
    email: "alice@example.com",
    name: "Alice",
    avatarUrl: null,
    roles: []
  },
  expiresAt: null
}

/** jsdom 没有 PointerEvent / pointer capture，reka-ui 的菜单开合要用到 */
function stubPointerApis() {
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
}

async function mountSidebar() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/settings", component: { template: "<div />" } },
      { path: "/:rest(.*)", component: { template: "<div />" } }
    ]
  })
  await router.push("/2048")
  await router.isReady()

  const wrapper = mount(AppSidebar, {
    global: { plugins: [router] },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

/** 打开底部用户菜单，点其中一项 */
async function pickMenuItem(text: string) {
  const trigger = document.querySelector(
    "[data-slot=dropdown-menu-trigger]"
  ) as HTMLElement
  trigger.click()
  await flushPromises()

  const item = [...document.querySelectorAll("[data-slot=dropdown-menu-item]")].find(
    (el) => el.textContent?.trim() === text
  ) as HTMLElement
  item.click()
  await flushPromises()
}

/** 对话框走 teleport，内容挂在 body 上，wrapper 里找不到 */
function confirmButton(text: string) {
  return [...document.querySelectorAll("[data-slot=alert-dialog-content] button")].find(
    (el) => el.textContent?.trim() === text
  ) as HTMLElement | undefined
}

beforeEach(async () => {
  stubPointerApis()
  document.body.innerHTML = ""

  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(ME), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    )
  )
  // 登录态是模块级单例，强制重新拉一次，免得沿用上一个用例的
  await fetchSession(true)

  assign = vi.fn()
  vi.stubGlobal("location", {
    assign,
    replace: vi.fn(),
    origin: "http://localhost:3000",
    pathname: "/2048",
    search: "",
    href: "http://localhost:3000/2048"
  })
})

describe("侧栏用户菜单", () => {
  it("点「关于」弹模态窗，不跳路由", async () => {
    await mountSidebar()

    await pickMenuItem("关于")

    expect(document.querySelector("[data-slot=dialog-content]")?.textContent).toContain(
      "关于"
    )
    expect(router.currentRoute.value.fullPath).toBe("/2048")
  })

  it("点「退出登录」先出确认框，这一步不跳转", async () => {
    await mountSidebar()

    await pickMenuItem("退出登录")

    expect(document.body.textContent).toContain("退出登录？")
    expect(assign).not.toHaveBeenCalled()
  })

  it("确认框点「取消」→ 什么都不发生", async () => {
    await mountSidebar()
    await pickMenuItem("退出登录")

    confirmButton("取消")?.click()
    await flushPromises()

    expect(assign).not.toHaveBeenCalled()
  })

  it("确认框点「退出」→ 整页跳登出，带当前地址回跳", async () => {
    await mountSidebar()
    await pickMenuItem("退出登录")

    confirmButton("退出")?.click()
    await flushPromises()

    expect(assign).toHaveBeenCalledWith(
      `/api/auth/logout?redirect=${encodeURIComponent("/2048")}`
    )
  })
})

describe("侧栏的「画布」入口", () => {
  /** 当前高亮的那一项（高亮态的类名是独立的 `bg-sidebar-accent`，不含 hover: 前缀） */
  async function activeLabels(path: string) {
    const wrapper = await mountSidebar()
    await router.push(path)
    await flushPromises()
    return wrapper
      .findAll("a")
      .filter((a) => a.classes().includes("bg-sidebar-accent"))
      .map((a) => a.attributes("href"))
  }

  it("个人画布与项目页是同一个工作区 → 都让「画布」（/canvas）亮着", async () => {
    expect(await activeLabels("/canvas")).toContain("/canvas")
    expect(await activeLabels("/projects/p1")).toContain("/canvas")
  })

  it("别的页面 → 「画布」不亮", async () => {
    expect(await activeLabels("/snake")).not.toContain("/canvas")
  })
})
