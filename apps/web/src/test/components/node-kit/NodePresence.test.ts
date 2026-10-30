import { afterEach, describe, expect, it, vi } from "vitest"
import { computed, defineComponent, h, provide, ref } from "vue"
import { mount, type VueWrapper } from "@vue/test-utils"
import type { AgentActiveRunView } from "@shadecn/shared/agent"

import NodePresence from "@/components/flow/node-kit/NodePresence.vue"
import { NODE_PART_KEY } from "@/components/flow/node-kit/context"

/**
 * 节点上的 agent 占用标签（docs/20 §3.4、§3.10.8）：来源是任务列表上的 `occupies`；团队画布「某某的助手」
 * （自己的「我的助手」），个人画布只说「助手」；点它打开那一轮所在的会话。不在面板子树里（没 provide）就没有标签。
 */

const runs = ref<AgentActiveRunView[]>([])
const showOwners = ref(true)
const showConversation = vi.fn()
let withPanel = true

vi.mock("@/composables/flow/agent-panel", () => ({
  useOptionalFlowAgentPanel: () =>
    withPanel ? { agent: { activeRuns: computed(() => runs.value), showOwners }, showConversation } : null
}))

function run(overrides: Partial<AgentActiveRunView>): AgentActiveRunView {
  return {
    runId: "r1",
    conversationId: "c1",
    conversationTitle: "t",
    owner: { id: "u2", name: "张三", avatarUrl: null },
    startedAt: 1,
    mine: false,
    occupies: [],
    ...overrides
  }
}

let wrapper: VueWrapper | null = null
function mountFor(id: string) {
  const Root = defineComponent({
    setup() {
      provide(NODE_PART_KEY, { id, editor: { presence: { occupantsOf: () => [] } } } as never)
      return () => h(NodePresence)
    }
  })
  wrapper = mount(Root)
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  runs.value = []
  showOwners.value = true
  withPanel = true
  showConversation.mockReset()
})

const tags = (w: VueWrapper) => w.findAll('[data-testid="node-agent-tag"]').map((item) => item.text())

describe("节点上的 agent 占用标签", () => {
  it("occupies 含这个节点的那一轮贴「某某的助手」，别的节点不贴；入口 nodeId 不算占用", async () => {
    runs.value = [
      run({ runId: "r1", occupies: ["n1", "n2"] }),
      run({ runId: "r2", conversationId: "c2", owner: { id: "me", name: "我自己", avatarUrl: null }, mine: true, occupies: ["n3"] }),
      run({ runId: "r3", conversationId: "c3", nodeId: "n1" })
    ]
    expect(tags(mountFor("n1"))).toEqual(["张三的助手"])
    wrapper!.unmount()
    expect(tags(mountFor("n3"))).toEqual(["我的助手"])
    wrapper!.unmount()
    expect(tags(mountFor("n9"))).toEqual([])
  })

  it("个人画布只说「助手」；点标签打开那一轮所在的会话", async () => {
    showOwners.value = false
    runs.value = [run({ occupies: ["n1"], conversationId: "c-held" })]
    const w = mountFor("n1")
    expect(tags(w)).toEqual(["助手"])
    await w.find('[data-testid="node-agent-tag"]').trigger("click")
    expect(showConversation).toHaveBeenCalledWith("c-held")
  })

  it("任务列表变了（离开 / 占用变化）标签跟着变", async () => {
    runs.value = [run({ occupies: ["n1"] })]
    const w = mountFor("n1")
    expect(tags(w)).toHaveLength(1)
    runs.value = []
    await w.vm.$nextTick()
    expect(tags(w)).toEqual([])
  })

  it("不在 agent 面板子树里：没有标签，也不报错", () => {
    withPanel = false
    runs.value = [run({ occupies: ["n1"] })]
    expect(tags(mountFor("n1"))).toEqual([])
  })
})
