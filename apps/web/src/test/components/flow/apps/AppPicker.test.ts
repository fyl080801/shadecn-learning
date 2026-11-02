import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref, shallowRef } from "vue"
import { mount } from "@vue/test-utils"
import type { AppInfo } from "@shadecn/shared/apps"

import AppPicker from "@/components/flow/apps/AppPicker.vue"

/**
 * 应用选择器（docs/29 §3.8）：一个应用就是一个模型，只有一级下拉。
 * 下拉换成透传的桩：jsdom 里 reka-ui 的 Select 打不开，这里要看的是「列了哪些项」和「选了写什么」。
 */
const node = vi.hoisted(() => ({ data: null as unknown as { value: Record<string, unknown> }, write: vi.fn() }))
const appsState = vi.hoisted(() => ({ apps: null as unknown as { value: AppInfo[] } }))
const nodeType = vi.hoisted(() => ({ value: "image" }))

vi.mock("@/components/flow/node-kit/context", () => ({
  useNodePart: () => ({
    get type() {
      return nodeType.value
    },
    node
  })
}))
vi.mock("@/composables/useApps", () => ({ useApps: () => ({ apps: appsState.apps, loading: ref(false) }) }))
vi.mock("@/components/flow/apps/SizePicker.vue", () => ({
  default: defineComponent({
    props: { name: String },
    setup: (props) => () => h("div", { "data-testid": "size-picker" }, props.name)
  })
}))
vi.mock("@/components/ui/select", () => {
  const slot = (tag: string, attrs: Record<string, unknown> = {}) =>
    defineComponent({ inheritAttrs: false, setup: (_props, { slots, attrs: rest }) => () => h(tag, { ...attrs, ...rest }, slots.default?.()) })
  return {
    Select: defineComponent({
      props: { modelValue: String },
      emits: ["update:modelValue"],
      setup: (props, { slots, emit }) => () =>
        h("div", { "data-testid": "select", "data-value": props.modelValue, onPick: (event: CustomEvent) => emit("update:modelValue", event.detail) }, slots.default?.())
    }),
    SelectTrigger: slot("button"),
    SelectValue: slot("span"),
    SelectContent: slot("ul"),
    SelectItem: defineComponent({
      inheritAttrs: false,
      props: { value: String, disabled: Boolean },
      setup: (props, { slots, attrs }) => () =>
        h("li", { ...attrs, "data-testid": "select-item", "data-value": props.value, "data-disabled": props.disabled }, slots.default?.())
    })
  }
})

const PRO: AppInfo = {
  id: "ark:pro",
  title: "Seedream 5.0 pro",
  description: "文生图",
  category: "image",
  driver: "ark",
  model: "pro",
  params: { prompt: { type: "string" }, size: { type: "size", tiers: ["2K"] } }
}
const FLASH: AppInfo = { ...PRO, id: "ark:flash", title: "Seedream 5.0 flash", model: "flash", params: { prompt: { type: "string" } } }
const BROKEN: AppInfo = { ...PRO, id: "ark:broken", title: "坏的", unavailable: "ARK_API_KEY 没有设置" }
const VIDEO: AppInfo = { ...PRO, id: "ark:seedance", title: "Seedance", category: "video" }

let wrapper: ReturnType<typeof mount> | null = null

async function render(apps: AppInfo[], data: Record<string, unknown> = {}) {
  appsState.apps = shallowRef(apps)
  node.data = ref(data)
  wrapper = mount(AppPicker, { attachTo: document.body })
  await nextTick()
  return wrapper
}

beforeEach(() => {
  nodeType.value = "image"
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.clearAllMocks()
})

describe("AppPicker", () => {
  it("只有一个下拉，没有第二级；列本类别全部应用，不可用的置灰带原因，提示带模型", async () => {
    const w = await render([BROKEN, PRO, FLASH, VIDEO])
    expect(w.findAll('[data-testid="select"]')).toHaveLength(1)
    expect(w.find('[data-testid="app-picker-model"]').exists()).toBe(false)
    const items = w.findAll('[data-testid="select-item"]')
    expect(items.map((item) => item.text())).toEqual(["坏的", "Seedream 5.0 pro", "Seedream 5.0 flash"])
    expect(items[0]!.attributes("data-disabled")).toBe("true")
    expect(items[0]!.attributes("title")).toBe("ARK_API_KEY 没有设置")
    expect(items[1]!.attributes("data-disabled")).toBe("false")
    expect(items[1]!.attributes("title")).toBe("文生图 · pro")
  })

  it("没选：第一个可用的；读的一侧不回写", async () => {
    const w = await render([BROKEN, PRO, FLASH])
    expect(w.get('[data-testid="select"]').attributes("data-value")).toBe(PRO.id)
    expect(node.write).not.toHaveBeenCalled()
  })

  it("选一个：只写 appId，一次；选当前这个不写", async () => {
    const w = await render([PRO, FLASH], { appId: PRO.id })
    const select = w.get('[data-testid="select"]')
    select.element.dispatchEvent(new CustomEvent("pick", { detail: PRO.id }))
    expect(node.write).not.toHaveBeenCalled()
    select.element.dispatchEvent(new CustomEvent("pick", { detail: FLASH.id }))
    expect(node.write).toHaveBeenCalledTimes(1)
    expect(node.write).toHaveBeenCalledWith("data", { set: { appId: FLASH.id } }, "选择生成应用")
  })

  it("所选应用有 size 参数才有尺寸按钮", async () => {
    const withSize = await render([PRO, FLASH], { appId: PRO.id })
    expect(withSize.find('[data-testid="size-picker"]').exists()).toBe(true)
    withSize.unmount()
    const without = await render([PRO, FLASH], { appId: FLASH.id })
    expect(without.find('[data-testid="size-picker"]').exists()).toBe(false)
  })

  it("所选应用不可用：旁边一句原因；一个应用都没有：只有一句说明", async () => {
    const broken = await render([BROKEN], { appId: BROKEN.id })
    expect(broken.get('[data-testid="app-picker-hint"]').text()).toBe("ARK_API_KEY 没有设置")
    broken.unmount()
    const none = await render([])
    expect(none.get('[data-testid="app-picker-empty"]').text()).toBe("服务端还没有配置生成应用")
    expect(none.find('[data-testid="select"]').exists()).toBe(false)
  })
})
