import { afterEach, describe, expect, it, vi } from "vitest"
import { computed, defineComponent, h, provide, ref } from "vue"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import type { AppTaskView } from "@shadecn/shared/apps"
import FlowAppTasksButton from "@/components/flow/apps/FlowAppTasksButton.vue"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FLOW_APP_TASKS_KEY, type FlowAppTasks } from "@/composables/flow/useFlowAppTasks"

/**
 * 右上角的「生成任务」按钮（docs/29 §3.10）：和对话按钮分开；有任务时转环 + 计数，
 * 点开浮层列出进行中的任务（应用 · 节点名、状态 / 进度），点一行定位到节点，发起人能取消。
 * 任务列表用假的那一份（真的在 app-run.test.ts 里测），编辑器上下文打桩。
 */

const revealNode = vi.fn(() => Promise.resolve())
vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({
    canvas: { revealNode },
    store: {
      meta: { id: "flow-1", mode: "collab" },
      nodeById: new Map([["n_vid", { metadata: { label: "海浪" } }]])
    }
  })
}))
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: ref({ id: "me", name: "我" }) }) }))

function task(overrides: Partial<AppTaskView> = {}): AppTaskView {
  return {
    id: "t1",
    flowId: "flow-1",
    nodeId: "n_vid",
    appId: "seedance",
    appTitle: "视频生成",
    status: "running",
    progress: { status: "running", ratio: 0.42 },
    owner: { id: "me", name: "我", avatarUrl: null },
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides
  }
}

let wrapper: VueWrapper | null = null

function mountButton(list: AppTaskView[]) {
  const tasks = ref(list)
  const cancel = vi.fn()
  const fake: FlowAppTasks = {
    tasks: computed(() => tasks.value),
    taskOf: (id) => tasks.value.find((item) => item.id === id),
    upsert: vi.fn(),
    canCancel: (item) => item.owner.id === "me",
    cancel,
    isCancelling: () => false,
    taskOn: () => undefined,
    isGenerating: () => false,
    markSubmitting: () => () => {}
  }
  wrapper = mount(
    defineComponent({
      setup() {
        provide(FLOW_APP_TASKS_KEY, fake)
        return () => h(TooltipProvider, null, () => h(FlowAppTasksButton))
      }
    }),
    { attachTo: document.body }
  )
  return { tasks, cancel }
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function open() {
  await wrapper!.get('[data-testid="app-tasks-toggle"]').trigger("click")
  await flushPromises()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  revealNode.mockClear()
})

describe("生成任务按钮", () => {
  it("没有任务：不转环、不挂计数；点开是空状态", async () => {
    mountButton([])
    expect(wrapper!.find('[data-testid="app-tasks-ring"]').exists()).toBe(false)
    expect(wrapper!.find('[data-testid="app-tasks-count"]').exists()).toBe(false)
    await open()
    expect(byTestId("app-tasks-empty")?.textContent).toContain("没有进行中的生成任务")
  })

  it("有任务：转环 + 计数；浮层里一行一个任务：应用 · 节点名、状态 / 进度", async () => {
    const { tasks } = mountButton([task(), task({ id: "t2", status: "queued", progress: undefined, nodeId: "gone" })])
    expect(wrapper!.find('[data-testid="app-tasks-ring"]').exists()).toBe(true)
    expect(wrapper!.get('[data-testid="app-tasks-count"]').text()).toBe("2")
    expect(wrapper!.get('[data-testid="app-tasks-toggle"]').attributes("aria-label")).toBe("生成任务（2 个进行中）")

    await open()
    const rows = [...document.body.querySelectorAll<HTMLElement>('[data-testid="app-tasks-list"] [data-task-id]')]
    expect(rows.map((row) => row.querySelector('[data-role="reveal"]')!.textContent!.replace(/\s+/g, " ").trim())).toEqual([
      "视频生成 · 海浪",
      "视频生成"
    ])
    expect(rows.map((row) => row.querySelector('[data-role="status"]')!.textContent)).toEqual(["生成中 42%", "排队中"])
    expect(rows[0]!.querySelector('[role="progressbar"]')).not.toBeNull()

    // 推送来了：整份替换，列表跟着变
    tasks.value = [task({ progress: { status: "running", ratio: 0.9 } })]
    await flushPromises()
    expect(document.body.querySelector('[data-role="status"]')!.textContent).toBe("生成中 90%")
  })

  it("点一行定位到节点；发起人那行有取消，别人的没有", async () => {
    const { cancel } = mountButton([task(), task({ id: "t2", owner: { id: "other", name: "别人", avatarUrl: null } })])
    await open()
    const rows = [...document.body.querySelectorAll<HTMLElement>("[data-task-id]")]
    rows[0]!.querySelector<HTMLElement>('[data-role="reveal"]')!.click()
    expect(revealNode).toHaveBeenCalledWith("n_vid")

    expect(rows[1]!.querySelector('[data-role="cancel"]')).toBeNull()
    rows[0]!.querySelector<HTMLElement>('[data-role="cancel"]')!.click()
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }))
    // 点了还开着（接着看别的任务）
    expect(byTestId("app-tasks-panel")).not.toBeNull()
  })
})
