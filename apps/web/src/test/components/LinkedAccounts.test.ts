import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter, type Router } from "vue-router"

import LinkedAccounts from "@/components/settings/LinkedAccounts.vue"
import { ApiError } from "@/lib/api"
import type { AuthIdentity, PendingLink } from "@/types/auth"

/**
 * 设置页「登录方式」那张卡片。
 *
 * 三件事值得钉住：只剩一条时解绑按钮是禁的（把自己锁在外面是不可逆的）、
 * 解绑要过一次确认框、以及关联流程跳回来时那条结果 query 读完就洗掉
 * （留着的话刷新一次会再弹一遍）。
 */

const api = vi.hoisted(() => ({
  identities: vi.fn(),
  config: vi.fn(),
  unlinkIdentity: vi.fn(),
  startLink: vi.fn(),
  confirmLink: vi.fn(),
  cancelLink: vi.fn()
}))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ApiError: actual.ApiError, authApi: api }
})

vi.mock("vue-sonner", () => ({ toast: toasts }))

const KEYCLOAK: AuthIdentity = {
  id: "id_kc",
  provider: "keycloak",
  label: "Keycloak",
  username: "alice",
  email: "alice@example.com",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  primary: true
}

const GITHUB: AuthIdentity = {
  id: "id_gh",
  provider: "github",
  label: "GitHub",
  username: "octocat",
  email: null,
  avatarUrl: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  lastLoginAt: null,
  primary: false
}

const PROVIDERS = [
  { id: "keycloak" as const, label: "Keycloak", buttonLabel: "使用 Keycloak 登录" },
  { id: "github" as const, label: "GitHub", buttonLabel: "使用 GitHub 登录" }
]

beforeEach(() => {
  vi.clearAllMocks()
  api.config.mockResolvedValue({
    enabled: true,
    provider: "keycloak",
    providers: PROVIDERS
  })
  // 卡片里会 fetchSession(true)，别让它撞上 setup.ts 那个「禁止真实请求」的 fetch
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ enabled: true, authenticated: true, user: null, expiresAt: null }),
        { headers: { "content-type": "application/json" } }
      )
    )
  )
})

const PENDING: PendingLink = {
  provider: "github",
  label: "GitHub",
  username: "octocat",
  email: "octo@example.com",
  avatarUrl: null
}

async function mountCard(
  items: AuthIdentity[],
  query = "",
  pending: PendingLink | null = null
) {
  api.identities.mockResolvedValue({ items, pending })

  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/settings", component: { template: "<div />" } }]
  })
  await router.push(`/settings${query}`)
  await router.isReady()

  const wrapper = mount(LinkedAccounts, {
    global: { plugins: [router] },
    attachTo: document.body
  })
  await flushPromises()
  return { wrapper, router }
}

/** 确认框走 teleport，内容挂在 body 上 */
function dialogButton(text: string) {
  const buttons = [...document.querySelectorAll("[data-slot=alert-dialog-content] button")]
  return buttons.find((el) => el.textContent?.trim() === text) as HTMLElement | undefined
}

