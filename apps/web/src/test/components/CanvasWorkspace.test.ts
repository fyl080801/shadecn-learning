import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter, type Router } from "vue-router"

import CanvasWorkspace from "@/components/canvas/CanvasWorkspace.vue"
import { projectApi } from "@/lib/api"
import { resetProjectNav } from "@/composables/useProjectNav"
import type { Paged, ProjectSummary } from "@shadecn/shared/canvas"

/**
 * 画布工作区的页内侧栏：个人画布 + 项目分组。
 *
 * 删除确认沿用 CLAUDE.md 里记的那个坑：AlertDialogAction 先关框再跑 @click，
 * 所以「开关」和「删哪个」必须是两个 ref —— 这里用真实的 reka-ui 把整条路走一遍。
 */

vi.mock("@/lib/api", () => ({
  projectApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn()
  }
}))

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

function project(id: string, name: string, myRole: "admin" | "member" = "admin"): ProjectSummary {
  return {
    id,
    name,
    description: null,
    kind: "team",
    memberCount: 1,
    flowCount: 0,
    myRole,
    createdById: "u1",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  }
}

function paged(items: ProjectSummary[], total = items.length): Paged<ProjectSummary> {
  return { items, page: 1, pageSize: 100, total, totalPages: 1 }
}

let router: Router

async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/personal", component: { template: "<div />" } },
      { path: "/projects/:projectId", component: { template: "<div />" } }
    ]
  })
  await router.push(path)
  await router.isReady()

  const wrapper = mount(CanvasWorkspace, {
    global: { plugins: [router] },
    slots: { default: '<div id="content">内容</div>' },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

function deleteIcon(name: string) {
  return document.querySelector(`button[title="删除项目「${name}」"]`) as HTMLElement | null
}

function dialogButton(selector: string, text: string) {
  return [...document.querySelectorAll(`${selector} button`)].find(
    (el) => el.textContent?.trim() === text
  ) as HTMLElement | undefined
}

describe("画布工作区的页内侧栏", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    vi.clearAllMocks()
    // 项目列表是模块级缓存，用例之间要清掉
    resetProjectNav()
    vi.mocked(projectApi.list).mockResolvedValue(
      paged([project("p1", "订单系统"), project("p2", "只读项目", "member")])
    )
  })

  it("个人画布排第一项，下面「项目」分组列出我的项目，内容区渲染插槽", async () => {
    const wrapper = await mountAt("/personal")

    const links = wrapper.findAll("aside a").map((a) => a.text())
    expect(links).toEqual(["个人画布", "订单系统", "只读项目"])
    expect(wrapper.find("aside").text()).toContain("项目")
    expect(wrapper.find("#content").exists()).toBe(true)
    expect(projectApi.list).toHaveBeenCalledWith({ page: 1, pageSize: 100 })
  })

  it("当前路由对应的那一项高亮", async () => {
    const wrapper = await mountAt("/projects/p1")

    const active = wrapper.findAll("aside a").filter((a) => a.classes().includes("bg-accent"))
    expect(active.map((a) => a.text())).toEqual(["订单系统"])
  })

  it("只有管理员的项目才有删除图标", async () => {
    await mountAt("/personal")

    expect(deleteIcon("订单系统")).not.toBeNull()
    expect(deleteIcon("只读项目")).toBeNull()
  })

  it("点删除 → 确认 → 发删除请求、重新拉列表；删的不是当前项目就不跳转", async () => {
    await mountAt("/projects/p2")
    vi.mocked(projectApi.remove).mockResolvedValue(undefined)
    vi.mocked(projectApi.list).mockClear()

    deleteIcon("订单系统")!.click()
    await flushPromises()
    expect(document.body.textContent).toContain("删除项目「订单系统」？")
    dialogButton("[data-slot=alert-dialog-content]", "删除")!.click()
    await flushPromises()

    expect(projectApi.remove).toHaveBeenCalledWith("p1")
    expect(projectApi.list).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe("/projects/p2")
  })

  it("删掉的正是当前打开的项目 → 回到个人画布", async () => {
    await mountAt("/projects/p1")
    vi.mocked(projectApi.remove).mockResolvedValue(undefined)

    deleteIcon("订单系统")!.click()
    await flushPromises()
    dialogButton("[data-slot=alert-dialog-content]", "删除")!.click()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe("/personal")
  })

  it("取消删除 → 什么都不发", async () => {
    await mountAt("/personal")

    deleteIcon("订单系统")!.click()
    await flushPromises()
    dialogButton("[data-slot=alert-dialog-content]", "取消")!.click()
    await flushPromises()

    expect(projectApi.remove).not.toHaveBeenCalled()
  })

  it("点「项目」标题行的 + → 弹出新建对话框，提交后创建、刷新并跳到新项目", async () => {
    const wrapper = await mountAt("/personal")
    vi.mocked(projectApi.create).mockResolvedValue(project("p3", "新项目"))
    vi.mocked(projectApi.list).mockClear()

    await wrapper.find('button[title="新建项目"]').trigger("click")
    await flushPromises()
    const input = document.querySelector("#project-name") as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = "新项目"
    input.dispatchEvent(new Event("input"))
    // Input 的 v-model 是 passive 的，经 watch 异步回写
    await flushPromises()
    dialogButton("[data-slot=dialog-content]", "创建")!.click()
    await flushPromises()

    expect(projectApi.create).toHaveBeenCalledWith({ name: "新项目", description: null })
    expect(projectApi.list).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe("/projects/p3")
  })

  it("名称为空 → 不发请求", async () => {
    const wrapper = await mountAt("/personal")

    await wrapper.find('button[title="新建项目"]').trigger("click")
    await flushPromises()
    dialogButton("[data-slot=dialog-content]", "创建")!.click()
    await flushPromises()

    expect(projectApi.create).not.toHaveBeenCalled()
  })

  it("没有项目 → 一句小字提示；超过一页 → 底部提示总数", async () => {
    vi.mocked(projectApi.list).mockResolvedValue(paged([]))
    const empty = await mountAt("/personal")
    expect(empty.text()).toContain("还没有项目")
    empty.unmount()

    resetProjectNav()
    vi.mocked(projectApi.list).mockResolvedValue(paged([project("p1", "订单系统")], 130))
    const many = await mountAt("/personal")
    expect(many.text()).toContain("共 130 个项目")
  })

  it("加载失败 → 显示错误，点重试再拉一次", async () => {
    vi.mocked(projectApi.list).mockRejectedValueOnce(new Error("boom"))
    const wrapper = await mountAt("/personal")
    expect(wrapper.text()).toContain("boom")

    const retry = wrapper.findAll("button").find((b) => b.text() === "重试")
    await retry!.trigger("click")
    await flushPromises()

    expect(projectApi.list).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain("订单系统")
  })

  it("第二次挂载复用缓存 → 不再重复请求，也不闪 loading", async () => {
    const first = await mountAt("/personal")
    first.unmount()
    vi.mocked(projectApi.list).mockClear()

    const second = await mountAt("/projects/p1")

    expect(projectApi.list).not.toHaveBeenCalled()
    expect(second.text()).toContain("订单系统")
  })
})
