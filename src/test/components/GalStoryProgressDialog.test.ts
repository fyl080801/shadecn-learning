import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import ProgressDialog from "@/components/galstory/ProgressDialog.vue"
import { saveApi } from "@/lib/galstory"
import type { SaveSummary, StorySummary } from "@/types/galstory"

/**
 * 「我的进度」里的删除。
 *
 * 守的是**同一个已经踩过两次的坑**（`ProjectHome.test.ts` 与 `FlowList.vue` 里各钉过一次）：
 * reka-ui 的 `AlertDialogAction` 内部就是 `DialogClose` —— **先关掉对话框、再**跑透传下来的
 * `@click`，而它那个内部 handler **不看 `event.defaultPrevented`**（`DialogClose.vue` 里是
 * 一句裸的 `onOpenChange(false)`），故 `@click.prevent` 挡不住它。要是「开关」和「删哪一个」
 * 共用一个 ref，关闭动作会先把它清成 null，handler 里读到的就是 null → 一声不响地什么都不发，
 * 界面上看起来就是「点了删除，框关了，进度还在」。
 */

vi.mock("@/lib/galstory", () => ({
  saveApi: {
    list: vi.fn(),
    remove: vi.fn()
  }
}))

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const STORY: StorySummary = {
  name: "rainy_inn",
  title: "雨夜客栈",
  cover: "",
  // 公共库那一份：`owner` 空、故不可编辑（判据在引擎那一侧，这两格只是展示）
  owner: "",
  scope: "public",
  writable: false,
  playable: true,
  characters: 3,
  scenes: 2,
  saves: 2
}

function save(id: string, title: string): SaveSummary {
  return {
    id,
    story: "rainy_inn",
    title,
    created: "2026-08-15T00:00:00.000Z",
    backend: "git",
    progress: { turns: 3, stage: "第一幕", scene: "堂屋", started: true, label: "第一幕 · 堂屋 · 3 轮" },
    open: false
  }
}

/** jsdom 没有 PointerEvent / pointer capture，reka-ui 的对话框开合要用到 */
function stubPointerApis() {
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}

async function mountDialog() {
  const wrapper = mount(ProgressDialog, {
    props: { story: STORY },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

/** 对话框走 teleport，内容在 body 上 */
function bodyButton(text: string) {
  const buttons = [...document.querySelectorAll("[data-slot=alert-dialog-content] button")]
  return buttons.find((el) => el.textContent?.trim() === text) as HTMLElement | undefined
}

/** 点某一行的垃圾桶 */
async function askDelete(title: string) {
  const row = [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(title))
  const trash = row?.querySelector('button[title="删除这份进度"]') as HTMLElement
  trash.click()
  await flushPromises()
}

describe("我的进度 · 删除确认", () => {
  beforeEach(() => {
    stubPointerApis()
    document.body.innerHTML = ""
    vi.clearAllMocks()
    vi.mocked(saveApi.list).mockResolvedValue([save("s1", "存档甲"), save("s2", "存档乙")])
    vi.mocked(saveApi.remove).mockResolvedValue(undefined)
  })

  it("确认删除 → 真的发出删除请求，并把那一行从列表里去掉", async () => {
    await mountDialog()
    await askDelete("存档甲")

    expect(document.body.textContent).toContain("删除这份进度？")

    bodyButton("删除")?.click()
    await flushPromises()

    // 删的必须是点开的那一份，不是 undefined、也不是别的
    expect(saveApi.remove).toHaveBeenCalledWith("s1")
    expect(document.body.textContent).not.toContain("存档甲")
    expect(document.body.textContent).toContain("存档乙")
  })

  it("取消 → 什么都不发", async () => {
    await mountDialog()
    await askDelete("存档乙")

    bodyButton("取消")?.click()
    await flushPromises()

    expect(saveApi.remove).not.toHaveBeenCalled()
  })
})
