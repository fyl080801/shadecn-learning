import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter } from "vue-router"

import ProjectHome from "@/views/canvas/ProjectHome.vue"
import { flowApi, projectApi } from "@/lib/api"
import { emptyGraph } from "@/types/flow"
import type {
  FlowDetail,
  FlowSummary,
  Paged,
  ProjectInviteView,
  ProjectMemberView,
  ProjectSummary
} from "@/types/flow"

/**
 * 项目主页的二次确认对话框。
 *
 * 这里守的是一个很容易踩回去的坑：reka-ui 的 AlertDialogAction 先关闭对话框、
 * 再执行透传下来的 @click。要是「开关」和「操作哪一个」共用一个 ref，
 * 关闭时把它清成 null，handler 里就永远拿不到目标 —— 请求一声不响地发不出去，
 * 界面上看起来就是「删了还在列表里」。
 */

vi.mock("@/lib/api", () => ({
  projectApi: {
    get: vi.fn(),
    members: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    removeMember: vi.fn(),
    invite: vi.fn(),
    setInviteExpiry: vi.fn(),
    resetInvite: vi.fn()
  },
  flowApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn()
  }
}))

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const PROJECT_ID = "prj_1"

function project(): ProjectSummary {
  return {
    id: PROJECT_ID,
    name: "测试项目",
    description: null,
    kind: "team",
    memberCount: 1,
    flowCount: 2,
    myRole: "admin",
    createdById: "u1",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  }
}

function flow(id: string, name: string): FlowSummary {
  return {
    id,
    projectId: PROJECT_ID,
    mode: "collab",
    name,
    description: null,
    status: "draft",
    tags: [],
    thumbnail: null,
    nodeCount: 0,
    edgeCount: 0,
    revision: 0,
    createdById: "u1",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  }
}

function flowDetail(id: string, name: string): FlowDetail {
  return { ...flow(id, name), graph: emptyGraph(), userState: {} }
}

function paged(items: FlowSummary[]): Paged<FlowSummary> {
  return { items, page: 1, pageSize: 20, total: items.length, totalPages: 1 }
}

const member: ProjectMemberView = {
  userId: "u2",
  name: "同事",
  username: "bob",
  email: "bob@example.com",
  avatarUrl: null,
  role: "member",
  joinedAt: "2026-08-15T00:00:00.000Z",
  invitedById: "u1"
}

function invite(token = "tok_1"): ProjectInviteView {
  return {
    id: "inv_1",
    projectId: PROJECT_ID,
    token,
    url: `http://127.0.0.1:3000/invite/${token}`,
    role: "member",
    createdById: "u1",
    createdAt: "2026-08-15T00:00:00.000Z",
    // 7 天档，落在未来
    expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
  }
}

