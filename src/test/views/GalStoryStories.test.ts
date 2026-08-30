import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import Stories from "@/views/galstory/Stories.vue"
import { saveApi, storyApi } from "@/lib/galstory"
import type { Quota, StorySummary } from "@/types/galstory"

/**
 * 故事库的**版式**与卡内动作。
 *
 * 这几条守的是同一类错：**功能是好的，只是版式在窄屏下悄悄坏掉**。改版前那一版是「一行一条」
 * 的横条 —— 中间 `min-w-0 flex-1` 的标题块、右边 `shrink-0` 的四个按钮，桌面上一切正常，
 * 手机上按钮一个像素都不让、直接压在标题与 id 上，最右那颗删除还溢出卡片被裁掉一半。
 * 它不报错、不失败，只能靠真的把窗口拖窄看一眼。
 *
 * ⚠️ **jsdom 没有布局引擎**（`getBoundingClientRect` 恒 0，媒体查询也不生效），所以这里
 * **量不了「窄屏是不是真的一列」**，只能钉住用来切换的那个判据本身：栅格类串从 `grid-cols-1`
 * 起、断点前缀逐档加列，而且骨架屏与真列表**共用同一串**。钉到这一层是有价值的 ——
 * 「有人把 `grid-cols-1` 删了」「有人给骨架屏另抄了一套类」这两种回归它都拦得住；
 * 真正的像素级验收只能在浏览器里做（改版时两个宽度各量过一遍）。
 */

vi.mock("@/lib/galstory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/galstory")>()
  return {
    ...actual,
    storyApi: {
      list: vi.fn(),
      confirmHint: vi.fn(),
      remove: vi.fn()
    },
    saveApi: { create: vi.fn(), list: vi.fn() },
    runApi: { list: vi.fn() }
  }
})

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const push = vi.fn()
vi.mock("vue-router", () => ({
  useRouter: () => ({ push })
}))

function story(patch: Partial<StorySummary> = {}): StorySummary {
  return {
    name: "rainy_inn",
    title: "雨夜客栈",
    cover: "",
    owner: "",
    scope: "public",
    writable: false,
    playable: true,
    characters: 3,
    scenes: 2,
    saves: 1,
    ...patch
  }
}

const IDLE: Quota = { limit: 1, running: [] }

