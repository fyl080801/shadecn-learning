import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"

import StoryEdit from "@/views/galstory/StoryEdit.vue"
import { GalStoryError, storyApi } from "@/lib/galstory"
import type { StoryCheck, StorySummary } from "@/types/galstory"

/**
 * 故事编辑页。**这四条全是实跑（浏览器里点一遍）抓出来的**，不是照着代码想出来的 ——
 * 每一条的共同点是：**功能其实是好的，只是界面在说假话**，而那种错单元测试很难先想到。
 */

vi.mock("@/lib/galstory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/galstory")>()
  return {
    ...actual,
    storyApi: {
      list: vi.fn(),
      files: vi.fn(),
      check: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      rename: vi.fn()
    },
    saveApi: { create: vi.fn() }
  }
})

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { storyId: "s2026-abc" } }),
  useRouter: () => ({ push: vi.fn() })
}))

/** CodeMirror 在 jsdom 里跑不动，也不是这几条要验的东西 —— 换成一个受控 textarea */
vi.mock("@/components/galstory/YamlEditor.vue", () => ({
  default: {
    name: "YamlEditor",
    props: ["modelValue", "readonly"],
    emits: ["update:modelValue"],
    template:
      '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  }
}))

const MINE: StorySummary = {
  name: "s2026-abc",
  title: "深夜书店",
  cover: "",
  owner: "u1",
  scope: "mine",
  writable: true,
  playable: true,
  characters: 1,
  scenes: 1,
  saves: 0
}

const OK: StoryCheck = { playable: true, blockers: [], issues: [] }

function ready() {
  vi.mocked(storyApi.list).mockResolvedValue([MINE])
  vi.mocked(storyApi.files).mockResolvedValue(["story.yaml", "characters/npc.yaml"])
  vi.mocked(storyApi.check).mockResolvedValue(OK)
  vi.mocked(storyApi.readFile).mockImplementation(async (_name, path) => ({
    path,
    text: `# ${path}\npresent:\n  - npc\n`
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  ready()
})

describe("加载中不许把默认值当事实说出来", () => {
  it("还没拿到答案时，三个徽章一个都不给", async () => {
    // ⚠️ 这几格的初值是「只读」「开不了局」—— 那**不是事实，是「还不知道」**。
    // 实跑第一版正是这样：新建一个故事跳进来，那几秒里满屏红字当着作者的面说
    // 他刚建的故事是别人的、还坏了。判据是**有没有拿到答案**，不是值是什么。
    let resolve!: (value: string[]) => void
    vi.mocked(storyApi.files).mockReturnValue(new Promise((r) => (resolve = r)))

    const wrapper = mount(StoryEdit)
    await flushPromises()

    expect(wrapper.text()).not.toContain("公共故事")
    expect(wrapper.text()).not.toContain("还开不了局")
    expect(wrapper.text()).not.toContain("可以开局")

    resolve(["story.yaml"])
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain("可以开局")
    expect(wrapper.text()).not.toContain("公共故事")
  })
})

describe("保存被拒", () => {
  it("422 → blockers 逐条显示，且编辑器里那份**不当成已保存**", async () => {
    const wrapper = mount(StoryEdit)
    await flushPromises()
    await flushPromises()

    await wrapper.find("textarea").setValue("present:\n  - ghost\n")
    vi.mocked(storyApi.writeFile).mockRejectedValue(
      new GalStoryError("改完之后这个故事跑不起来，已原样保留。", 422, "", "", {
        check: {
          playable: false,
          blockers: [
            {
              code: "present-unknown",
              level: "error",
              where: "ghost",
              message: "`present:` 里的 'ghost' 没有对应的角色卡。"
            }
          ],
          issues: []
        }
      })
    )

    await wrapper.findAll("button").find((b) => b.text().includes("保存"))!.trigger("click")
    await flushPromises()

    expect(wrapper.text()).toContain("已原样保留")
    expect(wrapper.text()).toContain("没有对应的角色卡")
    // ⚠️ **顶上仍该是「可以开局」**：磁盘上那份从头到尾没变过，报成坏的就是撒谎
    expect(wrapper.text()).toContain("可以开局")
    // 「未保存」还在 —— 那次写入确实没落盘
    expect(wrapper.text()).toContain("未保存")
  })

  it("⚠️ 文本一改就把上一次的拒绝清掉 —— 那句话是针对某一版说的", async () => {
    // 实跑踩过：把改坏的那行改回去之后红框还挂着，于是「现在是好的」与「刚才那次没过」
    // 长得一模一样，人会以为还坏着 —— 而磁盘上那份根本没变过。
    const wrapper = mount(StoryEdit)
    await flushPromises()
    await flushPromises()

    await wrapper.find("textarea").setValue("坏的")
    vi.mocked(storyApi.writeFile).mockRejectedValue(
      new GalStoryError("改完之后这个故事跑不起来，已原样保留。", 422, "", "", {
        check: { playable: false, blockers: [], issues: [] }
      })
    )
    await wrapper.findAll("button").find((b) => b.text().includes("保存"))!.trigger("click")
    await flushPromises()
    expect(wrapper.text()).toContain("已原样保留")

    await wrapper.find("textarea").setValue("改回去了")
    await flushPromises()

    expect(wrapper.text()).not.toContain("已原样保留")
  })

  it("403 是能力边界，不带 blockers —— 与「内容不对」两档", async () => {
    const wrapper = mount(StoryEdit)
    await flushPromises()
    await flushPromises()

    await wrapper.find("textarea").setValue("x")
    vi.mocked(storyApi.writeFile).mockRejectedValue(
      new GalStoryError("不允许编辑 'plugins/x/plugin.py'", 403)
    )
    await wrapper.findAll("button").find((b) => b.text().includes("保存"))!.trigger("click")
    await flushPromises()

    expect(wrapper.text()).toContain("不允许编辑")
  })
})

describe("新建文件", () => {
  it("⚠️ 打开的是刚建的那个路径，不是被清空之后算出来的", async () => {
    // 实跑踩过：`newPath` 是从输入框算出来的 computed，而代码先清空了输入框再拿它去 open ——
    // 文件**建对了**，界面却弹一句「'characters/.yaml' 不可编辑或不存在」，
    // 于是人以为刚才那一步失败了。
    const wrapper = mount(StoryEdit)
    await flushPromises()
    await flushPromises()

    vi.mocked(storyApi.writeFile).mockResolvedValue(OK)
    vi.mocked(storyApi.files).mockResolvedValue([
      "story.yaml",
      "characters/npc.yaml",
      "characters/lin.yaml"
    ])

    const vm = wrapper.vm as unknown as {
      creating: boolean
      newName: string
      createFile: () => Promise<unknown>
    }
    vm.creating = true
    vm.newName = "lin"
    await vm.createFile()
    await flushPromises()

    expect(vi.mocked(storyApi.writeFile).mock.calls[0]?.[1]).toBe("characters/lin.yaml")
    // 建完之后**打开的就是它**（读的那一发用的是同一个路径）
    const opened = vi.mocked(storyApi.readFile).mock.calls.at(-1)?.[1]
    expect(opened).toBe("characters/lin.yaml")
  })
})
