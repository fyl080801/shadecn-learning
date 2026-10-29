import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, nextTick, shallowRef } from "vue"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { CREATABLE_NODE_TYPES, type GrowCandidate } from "@shadecn/shared/flow-node-types"

import FlowGrowMenu from "@/components/flow/FlowGrowMenu.vue"
import { ADDABLE_NODE_TYPES } from "@/components/flow/node-types"

/**
 * 「从出口长出新节点」的候选菜单：点出口加号 / 拉线到空白处松手时弹出（状态在 `useFlowCanvas`，那边测）。
 * 这里测菜单本身：只列给它的候选（图标 + 名字）、选一项交给 `growFromMenu`、一种都没有时给置灰的一条、Esc 关掉。
 */

interface MenuState {
  sourceId: string
  at: { x: number; y: number }
  reference: { getBoundingClientRect: () => DOMRect }
}

const growMenu = shallowRef<MenuState | null>(null)
const candidates = shallowRef<GrowCandidate[]>([])
const growFromMenu = vi.fn(async () => null)
const closeGrowMenu = vi.fn(() => {
  growMenu.value = null
})

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: {
      growMenu,
      growCandidates: computed(() => (growMenu.value ? candidates.value : [])),
      growFromMenu,
      closeGrowMenu
    }
  })
}))

const ports = { sourcePort: "image", targetPort: "image" }

function open(types: string[]) {
  candidates.value = types.map((type) => ({ type, ports }))
  growMenu.value = {
    sourceId: "dc",
    at: { x: 0, y: 0 },
    reference: { getBoundingClientRect: () => new DOMRect(300, 200, 0, 0) }
  }
}

const menu = () => document.body.querySelector('[data-testid="flow-grow-menu"]')
const items = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="flow-grow-menu"] [role="menuitem"]')]

let wrapper: VueWrapper | null = null

beforeEach(() => {
  growMenu.value = null
  candidates.value = []
  growFromMenu.mockClear()
  closeGrowMenu.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe("候选类型菜单", () => {
  it("没打开时不渲染任何东西", async () => {
    wrapper = mount(FlowGrowMenu, { attachTo: document.body })
    await nextTick()
    expect(menu()).toBeNull()
  })

  it("打开：只列给它的候选，每项是注册表里的名字（带图标）；选一项交给 growFromMenu", async () => {
    wrapper = mount(FlowGrowMenu, { attachTo: document.body })
    open(["image", "video"])
    await flushPromises()

    expect(menu()).not.toBeNull()
    expect(items().map((item) => [item.dataset.nodeType, item.textContent?.trim()])).toEqual([
      ["image", "图片"],
      ["video", "视频"]
    ])
    expect(items().every((item) => item.querySelector("svg"))).toBe(true)

    items()[1]!.click()
    await flushPromises()
    expect(growFromMenu).toHaveBeenCalledTimes(1)
    expect(growFromMenu).toHaveBeenCalledWith("video")
  })

  it("一种都连不上：给一条置灰的「没有可连接的节点」，不是什么都不弹", async () => {
    wrapper = mount(FlowGrowMenu, { attachTo: document.body })
    open([])
    await flushPromises()

    const [only] = items()
    expect(items()).toHaveLength(1)
    expect(only!.textContent?.trim()).toBe("没有可连接的节点")
    expect(only!.hasAttribute("data-disabled")).toBe(true)
    only!.click()
    expect(growFromMenu).not.toHaveBeenCalled()
  })

  it("Esc 关掉菜单，什么都不建", async () => {
    wrapper = mount(FlowGrowMenu, { attachTo: document.body })
    open(["image"])
    await flushPromises()

    document.body.querySelector<HTMLElement>('[data-testid="flow-grow-menu"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
    await flushPromises()
    expect(closeGrowMenu).toHaveBeenCalled()
    expect(growFromMenu).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })
})

describe("工具栏「添加节点」菜单", () => {
  it("只有 文本 / 图片 / 视频 / 导演台，按这个顺序（和 agent 能建的同一份）", () => {
    expect(ADDABLE_NODE_TYPES.map((def) => def.type)).toEqual([...CREATABLE_NODE_TYPES])
    expect(ADDABLE_NODE_TYPES.map((def) => def.label)).toEqual(["文本", "图片", "视频", "导演台"])
  })
})
