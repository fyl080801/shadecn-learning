import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter } from "vue-router"

import ProjectHome from "@/views/canvas/ProjectHome.vue"
import { flowApi, projectApi } from "@/lib/api"
import type { FlowSummary, Paged, ProjectMemberView, ProjectSummary } from "@/types/flow"

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
    removeMember: vi.fn()
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
