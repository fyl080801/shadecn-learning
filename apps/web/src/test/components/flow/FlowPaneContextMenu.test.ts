import { afterEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref } from "vue"

const addNode = vi.fn(async () => "n1")
const addNodesFromFiles = vi.fn(async () => {})

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({ canvas: { addNode }, store: {}, flowId: ref("f1") })
}))
vi.mock("@/components/flow/file-nodes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/flow/file-nodes")>()),
  addNodesFromFiles: (...args: unknown[]) => addNodesFromFiles(...(args as []))
}))

const { default: FlowPaneContextMenu } = await import("@/components/flow/FlowPaneContextMenu.vue")

/** 画布的简化替身：一块空白（pane）里放一个节点 */
const Canvas = defineComponent(() => () =>
  h(FlowPaneContextMenu, null, () =>
    h("div", { class: "vue-flow__pane", "data-testid": "pane" }, [
      h("div", { class: "vue-flow__node", "data-testid": "node" }, [h("span", { "data-testid": "node-inner" })])
    ])
  )
)

function rightClick(el: Element, x = 120, y = 80) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y })
  el.dispatchEvent(event)
  return event
}

const menu = () => document.body.querySelector('[data-testid="flow-pane-context-menu"]')

afterEach(() => {
  document.body.innerHTML = ""
  addNode.mockClear()
  addNodesFromFiles.mockClear()
})

describe("FlowPaneContextMenu", () => {
  it("空白处右键：弹出「添加 / 上传」，并拦下浏览器原生菜单", async () => {
    const wrapper = mount(Canvas, { attachTo: document.body })
    const event = rightClick(wrapper.get('[data-testid="pane"]').element)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(menu()?.textContent).toContain("添加")
    expect(menu()?.textContent).toContain("上传")
    wrapper.unmount()
  })

  it("节点上右键：不弹菜单，也不拦原生菜单", async () => {
    const wrapper = mount(Canvas, { attachTo: document.body })
    const event = rightClick(wrapper.get('[data-testid="node-inner"]').element)
    await flushPromises()

    expect(event.defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
    wrapper.unmount()
  })

  it("「上传」打开文件选择框，选中的文件以右键那一点为落点建节点", async () => {
    const wrapper = mount(Canvas, { attachTo: document.body })
    rightClick(wrapper.get('[data-testid="pane"]').element, 300, 200)
    await flushPromises()

    const input = wrapper.get<HTMLInputElement>('[data-testid="flow-pane-upload-input"]').element
    const click = vi.spyOn(input, "click").mockImplementation(() => {})
    const upload = document.body.querySelector<HTMLElement>('[data-testid="flow-pane-upload"]')!
    upload.click()
    await nextTick()
    expect(click).toHaveBeenCalled()

    const file = new File(["x"], "a.png", { type: "image/png" })
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    input.dispatchEvent(new Event("change"))
    expect(addNodesFromFiles).toHaveBeenCalledWith(expect.anything(), [file], { x: 300, y: 200 })
    wrapper.unmount()
  })
})
