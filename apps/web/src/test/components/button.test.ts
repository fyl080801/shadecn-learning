import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"

import { Button } from "@/components/ui/button"

/**
 * Button 比 shadcn-vue CLI 生成的版本多一个 `loading` —— 防连点的**视觉**那一半
 * （真正的守卫在 `useAsyncAction` 里）。重新 `shadcn-vue add button` 会把它冲掉，
 * 这几条用例就是用来发现那件事的。
 */

describe("Button 的 loading", () => {
  it("loading 时禁用并转圈", () => {
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: "创建" } })

    expect(wrapper.attributes("disabled")).toBeDefined()
    expect(wrapper.attributes("aria-busy")).toBe("true")
    expect(wrapper.find("svg.animate-spin").exists()).toBe(true)
    expect(wrapper.text()).toContain("创建")
  })

  it("不 loading 时既不禁用也不转圈", () => {
    const wrapper = mount(Button, { slots: { default: "创建" } })

    expect(wrapper.attributes("disabled")).toBeUndefined()
    expect(wrapper.attributes("aria-busy")).toBeUndefined()
    expect(wrapper.find("svg.animate-spin").exists()).toBe(false)
  })

  it("disabled=false 不能渲染成 disabled 属性 —— HTML 里有这个属性就是禁用", () => {
    const wrapper = mount(Button, { props: { disabled: false }, slots: { default: "创建" } })

    expect(wrapper.attributes("disabled")).toBeUndefined()
    expect((wrapper.element as HTMLButtonElement).disabled).toBe(false)
  })

  it("disabled 照旧生效", () => {
    const wrapper = mount(Button, { props: { disabled: true }, slots: { default: "创建" } })

    expect((wrapper.element as HTMLButtonElement).disabled).toBe(true)
  })
})
