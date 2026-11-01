import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { ref } from "vue"
import type { ParamSpec } from "@shadecn/shared/apps"

import SizePicker from "@/components/flow/apps/SizePicker.vue"

/**
 * 尺寸弹出框（docs/29 §3.9）：按参数说明（档位 / 常用宽高表 / 范围）渲染，选了写进节点的 `data["appParam.size"]`。
 * 节点上下文打桩成一份可写的 data；弹出框是真的 reka-ui Popover（内容 teleport 到 body）。
 */

const data = ref<Record<string, unknown>>({})
const write = vi.fn((_group: string, changes: { set?: Record<string, unknown>; remove?: string[] }) => {
  const next = { ...data.value, ...changes.set }
  for (const key of changes.remove ?? []) delete next[key]
  data.value = next
})

vi.mock("@/components/flow/node-kit/context", () => ({
  useNodePart: () => ({ node: { data, write } })
}))

const SPEC: ParamSpec = {
  type: "size",
  default: "2K",
  tiers: ["1K", "1.5K", "2K"],
  minPixels: 921600,
  maxPixels: 4624220,
  maxAspect: 16,
  presets: {
    "1:1": ["1024x1024", "1536x1536", "2048x2048"],
    "16:9": ["1424x800", "2048x1152", "2816x1584"],
    "21:9": ["1568x672", "2352x1008", "3136x1344"]
  }
}

let wrapper: VueWrapper | null = null

function mountPicker() {
  wrapper = mount(SizePicker, { props: { name: "size", spec: SPEC }, attachTo: document.body })
  return wrapper
}

const panel = () => document.body.querySelector('[data-testid="size-picker-panel"]')
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

async function openPanel(w: VueWrapper) {
  await w.get('[data-testid="size-picker"]').trigger("click")
  await flushPromises()
  expect(panel()).not.toBeNull()
}

beforeEach(() => {
  data.value = {}
  write.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ""
})

describe("SizePicker", () => {
  it("没设过：按钮显示默认（2K · 自动比例），面板里 2K、自动是选中的；没有自定义宽高", async () => {
    const w = mountPicker()
    expect(w.get('[data-testid="size-picker"]').text()).toBe("2K · 自动比例")
    await openPanel(w)
    expect(byTestId("size-tier-2K").className).toMatch(/bg-primary/)
    expect(byTestId("size-ratio-auto").className).toMatch(/border-primary/)
    // 比例按钮上只有比例，不显示宽高
    expect(byTestId("size-ratio-16:9").textContent?.trim()).toBe("16:9")
    expect(panel()!.textContent).not.toContain("自定义")
    expect(panel()!.querySelector("input")).toBeNull()
  })

  it("选比例 → 写这一档的参考宽高；换分辨率 → 同一比例的另一档；回到「自动」= 只传档位", async () => {
    const w = mountPicker()
    await openPanel(w)
    byTestId("size-ratio-16:9").click()
    await flushPromises()
    expect(data.value["appParam.size"]).toBe("2816x1584")
    byTestId("size-tier-1K").click()
    await flushPromises()
    expect(data.value["appParam.size"]).toBe("1424x800")
    expect(w.get('[data-testid="size-picker"]').text()).toBe("16:9 · 1K")
    byTestId("size-ratio-auto").click()
    await flushPromises()
    expect(data.value["appParam.size"]).toBe("1K")
  })

  it("节点上已存了别的档位的宽高：打开时落到那一档那一格", async () => {
    data.value = { "appParam.size": "1424x800" }
    const w = mountPicker()
    expect(w.get('[data-testid="size-picker"]').text()).toBe("16:9 · 1K")
    await openPanel(w)
    expect(byTestId("size-tier-1K").className).toMatch(/bg-primary/)
    byTestId("size-ratio-1:1").click()
    await flushPromises()
    expect(data.value["appParam.size"]).toBe("1024x1024")
  })

  it("节点上存的值不合这个模型（换了模型）：按钮显示默认并标红；面板没有底栏（当前值 / 恢复默认）", async () => {
    data.value = { "appParam.size": "4096x4096" }
    const w = mountPicker()
    const button = w.get('[data-testid="size-picker"]')
    expect(button.text()).toBe("2K · 自动比例")
    expect(button.attributes("aria-invalid")).toBe("true")
    await openPanel(w)
    expect(panel()!.textContent).not.toContain("当前")
    expect(document.body.querySelector('[data-testid="size-reset"]')).toBeNull()
  })

})
