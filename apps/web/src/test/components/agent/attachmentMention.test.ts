import { describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { mount } from "@vue/test-utils"
import { formatAttachmentMention, formatNodeMention, type AgentChatMessage } from "@shadecn/shared/agent"
import type { FlowNode } from "@shadecn/shared/flow-graph"
import { modelToText, textToModel } from "@/components/prompt-input/serialize"
import type { CustomInline, Paragraph } from "@/components/prompt-input/types"
import type { AssetUploadItem } from "@/composables/useAssetUpload"
import {
  ATTACHMENT_MENTION,
  attachmentMentionCandidates,
  createAttachmentMentionPlugin,
  mentionableAttachments,
  provideMentionAttachments,
  removeAttachmentMentions,
  shortFileName,
  type MentionableAttachment
} from "@/components/flow/agent/attachmentMention"
import { NODE_MENTION, createNodeMentionPlugin, splitMentions, useNodeMentionMenu } from "@/components/flow/agent/nodeMention"
import FlowAgentAttachmentMention from "@/components/flow/agent/FlowAgentAttachmentMention.vue"

/**
 * 「提及附件」（docs/20 §3.10.12）。守三件事：
 * - 字符串格式只认 shared 那一份（`@{attachment:<key>}`），和节点提及在同一个输入框里互不干扰、round-trip 一字不差；
 * - `@` 弹层附件在前、节点在后，选中附件插进的是附件 badge（载荷 `{ key }`）；
 * - badge 是回形针 + 文件名（长了省略、保留扩展名），查不到显示「已移除的附件」。
 */

vi.mock("@/composables/flow/editor-context", () => ({
  useFlowEditor: () => ({ store: { nodes: [], nodeById: new Map() } })
}))

const KEY = "canvas/assets/ab/cd/abcd1234-0000-4000-8000-000000000000.png"
const OLD = "canvas/assets/ef/01/ef011234-0000-4000-8000-000000000000.mp4"

const att = (key: string, name: string, source: MentionableAttachment["source"] = "draft", contentType = "image/png") => ({
  key,
  name,
  contentType,
  source
})

function node(id: string, label: string): FlowNode {
  return {
    id,
    type: "text",
    layout: { position: { x: 0, y: 0 } },
    metadata: { label },
    data: {},
    runtime: { status: "idle" },
    inputs: []
  }
}

describe("提及附件的 parse / serialize", () => {
  const plugins = [createNodeMentionPlugin(), createAttachmentMentionPlugin()]

  it("节点和附件提及混在一起：各成各的 badge，序列化回来一字不差", () => {
    const text = `把 ${formatAttachmentMention(KEY)} 放进 ${formatNodeMention("n_1")}`
    const model = textToModel(text, plugins)
    const inlines = (model[0] as Paragraph).children.filter((child): child is CustomInline => "type" in child)
    expect(inlines.map((item) => [item.type, item.data])).toEqual([
      [ATTACHMENT_MENTION, { key: KEY }],
      [NODE_MENTION, { id: "n_1" }]
    ])
    expect(modelToText(model, plugins)).toBe(text)
  })

  it("消息列表的切分认出两种提及", () => {
    expect(splitMentions(`看 ${formatAttachmentMention(KEY)} 和 ${formatNodeMention("a")}`)).toEqual([
      { kind: "text", text: "看 " },
      { kind: "attachment", key: KEY },
      { kind: "text", text: " 和 " },
      { kind: "mention", id: "a" }
    ])
  })

  it("从草稿里去掉某个附件的提及（连同紧跟的空格），别的不动", () => {
    const text = `${formatAttachmentMention(KEY)} 和 ${formatAttachmentMention(OLD)} ${formatNodeMention("a")}`
    expect(removeAttachmentMentions(text, [KEY])).toBe(`和 ${formatAttachmentMention(OLD)} ${formatNodeMention("a")}`)
    expect(removeAttachmentMentions(text, [])).toBe(text)
  })
})

describe("可提及的附件", () => {
  function draftItem(name: string, status: "done" | "uploading", key: string): AssetUploadItem {
    return {
      id: name,
      file: new File(["x"], name),
      name,
      kind: "image",
      previewUrl: null,
      upload: {
        status,
        progress: null,
        error: null,
        result: status === "done" ? { key, url: `https://s3/${key}`, contentType: "image/png", size: 1, variants: [] } : null,
        cancel: () => {}
      }
    } as unknown as AssetUploadItem
  }

  it("输入区里传完的在前、会话之前带过的按新到旧在后，按键去重；还在传的不列", () => {
    const messages = [
      { id: "m1", role: "user", text: "", createdAt: 1, attachments: [{ key: OLD, url: "u", contentType: "video/mp4", name: "片段.mp4" }] },
      { id: "m2", role: "user", text: "", createdAt: 2, attachments: [{ key: KEY, url: "u", contentType: "image/png", name: "旧名.png" }] }
    ] as AgentChatMessage[]
    const list = mentionableAttachments([draftItem("猫.png", "done", KEY), draftItem("狗.png", "uploading", "x")], messages)
    expect(list).toEqual([att(KEY, "猫.png"), att(OLD, "片段.mp4", "conversation", "video/mp4")])
  })

  it("按文件名筛：开头 > 包含，大小写不敏感", () => {
    const list = [att("1", "封面-B.png"), att("2", "Cover.png"), att("3", "新封面.jpg")]
    expect(attachmentMentionCandidates(list, "封面").map((item) => item.key)).toEqual(["1", "3"])
    expect(attachmentMentionCandidates(list, "cover").map((item) => item.key)).toEqual(["2"])
  })

  it("文件名缩短：保留扩展名，主干过长截断加省略号", () => {
    expect(shortFileName("猫.png")).toBe("猫.png")
    expect(shortFileName("一二三四五六七八九十一二三四五六七.png", 6)).toBe("一二三四五六….png")
    expect(shortFileName("没有扩展名的超长超长的名字", 6)).toBe("没有扩展名的…")
  })
})

describe("@ 弹层：附件组在前", () => {
  it("选项附件在前、节点在后；键盘跨组走，选中附件提交 { key }", () => {
    const menu = useNodeMentionMenu(
      () => [node("n1", "封面文案")],
      () => [att(KEY, "封面.png")]
    )
    const commit = vi.fn()
    menu.bindCommit(commit)
    menu.onOpen({ name: NODE_MENTION, search: "封面", range: null as never })
    expect(menu.options.value.map((option) => option.kind)).toEqual(["attachment", "node"])

    const key = (k: string) => new KeyboardEvent("keydown", { key: k, cancelable: true })
    expect(menu.plugin.onKeyDown?.(key("Enter"), null as never)).toBe(true)
    expect(commit).toHaveBeenLastCalledWith({ data: { key: KEY } })

    menu.plugin.onKeyDown?.(key("ArrowDown"), null as never)
    menu.plugin.onKeyDown?.(key("Enter"), null as never)
    expect(commit).toHaveBeenLastCalledWith({ data: { id: "n1" } })
  })
})

describe("提及附件 badge", () => {
  function mountBadge(attachmentKey: string, list: () => MentionableAttachment[]) {
    const Host = defineComponent({
      setup() {
        provideMentionAttachments(list)
        return () => h(FlowAgentAttachmentMention, { attachmentKey })
      }
    })
    return mount(Host)
  }

  it("回形针 + 文件名，长名字省略、悬停看全名；清单变了跟着变", async () => {
    const items = ref([att(KEY, "一张非常非常非常非常长的参考图.png")])
    const wrapper = mountBadge(KEY, () => items.value)
    expect(wrapper.text()).toBe("一张非常非常非常非常长的参考….png")
    expect(wrapper.find("[data-mention-attachment]").attributes("title")).toBe("附件：一张非常非常非常非常长的参考图.png")
    expect(wrapper.find("svg").exists()).toBe(true)

    items.value = []
    await nextTick()
    expect(wrapper.text()).toBe("已移除的附件")
    expect(wrapper.find("[data-mention-attachment]").attributes("data-mention-missing")).toBe("true")
  })
})