async function mountPage(items: StorySummary[] = [story()], quota: Quota = IDLE) {
  const { runApi } = await import("@/lib/galstory")
  vi.mocked(storyApi.list).mockResolvedValue(items)
  vi.mocked(runApi.list).mockResolvedValue(quota)
  const wrapper = mount(Stories, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** 卡片里那颗按钮 —— 按可见文字找，找不到就是真的没渲染 */
function cardButton(text: string) {
  return [...document.querySelectorAll("li button")].find(
    (el) => el.textContent?.trim() === text
  ) as HTMLElement | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ""
})

afterEach(() => {
  vi.useRealTimers()
})

describe("故事库 · 版式", () => {
  it("窄屏一列，往上才逐档加列 —— 列数只由断点前缀声明", async () => {
    await mountPage()

    const grid = document.querySelector("ul")!
    // 裸的那一档必须是 1 列：漏掉它，Tailwind 的缺省是「按内容排」，手机上就又叠回去了
    expect(grid.className).toContain("grid-cols-1")
    expect(grid.className).toContain("sm:grid-cols-2")
    expect(grid.className).toContain("lg:grid-cols-3")
    expect(grid.className).toContain("xl:grid-cols-4")
  })

  it("骨架屏与真列表用的是同一串栅格类 —— 加载完不会整版跳一次", async () => {
    let resolve: (v: StorySummary[]) => void = () => {}
    vi.mocked(storyApi.list).mockReturnValue(
      new Promise<StorySummary[]>((r) => {
        resolve = r
      })
    )
    const { runApi } = await import("@/lib/galstory")
    vi.mocked(runApi.list).mockResolvedValue(IDLE)

    mount(Stories, { attachTo: document.body })
    await flushPromises()
    // 加载中：还没有 ul，栅格挂在骨架屏那个容器上
    const loadingGrid = document.querySelector("[class*='grid-cols-1']")!.className

    resolve([story()])
    await flushPromises()

    expect(document.querySelector("ul")!.className).toBe(loadingGrid)
  })

  it("封面恒 3:4 竖版；作者没给 cover 就落占位，不留一个碎图标", async () => {
    await mountPage([story({ cover: "" })])

    const cover = document.querySelector("li > div")!
    expect(cover.className).toContain("aspect-[3/4]")
    expect(cover.querySelector("img")).toBeNull()
    expect(cover.querySelector("svg")).toBeTruthy()
  })

  it("封面地址给了却加载不出来，也落回占位", async () => {
    await mountPage([story({ cover: "https://example.invalid/a.png" })])

    const cover = document.querySelector("li > div")!
    // 还没出错时占位不在场 —— 否则下面那一步验的就是个恒真的东西
    expect(cover.querySelector("[class*=lucide-image]")).toBeNull()

    cover.querySelector("img")!.dispatchEvent(new Event("error"))
    await flushPromises()

    // 外链会挂、会改 —— 碎图标比占位更糟
    expect(cover.querySelector("[class*=lucide-image]")).toBeTruthy()
  })

  it("次要动作压在封面上，不跟「新开始 / 读进度」抢同一行的宽度", async () => {
    await mountPage([story({ writable: true, scope: "mine", owner: "u1" })])

    const cover = document.querySelector("li > div")!
    // 编辑 + 删除两颗在封面那层里；抢回底边那一行就是改版前挤爆版式的那个形态
    expect(cover.querySelectorAll("button")).toHaveLength(2)
    // 底边那一行恒是两颗，且各占一半
    const actions = document.querySelector("li > div:last-child")!
    expect(actions.querySelectorAll("button")).toHaveLength(2)
    expect(cardButton("新开始")!.className).toContain("flex-1")
    expect(cardButton("读进度")!.className).toContain("flex-1")
  })

  it("「不可开局」「进行中」压在封面上 —— 扫一排封面时要一眼看见的就是这两条", async () => {
    await mountPage(
      [story({ playable: false })],
      {
        limit: 2,
        running: [
          {
            runId: "r1",
            saveId: "sv1",
            story: "rainy_inn",
            title: "雨夜客栈",
            elapsed: 12,
            epoch: 1
          }
        ]
      }
    )

    const cover = document.querySelector("li > div")!
    expect(cover.textContent).toContain("不可开局")
    expect(cover.textContent).toContain("进行中")
    // 在跑的那一局，主动作换成「回到这一局」（新开局这时也开不了）
    expect(cardButton("回到这一局")).toBeTruthy()
    expect(cardButton("新开始")).toBeUndefined()
  })
})

describe("故事库 · 卡内动作", () => {
  it("点「新开始」不会顺带跳进详情页 —— 卡内每个按钮都得 @click.stop", async () => {
    vi.mocked(saveApi.create).mockResolvedValue({ id: "sv1" } as never)
    await mountPage()

    cardButton("新开始")!.click()
    await flushPromises()

    expect(saveApi.create).toHaveBeenCalledWith("rainy_inn")
    // 整张卡可点（进详情），漏一个 .stop 就会既开局又跳走
    expect(push).not.toHaveBeenCalledWith("/galstory/stories/rainy_inn")
    expect(push).toHaveBeenCalledWith("/galstory/play/sv1")
  })

  it("点封面上的删除不会顺带跳进详情页", async () => {
    vi.mocked(storyApi.confirmHint).mockResolvedValue("还有 **2 份存档** 基于它")
    await mountPage([story({ writable: true, scope: "mine", owner: "u1" })])

    const remove = document.querySelector<HTMLElement>('li button[title="删除这个故事"]')!
    remove.click()
    await flushPromises()

    expect(storyApi.confirmHint).toHaveBeenCalledWith("rainy_inn")
    expect(push).not.toHaveBeenCalled()
  })

  it("确认框里那颗不是 AlertDialogAction —— 请求真的发得出去", async () => {
    vi.mocked(storyApi.confirmHint).mockResolvedValue("还有 **2 份存档** 基于它")
    vi.mocked(storyApi.remove).mockResolvedValue(undefined as never)
    await mountPage([story({ writable: true, scope: "mine", owner: "u1" })])

    const ask = document.querySelector<HTMLElement>('li button[title="删除这个故事"]')!
    ask.click()
    await flushPromises()

    // 引擎那句「有几个存档基于它」原样在框里，`**…**` 切段成 <strong>（不走 v-html）。
    // ⚠️ 判据取 `textContent` 而不是 `innerHTML`：模板注释也在 DOM 里，而它里面就写着 `**…**`
    const desc = document.querySelector("[data-slot=alert-dialog-description]")!
    expect(desc.textContent).toContain("2 份存档")
    expect(desc.textContent).not.toContain("**")
    expect(desc.querySelector("strong")!.textContent).toBe("2 份存档")

    const confirm = [
      ...document.querySelectorAll("[data-slot=alert-dialog-content] button")
    ].find((el) => el.textContent?.trim() === "删除") as HTMLElement
    confirm.click()
    await flushPromises()

    // `AlertDialogAction` 内部是 `DialogClose`：先关框、再跑 @click，而关闭会把 removing 清成
    // null —— 那时这一发根本发不出去，界面上看着像点了没反应
    expect(storyApi.remove).toHaveBeenCalledWith("rainy_inn")
  })
})
