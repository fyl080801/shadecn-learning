import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { ref } from "vue"

import FlowConnectionEndedDialog from "@/components/flow/FlowConnectionEndedDialog.vue"
import type { FatalClose } from "@/composables/flow/sync"

/**
 * 同步通道被终局掐掉时的提示。
 *
 * 这里钉的是**能不能关掉**这条规则，因为它不是样式偏好而是出路决定的：
 * 顶下线 / 失去权限那两种，用户在这一页上做什么都没用，框关不掉才对；
 * 而画布超限的唯一自救办法就是**在这一页上删东西**，一个关不掉的模态会把出路挡死。
 */

const fatal = ref<FatalClose | null>(null)
const meta = ref<{ mode: "collab" | "solo" } | null>({ mode: "collab" })

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    sync: { fatal },
    // store.meta 在 Pinia 的 setup store 里已经解包，这里照着那个形状给
    get store() {
      return { meta: meta.value }
    }
  })
}))

const push = vi.fn()
vi.mock("vue-router", () => ({
  useRouter: () => ({ push })
}))

/** 对话框走 teleport，内容挂在 body 上，wrapper 里找不到 */
function button(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === text
  )
}

function shown() {
  return document.body.textContent ?? ""
}

beforeEach(() => {
  document.body.innerHTML = ""
  fatal.value = null
  meta.value = { mode: "collab" }
  push.mockClear()
})

describe("协同通道终局提示", () => {
  it("通道好好的 → 什么都不弹", async () => {
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toBe("")
  })

  it("被顶下线 → 弹，且没有「关掉」这条路", async () => {
    fatal.value = "superseded"
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toContain("协作会话已过期")
    expect(button("刷新页面")).toBeTruthy()
    expect(button("知道了，先去删内容")).toBeUndefined()
  })

  it("登录态过期 → 这里不弹，交给全站的会话过期框（免得两个模态叠着）", async () => {
    fatal.value = "unauthorized"
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toBe("")
  })

  it("被移出项目 / 画布被删 → 说清两种可能，出路是回项目列表", async () => {
    fatal.value = "forbidden"
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toContain("已失去这张画布的访问权限")
    expect(shown()).toContain("项目管理员")

    button("返回画布项目")?.click()
    await flushPromises()
    expect(push).toHaveBeenCalledWith("/projects")
  })

  it("个人画布被删 → 换一套说法和落点：没有项目也没有管理员", async () => {
    // 个人空间在库里确实是个项目，但把人送进「画布项目」列表，他会找不到刚才那张画布
    meta.value = { mode: "solo" }
    fatal.value = "forbidden"
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toContain("这张画布已经不在了")
    expect(shown()).not.toContain("项目管理员")

    button("返回个人画布")?.click()
    await flushPromises()
    expect(push).toHaveBeenCalledWith("/personal")
  })

  it("画布超限 → 弹，但**可以关掉**：关掉才能去删内容", async () => {
    fatal.value = "too-large"
    mount(FlowConnectionEndedDialog)
    await flushPromises()

    expect(shown()).toContain("画布太大")
    const dismiss = button("知道了，先去删内容")
    expect(dismiss).toBeTruthy()

    dismiss?.click()
    await flushPromises()

    // 关掉之后画布必须真的能用 —— 提示还挂在那儿就等于没关
    expect(shown()).not.toContain("画布太大")
  })

  it("关掉之后换了一种原因 → 重新弹，上一次的「知道了」不接着算", async () => {
    fatal.value = "too-large"
    mount(FlowConnectionEndedDialog)
    await flushPromises()
    button("知道了，先去删内容")?.click()
    await flushPromises()
    expect(shown()).not.toContain("画布太大")

    fatal.value = "forbidden"
    await flushPromises()

    expect(shown()).toContain("已失去这张画布的访问权限")
  })
})