/** jsdom 没有 PointerEvent / pointer capture，reka-ui 的菜单开合要用到 */
function stubPointerApis() {
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
      { path: "/projects/:projectId", component: { template: "<div />" } },
      { path: "/flows/:flowId", component: { template: "<div />" } }
    ]
  })
  await router.push(`/projects/${PROJECT_ID}`)
  await router.isReady()

  const wrapper = mount(ProjectHome, {
    props: { projectId: PROJECT_ID },
    global: { plugins: [router] },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

/** 对话框走的是 teleport，内容在 body 上，wrapper 里找不到 */
function bodyButton(text: string) {
  const buttons = [...document.querySelectorAll("[data-slot=alert-dialog-content] button")]
  return buttons.find((el) => el.textContent?.trim() === text) as HTMLElement | undefined
}

/** 打开某一行的「⋯」菜单，点里面的菜单项 */
async function pickRowMenuItem(rowName: string, itemText: string) {
  const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
    tr.textContent?.includes(rowName)
  )
  const trigger = row?.querySelector("[data-slot=dropdown-menu-trigger]") as HTMLElement
  trigger.click()
  await flushPromises()

  const item = [...document.querySelectorAll("[data-slot=dropdown-menu-item]")].find(
    (el) => el.textContent?.trim() === itemText
  ) as HTMLElement
  item.click()
  await flushPromises()
}

/** 切到某个 Tab —— reka 的 TabsTrigger 认 mousedown，光 click 不换页 */
async function switchTab(label: string) {
  const tab = [...document.querySelectorAll("[data-slot=tabs-trigger]")].find((el) =>
    el.textContent?.includes(label)
  ) as HTMLElement
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  tab.click()
  await flushPromises()
}

describe("项目主页的删除确认", () => {
  beforeEach(() => {
    stubPointerApis()
    document.body.innerHTML = ""
    vi.clearAllMocks()

    vi.mocked(projectApi.get).mockResolvedValue(project())
    vi.mocked(projectApi.members).mockResolvedValue([member])
    vi.mocked(flowApi.list).mockResolvedValue(paged([flow("f1", "画布A"), flow("f2", "画布B")]))
    vi.mocked(flowApi.remove).mockResolvedValue(undefined)
    vi.mocked(projectApi.removeMember).mockResolvedValue(undefined)
  })

  it("确认删除画布 → 发出删除请求并重新拉列表", async () => {
    await mountPage()
    await pickRowMenuItem("画布A", "删除")

    expect(document.body.textContent).toContain("删除画布「画布A」？")

    vi.mocked(flowApi.list).mockClear()
    bodyButton("删除")?.click()
    await flushPromises()

    // 删的必须是点开菜单的那一张，不是 undefined、也不是别的
    expect(flowApi.remove).toHaveBeenCalledWith("f1")
    expect(flowApi.list).toHaveBeenCalled()
  })

  it("取消删除画布 → 什么都不发", async () => {
    await mountPage()
    await pickRowMenuItem("画布B", "删除")

    bodyButton("取消")?.click()
    await flushPromises()

    expect(flowApi.remove).not.toHaveBeenCalled()
  })

  it("确认移除成员 → 带着这个成员的 id 发请求", async () => {
    await mountPage()
    await switchTab("成员")

    const removeBtn = document.querySelector('button[title="移出项目"]') as HTMLElement
    removeBtn.click()
    await flushPromises()

    bodyButton("移除")?.click()
    await flushPromises()

    expect(projectApi.removeMember).toHaveBeenCalledWith(PROJECT_ID, "u2")
  })
})

describe("防连点：一次点击一次请求", () => {
  beforeEach(() => {
    stubPointerApis()
    document.body.innerHTML = ""
    vi.clearAllMocks()

    vi.mocked(projectApi.get).mockResolvedValue(project())
    vi.mocked(projectApi.members).mockResolvedValue([member])
    vi.mocked(flowApi.list).mockResolvedValue(paged([flow("f1", "画布A")]))
    vi.mocked(flowApi.remove).mockResolvedValue(undefined)
    vi.mocked(flowApi.duplicate).mockResolvedValue(flowDetail("f2", "画布A 副本"))
  })

  /** 找对话框里的按钮（dialog 走 teleport，在 body 上） */
  function dialogButton(text: string) {
    return [...document.querySelectorAll("[data-slot=dialog-content] button")].find(
      (el) => el.textContent?.trim() === text
    ) as HTMLElement | undefined
  }

  it("连点「创建并打开」→ 只建一张画布", async () => {
    const wrapper = await mountPage()
    vi.mocked(flowApi.create).mockResolvedValue(flowDetail("f9", "新画布"))

    const open = wrapper.findAll("button").find((b) => b.text() === "新建画布")
    await open?.trigger("click")
    await flushPromises()

    const input = document.querySelector("#flow-name") as HTMLInputElement
    input.value = "新画布"
    input.dispatchEvent(new Event("input"))
    await flushPromises()

    // 两次点击之间没有任何 await —— disabled 这时还没渲染上去，
    // 拦住第二次的必须是 handler 里的锁
    const submit = dialogButton("创建并打开")
    submit?.click()
    submit?.click()
    await flushPromises()

    expect(flowApi.create).toHaveBeenCalledTimes(1)
  })

  it("连按回车提交新建 → 只建一张画布", async () => {
    const wrapper = await mountPage()
    vi.mocked(flowApi.create).mockResolvedValue(flowDetail("f9", "新画布"))

    const open = wrapper.findAll("button").find((b) => b.text() === "新建画布")
    await open?.trigger("click")
    await flushPromises()

    const input = document.querySelector("#flow-name") as HTMLInputElement
    input.value = "新画布"
    input.dispatchEvent(new Event("input"))
    await flushPromises()

    const enter = () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    enter()
    enter()
    await flushPromises()

    expect(flowApi.create).toHaveBeenCalledTimes(1)
  })

  it("连点确认删除 → 只发一次删除请求", async () => {
    await mountPage()
    await pickRowMenuItem("画布A", "删除")

    const confirm = bodyButton("删除")
    confirm?.click()
    confirm?.click()
    await flushPromises()

    expect(flowApi.remove).toHaveBeenCalledTimes(1)
  })

  it("上一次复制还没回来 → 同一行再点不会再发一次", async () => {
    await mountPage()
    // 请求一直挂着，模拟慢接口
    vi.mocked(flowApi.duplicate).mockReturnValue(new Promise(() => {}))

    await pickRowMenuItem("画布A", "复制")
    await pickRowMenuItem("画布A", "复制")

    expect(flowApi.duplicate).toHaveBeenCalledTimes(1)
  })
})

describe("项目的分享链接", () => {
  beforeEach(() => {
    stubPointerApis()
    document.body.innerHTML = ""
    vi.clearAllMocks()

    vi.mocked(projectApi.get).mockResolvedValue(project())
    vi.mocked(projectApi.members).mockResolvedValue([member])
    vi.mocked(flowApi.list).mockResolvedValue(paged([flow("f1", "画布A")]))
    vi.mocked(projectApi.invite).mockResolvedValue(invite())
    vi.mocked(projectApi.resetInvite).mockResolvedValue(invite("tok_2"))
  })

  /** 头部的按钮不走 teleport，还在 wrapper 里 */
  async function openPanel() {
    const wrapper = await mountPage()
    const share = wrapper.findAll("button").find((b) => b.text() === "分享")
    await share?.trigger("click")
    await flushPromises()
    return wrapper
  }

  /** 链接躺在只读输入框里，textContent 里是看不到的 */
  function shareLinkValue() {
    const input = document.querySelector(
      "[data-slot=dialog-content] input[readonly]"
    ) as HTMLInputElement | null
    return input?.value
  }

  it("点「分享」→ 面板里直接就有链接，不需要先生成", async () => {
    await openPanel()

    expect(projectApi.invite).toHaveBeenCalledWith(PROJECT_ID)
    expect(shareLinkValue()).toBe("http://127.0.0.1:3000/invite/tok_1")
    expect(document.body.textContent).toContain("复制")
  })

  it("确认重置 → 换成新链接", async () => {
    await openPanel()

    const reset = [...document.querySelectorAll("[data-slot=dialog-content] button")].find(
      (el) => el.textContent?.trim() === "重置链接"
    ) as HTMLElement
    reset.click()
    await flushPromises()

    bodyButton("重置")?.click()
    await flushPromises()

    expect(projectApi.resetInvite).toHaveBeenCalledWith(PROJECT_ID, 7)
    expect(shareLinkValue()).toBe("http://127.0.0.1:3000/invite/tok_2")
  })
})
