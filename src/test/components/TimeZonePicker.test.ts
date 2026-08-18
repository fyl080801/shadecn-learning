import { describe, expect, it } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import TimeZonePicker from "@/components/settings/TimeZonePicker.vue"

/**
 * 时区下拉。四百多条时区靠滚是找不到的，这里守的就是「能打关键字」：
 * 没输入时只摆常用的几个，输入后才在全量里搜。
 */

function openPanel() {
  const wrapper = mount(TimeZonePicker, {
    props: { modelValue: "auto" },
    attachTo: document.body
  })
  return wrapper
}

async function type(text: string) {
  const input = document.body.querySelector("input")!
  input.value = text
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await flushPromises()
}

describe("时区选择器", () => {
  it("按钮上显示当前选择；auto 显示成「跟随浏览器」", () => {
    const wrapper = mount(TimeZonePicker, { props: { modelValue: "auto" } })
    expect(wrapper.text()).toContain("跟随浏览器")

    const picked = mount(TimeZonePicker, { props: { modelValue: "Asia/Tokyo" } })
    expect(picked.text()).toContain("Asia/Tokyo")
  })

  it("刚打开只列常用时区，不是一屏 Africa/…", async () => {
    const wrapper = openPanel()
    await wrapper.get("button").trigger("click")
    await flushPromises()

    const text = document.body.textContent ?? ""
    expect(text).toContain("Asia/Shanghai")
    expect(text).toContain("输入关键字可搜索全部")
    expect(text).not.toContain("Africa/Abidjan")
  })

  it("输入关键字在全量里搜：英文名、中文别名、GMT 偏移都认", async () => {
    const wrapper = openPanel()
    await wrapper.get("button").trigger("click")
    await flushPromises()

    await type("abidjan")
    expect(document.body.textContent).toContain("Africa/Abidjan")

    await type("上海")
    expect(document.body.textContent).toContain("Asia/Shanghai")

    await type("los angeles")
    expect(document.body.textContent).toContain("America/Los_Angeles")
  })

  it("搜偏移时常用时区排在前面，不是南极科考站", async () => {
    const wrapper = openPanel()
    await wrapper.get("button").trigger("click")
    await flushPromises()

    await type("+8")
    const first = document.body.querySelector("[data-slot=command-item]")
    // 技术上 Antarctica/Casey 也是 GMT+8，但没人想要它
    expect(first?.textContent).toContain("Asia/Shanghai")
  })

  it("存了个 Intl 不认的时区，显示的是「跟随浏览器」而不是那个坏值", async () => {
    // 坏值会被格式化那边退回跟随浏览器；按钮要是照原值显示，
    // 就成了「按钮写着某时区、时间却按本机走」，看不出哪里不对
    const wrapper = mount(TimeZonePicker, { props: { modelValue: "Mars/Olympus" } })
    expect(wrapper.text()).not.toContain("Mars/Olympus")
    expect(wrapper.text()).toContain("跟随浏览器")
  })

  it("面板里常驻一行当前值，搜索把选中项过滤掉了也还看得见", async () => {
    const wrapper = mount(TimeZonePicker, {
      props: { modelValue: "Asia/Tokyo" },
      attachTo: document.body
    })
    await wrapper.get("button").trigger("click")
    await flushPromises()

    await type("london")
    const current = document.body.querySelector("[data-testid=tz-current]")
    expect(current?.textContent).toContain("Asia/Tokyo")
  })

  it("搜不到就直说，不是留个空面板", async () => {
    const wrapper = openPanel()
    await wrapper.get("button").trigger("click")
    await flushPromises()

    await type("这个时区不存在")
    expect(document.body.textContent).toContain("没有匹配的时区")
  })
})