describe("登录方式卡片", () => {
  it("列出已关联的账号，并标出主身份", async () => {
    const { wrapper } = await mountCard([KEYCLOAK, GITHUB])

    const rows = wrapper.findAll("[data-provider]")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain("Keycloak")
    expect(rows[0]?.text()).toContain("主身份")
    expect(rows[1]?.text()).not.toContain("主身份")
  })

  it("只剩一条时解绑是禁用的 —— 解掉就再也登不进来", async () => {
    const { wrapper } = await mountCard([KEYCLOAK])

    const button = wrapper.get('[data-testid="unlink-keycloak"]')
    expect(button.attributes("disabled")).toBeDefined()
  })

  it("有两条时可以解绑，且要先过确认框", async () => {
    api.unlinkIdentity.mockResolvedValue(undefined)
    const { wrapper } = await mountCard([KEYCLOAK, GITHUB])

    await wrapper.get('[data-testid="unlink-github"]').trigger("click")
    await flushPromises()
    // 点了按钮还没发请求，先弹框
    expect(api.unlinkIdentity).not.toHaveBeenCalled()

    dialogButton("解绑")?.click()
    await flushPromises()

    expect(api.unlinkIdentity).toHaveBeenCalledWith("id_gh")
    // 列表当场少一行，不用重新拉
    expect(wrapper.findAll("[data-provider]")).toHaveLength(1)
  })

  it("解绑被服务端拒了（409）→ 弹错误，行还在", async () => {
    api.unlinkIdentity.mockRejectedValue(
      new ApiError("至少要保留一种登录方式", 409, null)
    )
    const { wrapper } = await mountCard([KEYCLOAK, GITHUB])

    await wrapper.get('[data-testid="unlink-github"]').trigger("click")
    await flushPromises()
    dialogButton("解绑")?.click()
    await flushPromises()

    expect(toasts.error).toHaveBeenCalledWith("至少要保留一种登录方式")
    expect(wrapper.findAll("[data-provider]")).toHaveLength(2)
  })

  it("只给还没绑的提供方留「关联」入口", async () => {
    const { wrapper } = await mountCard([KEYCLOAK])

    expect(wrapper.find('[data-testid="link-github"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="link-keycloak"]').exists()).toBe(false)

    await wrapper.get('[data-testid="link-github"]').trigger("click")
    expect(api.startLink).toHaveBeenCalledWith("github")
  })

  it("全绑上了就没有关联入口", async () => {
    const { wrapper } = await mountCard([KEYCLOAK, GITHUB])
    expect(wrapper.find('[data-testid="link-github"]').exists()).toBe(false)
  })

  /**
   * 授权回来之后**还没绑上**：确认框把账号摆出来，点了才写。
   * 存在的理由是提供方那边可能正登着别人的号，而那一趟对用户完全无感。
   */
  describe("待确认的关联", () => {
    it("有待确认的就弹确认框，并把那个账号摆出来", async () => {
      await mountCard([KEYCLOAK], "", PENDING)

      const box = document.querySelector('[data-testid="pending-account"]')
      expect(box?.textContent).toContain("octocat")
      expect(box?.textContent).toContain("octo@example.com")
    })

    it("没有待确认的就不弹", async () => {
      await mountCard([KEYCLOAK])
      expect(document.querySelector('[data-testid="pending-account"]')).toBeNull()
    })

    it("点「确认关联」才发请求，列表当场多一行", async () => {
      api.confirmLink.mockResolvedValue({ identity: GITHUB })
      const { wrapper } = await mountCard([KEYCLOAK], "", PENDING)
      expect(api.confirmLink).not.toHaveBeenCalled()

      dialogButton("确认关联")?.click()
      await flushPromises()

      expect(api.confirmLink).toHaveBeenCalled()
      expect(toasts.success).toHaveBeenCalledWith("已关联 GitHub")
      expect(wrapper.findAll("[data-provider]")).toHaveLength(2)
    })

    /**
     * 按 Esc 只是「等会儿再说」：待确认那条在服务端，所以什么都没绑，
     * 下次进设置页会再问一遍。要守的是「不确认就不写库」，不是「不许关窗」。
     */
    it("按 Esc 关掉 → 什么都没绑，也没去放弃它", async () => {
      const { wrapper } = await mountCard([KEYCLOAK], "", PENDING)

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flushPromises()

      expect(api.confirmLink).not.toHaveBeenCalled()
      expect(api.cancelLink).not.toHaveBeenCalled()
      expect(wrapper.findAll("[data-provider]")).toHaveLength(1)
    })

    it("点「不是我，取消」→ 放弃，不绑", async () => {
      api.cancelLink.mockResolvedValue(undefined)
      const { wrapper } = await mountCard([KEYCLOAK], "", PENDING)

      dialogButton("不是我，取消")?.click()
      await flushPromises()

      expect(api.cancelLink).toHaveBeenCalled()
      expect(api.confirmLink).not.toHaveBeenCalled()
      expect(wrapper.findAll("[data-provider]")).toHaveLength(1)
    })

    it("确认时被服务端拒了（409）→ 弹错误，不往列表里加", async () => {
      api.confirmLink.mockRejectedValue(
        new ApiError("这个 GitHub 账号已经关联到另一个用户，请先用它登录并解绑", 409, null)
      )
      const { wrapper } = await mountCard([KEYCLOAK], "", PENDING)

      dialogButton("确认关联")?.click()
      await flushPromises()

      expect(toasts.error).toHaveBeenCalledWith(
        "这个 GitHub 账号已经关联到另一个用户，请先用它登录并解绑"
      )
      expect(wrapper.findAll("[data-provider]")).toHaveLength(1)
    })
  })

  it("?link_error= 走错误提示，同样洗掉", async () => {
    const { router } = await mountCard([KEYCLOAK], "?link_error=%E8%A2%AB%E5%8D%A0%E4%BA%86")

    expect(toasts.error).toHaveBeenCalledWith("被占了")
    expect(router.currentRoute.value.query.link_error).toBeUndefined()
  })
})
