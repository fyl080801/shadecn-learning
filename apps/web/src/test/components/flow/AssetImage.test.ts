import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import AssetImage from "@/components/flow/AssetImage.vue"

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
