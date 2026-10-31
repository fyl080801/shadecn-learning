import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, ref } from "vue"
import { flushPromises, mount } from "@vue/test-utils"
import AssetImage from "@/components/flow/AssetImage.vue"
import { provideAssetBackfill, resetAssetBackfill } from "@/components/flow/asset-backfill"
import { flowApi } from "@/lib/api"

vi.mock("@/lib/api", () => ({ flowApi: { backfillAssetVariants: vi.fn() } }))

/** 按档显示资源图（docs/27 §4）：推得出档位先取缩略图，失败退回原图，原图也失败才往外报错 */

const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const original = `https://s3.test/bucket/canvas/assets/3f/a8/${id}.png`
const low = `https://s3.test/bucket/canvas/assets/3f/a8/${id}@low.webp`

describe("AssetImage", () => {
  it("我们的素材地址 + 档位 → 先加载那一档；其余属性落在 <img> 上", () => {
    const wrapper = mount(AssetImage, { props: { src: original, size: "low" }, attrs: { alt: "猫", class: "w-full" } })
    const img = wrapper.find("img")
    expect(img.attributes("src")).toBe(low)
    expect(img.attributes("alt")).toBe("猫")
    expect(img.classes()).toContain("w-full")
    expect(img.attributes("data-asset-size")).toBe("low")
  })

  it("缩略图加载失败 → 退回原图，不往外报错；原图再失败才报", async () => {
    const wrapper = mount(AssetImage, { props: { src: original, size: "icon" } })
    await wrapper.find("img").trigger("error")
    expect(wrapper.find("img").attributes("src")).toBe(original)
    expect(wrapper.emitted("error")).toBeUndefined()

    await wrapper.find("img").trigger("error")
    expect(wrapper.emitted("error")).toHaveLength(1)
  })

  it("换了图就重新先试缩略图", async () => {
    const wrapper = mount(AssetImage, { props: { src: original, size: "low" } })
    await wrapper.find("img").trigger("error")
    const next = original.replace("3fa85f64", "3fa8aaaa")
    await wrapper.setProps({ src: next })
    expect(wrapper.find("img").attributes("src")).toBe(next.replace(".png", "@low.webp"))
  })

  it("外部链接、blob: 本地预览、原图档 → 直接用原图", () => {
    for (const [src, size] of [
      ["https://example.com/a.png", "low"],
      ["blob:http://localhost/abc", "icon"],
      [original, "original"]
    ] as const) {
      expect(mount(AssetImage, { props: { src, size } }).find("img").attributes("src")).toBe(src)
    }
  })

  it("load 原样往外发", async () => {
    const wrapper = mount(AssetImage, { props: { src: original, size: "low" } })
    await wrapper.find("img").trigger("load")
    expect(wrapper.emitted("load")).toHaveLength(1)
  })
})

describe("AssetImage 补缩略图（docs/27 §3.3）", () => {
  const icon = original.replace(".png", "@icon.webp")

  function mountWithBackfill(backfill: ReturnType<typeof vi.fn>, props: { src: string; size: "icon" | "low" }) {
    vi.mocked(flowApi.backfillAssetVariants).mockImplementation(backfill as never)
    const Host = defineComponent({
      setup() {
        provideAssetBackfill(ref("flow-1"))
        return () => h(AssetImage, props)
      }
    })
    return mount(Host)
  }

  beforeEach(() => {
    resetAssetBackfill()
    vi.mocked(flowApi.backfillAssetVariants).mockReset()
  })

  it("档位 404 → 先退回原图，同时请服务端补；补出来了就换回缩略图", async () => {
    const backfill = vi.fn(async () => ({ variants: ["icon", "low"] }))
    const wrapper = mountWithBackfill(backfill, { src: original, size: "low" })

    await wrapper.find("img").trigger("error")
    expect(wrapper.find("img").attributes("src")).toBe(original)
    expect(backfill).toHaveBeenCalledWith("flow-1", original)

    await flushPromises()
    expect(wrapper.find("img").attributes("src")).toBe(low)
  })

  it("补不出来 → 一直用原图；同一张图整页只问一次", async () => {
    const backfill = vi.fn(async () => ({ variants: [] }))
    const a = mountWithBackfill(backfill, { src: original, size: "low" })
    const b = mountWithBackfill(backfill, { src: original, size: "icon" })

    await a.find("img").trigger("error")
    await b.find("img").trigger("error")
    await flushPromises()
    expect(a.find("img").attributes("src")).toBe(original)
    expect(b.find("img").attributes("src")).toBe(original)
    expect(backfill).toHaveBeenCalledTimes(1)
  })

  it("服务端说有、浏览器还是加载失败 → 只换回去试一次，不来回换", async () => {
    const backfill = vi.fn(async () => ({ variants: ["icon", "low"] }))
    const wrapper = mountWithBackfill(backfill, { src: original, size: "icon" })

    await wrapper.find("img").trigger("error")
    await flushPromises()
    expect(wrapper.find("img").attributes("src")).toBe(icon)

    await wrapper.find("img").trigger("error")
    await flushPromises()
    expect(wrapper.find("img").attributes("src")).toBe(original)
  })

  it("请求失败（网络 / 5xx）不记住，下次遇到 404 再问", async () => {
    const backfill = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ variants: [] })
    const a = mountWithBackfill(backfill, { src: original, size: "low" })
    await a.find("img").trigger("error")
    await flushPromises()

    const b = mountWithBackfill(backfill, { src: original, size: "low" })
    await b.find("img").trigger("error")
    await flushPromises()
    expect(backfill).toHaveBeenCalledTimes(2)
  })

  it("推不出档位的地址（外部链接）加载失败 → 不补", async () => {
    const backfill = vi.fn(async () => ({ variants: [] }))
    const a = mountWithBackfill(backfill, { src: "https://example.com/a.png", size: "low" })
    await a.find("img").trigger("error")
    expect(backfill).not.toHaveBeenCalled()
  })

  it("编辑器之外（没有提供补档）→ 照常退回原图，不发请求", async () => {
    const wrapper = mount(AssetImage, { props: { src: original, size: "low" } })
    await wrapper.find("img").trigger("error")
    expect(wrapper.find("img").attributes("src")).toBe(original)
    expect(flowApi.backfillAssetVariants).not.toHaveBeenCalled()
  })
})
