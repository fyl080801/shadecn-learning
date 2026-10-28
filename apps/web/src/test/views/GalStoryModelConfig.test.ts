import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import ModelConfig from "@/views/galstory/ModelConfig.vue"
import { GalStoryError, configApi } from "@/lib/galstory"
import type { Binding, Connection, ModelConfig as ModelConfigView, Preset } from "@/types/galstory"

/**
 * 模型配置页的删除确认。守两条，都是 reka-ui 那个坑的两个面：
 *
 *   1. `AlertDialogAction` 内部就是 `DialogClose` —— **先关框、再**跑透传下来的 `@click`，
 *      而那句关闭不看 `event.defaultPrevented`（`@click.prevent` 挡不住）。开关与「删哪一个」
 *      共用一个 ref 的话，handler 读到的是被关闭清掉的 null，请求一声不响地发不出去；
 *   2. 这一页的删除是**两段式**：第一次不带 `force`，引擎回 409 并说清「谁还指着它」，
 *      那句话必须**留在框里**给人看 —— 用 `AlertDialogAction` 的话框已经被它关掉了。
 */

vi.mock("@/lib/galstory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/galstory")>()
  return {
    ...actual,
    configApi: {
      get: vi.fn(),
      patch: vi.fn(),
      upsertConnection: vi.fn(),
      upsertPreset: vi.fn(),
      upsertAgent: vi.fn(),
      deleteConnection: vi.fn(),
      deletePreset: vi.fn(),
      deleteAgent: vi.fn()
    }
  }
})

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

function connection(id: string): Connection {
  return {
    id,
    provider: "openai_compatible",
    model: "qwen3",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    timeoutS: 40,
    maxRetries: 2,
    contextWindow: 32768,
    commitWatermark: 0.7,
    reasoning: "off",
    reasoningEffort: "",
    thinkingDisabled: true,
    toolCall: true,
    stream: false,
    idleTimeoutS: null,
    chunkTimeoutS: 10,
    maxOutputTokens: 125000,
    maxCallSeconds: 1800,
    streamUsage: true
  }
}

function preset(id: string): Preset {
  return { id, temperature: 0.8, topP: null, topK: null, maxTokens: null }
}

function binding(name: string, presetId: string, role: Binding["role"] = "director"): Binding {
  return {
    name,
    // 归属**引擎给的**（判据写在那个环节自己的模块里），夹具照给
    role,
    shared: false,
    output: "text",
    reasoning: true,
    binding: "thinking",
    kind: "thinking",
    mechanical: false,
    connectionId: "local",
    source: "default",
    resolved: true,
    presetId,
    timeoutS: null,
    maxRetries: null,
    wallTimeoutS: null,
    cognition: null,
    timeBudgetS: 120
  }
}

function config(): ModelConfigView {
  return {
    defaultConnect: "local",
    agentBindings: { thinking: "local", no_thinking: "local" },
    connections: [connection("local")],
    presets: [preset("creative"), preset("strict")],
    roleOrder: ["world", "director", "actor", "scene", "player"],
    bindings: [binding("plan", "creative")],
    issues: [],
    sourceFile: "/tmp/config.yaml",
    log: { enable: true, level: "INFO", prompts: true, outputs: true, maxChars: 0, tokens: true },
    verify: null,
    skills: [],
    plugins: [],
    agents: [],
    writable: true,
    readOnlyReason: "",
    format: "yaml"
  }
}

/** jsdom 没有 PointerEvent / pointer capture，reka-ui 的 Tabs 与对话框要用到 */
function stubPointerApis() {
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent
  }
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}

async function mountPage() {
  const wrapper = mount(ModelConfig, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** 切到某个 Tab —— reka 的 TabsTrigger 认 mousedown，光 click 不换页 */
async function switchTab(label: string) {
  const tab = [...document.querySelectorAll("[data-slot=tabs-trigger]")].find((el) =>
    el.textContent?.includes(label)
  ) as HTMLElement
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  tab.click()
  await flushPromises()
}

/** 对话框走 teleport，内容在 body 上 */
function dialogButton(text: string) {
  const buttons = [...document.querySelectorAll("[data-slot=alert-dialog-content] button")]
  return buttons.find((el) => el.textContent?.trim() === text) as HTMLElement | undefined
}

/** 点某个预设那一行的「删除」 */
async function askDeletePreset(id: string) {
  const row = [...document.querySelectorAll("tbody tr")].find((tr) =>
    tr.textContent?.includes(id)
  )
  const button = [...(row?.querySelectorAll("button") ?? [])].find(
    (el) => el.textContent?.trim() === "删除"
  ) as HTMLElement
  button.click()
  await flushPromises()
}

describe("模型配置 · 删除确认", () => {
  beforeEach(() => {
    stubPointerApis()
    document.body.innerHTML = ""
    vi.clearAllMocks()
    vi.mocked(configApi.get).mockResolvedValue(config())
    vi.mocked(configApi.deletePreset).mockResolvedValue({ path: "/tmp/config.yaml", created: false, config: config() })
  })

  it("确认删除预设 → 真的发出删除请求（第一次不带 force）", async () => {
    await mountPage()
    await switchTab("采样预设")
    await askDeletePreset("strict")

    dialogButton("删除")?.click()
    await flushPromises()

    expect(configApi.deletePreset).toHaveBeenCalledWith("strict", false)
  })

  it("409 说还有人指着它 → 那句话留在框里，再点一次才强删", async () => {
    vi.mocked(configApi.deletePreset).mockRejectedValueOnce(
      new GalStoryError("「plan」还指着这个预设", 409)
    )
    await mountPage()
    await switchTab("采样预设")
    await askDeletePreset("creative")

    dialogButton("删除")?.click()
    await flushPromises()

    // 框还开着，且把引擎那句话原样摆出来了 —— 这正是做「要不要强删」这个决定所需的全部信息
    expect(document.body.textContent).toContain("「plan」还指着这个预设")
    expect(dialogButton("仍然删除")).toBeTruthy()

    vi.mocked(configApi.deletePreset).mockResolvedValue({ path: "/tmp/config.yaml", created: false, config: config() })
    dialogButton("仍然删除")?.click()
    await flushPromises()

    expect(configApi.deletePreset).toHaveBeenLastCalledWith("creative", true)
  })
})
