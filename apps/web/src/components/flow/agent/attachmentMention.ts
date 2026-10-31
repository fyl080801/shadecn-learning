import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue"
import {
  ATTACHMENT_MENTION_PATTERN,
  agentAttachmentKind,
  formatAttachmentMention,
  type AgentAttachment,
  type AgentChatMessage
} from "@shadecn/shared/agent"
import { definePlugin, splitByRegex, type ParsedSegment, type PromptPlugin } from "@/components/prompt-input"
import type { AssetUploadItem } from "@/composables/useAssetUpload"

/**
 * 「提及附件」（docs/20 §3.10.12）：会话 / 快捷会话里上传的附件也能 `@`，在 v-model 的字符串里是 `@{attachment:<key>}`
 * （格式只认 `@shadecn/shared/agent` 那一份）。和节点提及共用一个 `@` 弹层 —— 弹层归节点那个插件（它带触发器），
 * 这个插件只管 parse / serialize 和 inline 类型，选中附件时由节点插件的 `commit` 插进这种 inline。
 *
 * 能提及的附件 = 输入区里**已经传完**的 + 这个会话之前几轮带过的（服务端只认这些，同 `view_attachment`）。
 * 这份清单由对话框 / 快捷会话按自己手上的东西 provide（{@link provideMentionAttachments}），
 * 输入框、消息列表、agent 回复里的 badge 都从这里查名字 —— 提及里只存键，不存名字。
 */

/** 插件名 = inline 节点的 `type` = `#element:` 插槽名的后缀 */
export const ATTACHMENT_MENTION = "attachment-mention"

/** 提及附件 badge 的载荷：只有键，名字现查 */
export interface AttachmentMentionData {
  key: string
}

/** 可提及的一个附件 */
export interface MentionableAttachment {
  key: string
  name: string
  contentType: string
  /** `draft` = 输入区里这条还没发的；`conversation` = 这个会话之前的消息带过的 */
  source: "draft" | "conversation"
}

/** 弹出列表最多列几个附件 */
export const ATTACHMENT_MENTION_LIMIT = 8

/** badge / 列表里文件名最多显示几个字（扩展名另算），多的从中间省略 */
export const ATTACHMENT_NAME_DISPLAY_LENGTH = 14

/**
 * 文件名缩短给人看：**保留扩展名**，主干超过 `max` 字就截断加「…」—— `一张很长很长的参考图…png`。
 * 扩展名本身过长（不像扩展名）就当没有，整个名字一起截。
 */
export function shortFileName(name: string, max = ATTACHMENT_NAME_DISPLAY_LENGTH): string {
  const chars = [...name]
  if (chars.length <= max + 1) return name
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1) : ""
  if (ext && ext.length <= 5) {
    const stem = [...name.slice(0, dot)]
    if (stem.length <= max) return name
    return `${stem.slice(0, max).join("")}….${ext}`
  }
  return `${chars.slice(0, max).join("")}…`
}

/** 读 badge 的载荷；数据不像样时返回 null */
export function attachmentMentionKeyOf(data: unknown): string | null {
  const key = (data as Partial<AttachmentMentionData> | null | undefined)?.key
  return typeof key === "string" && key ? key : null
}

/** 只做 parse / serialize 的插件（没有触发器：`@` 弹层是节点插件的） */
export function createAttachmentMentionPlugin(): PromptPlugin {
  return definePlugin({
    name: ATTACHMENT_MENTION,
    inline: { type: ATTACHMENT_MENTION },
    parse(text): ParsedSegment[] {
      return splitByRegex(text, ATTACHMENT_MENTION_PATTERN, (match) => ({
        kind: "node",
        type: ATTACHMENT_MENTION,
        data: { key: match[1] ?? "" } satisfies AttachmentMentionData
      }))
    },
    serialize(node): string {
      const key = attachmentMentionKeyOf(node.data)
      return key ? formatAttachmentMention(key) : ""
    }
  })
}

/**
 * 按关键词挑附件候选：文件名以关键词开头 > 包含，大小写不敏感；同一档保持原顺序（输入区的在前，之前的按新到旧）。
 */
export function attachmentMentionCandidates(
  attachments: readonly MentionableAttachment[],
  search: string,
  limit = ATTACHMENT_MENTION_LIMIT
): MentionableAttachment[] {
  const keyword = search.trim().toLowerCase()
  if (!keyword) return attachments.slice(0, limit)
  const ranked: Array<{ rank: number; index: number; item: MentionableAttachment }> = []
  attachments.forEach((item, index) => {
    const name = item.name.toLowerCase()
    const rank = name.startsWith(keyword) ? 0 : name.includes(keyword) ? 1 : -1
    if (rank >= 0) ranked.push({ rank, index, item })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.slice(0, limit).map((entry) => entry.item)
}

/**
 * 能提及的附件清单：输入区里传完的（按添加先后）在前，之后是会话里之前的消息带过的（新的在前），按键去重。
 * 键写不进提及的（含空白 / 花括号，本服务拼的键不会有）不列。
 */
export function mentionableAttachments(
  draft: readonly AssetUploadItem[],
  messages: readonly AgentChatMessage[]
): MentionableAttachment[] {
  const seen = new Set<string>()
  const list: MentionableAttachment[] = []
  const push = (item: Omit<MentionableAttachment, "source">, source: MentionableAttachment["source"]) => {
    if (seen.has(item.key) || !formatAttachmentMention(item.key)) return
    seen.add(item.key)
    list.push({ ...item, source })
  }
  for (const item of draft) {
    const uploaded = item.upload.result
    if (item.upload.status !== "done" || !uploaded) continue
    push({ key: uploaded.key, name: item.name || "附件", contentType: uploaded.contentType }, "draft")
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== "user" || !Array.isArray(message.attachments)) continue
    for (const item of message.attachments as AgentAttachment[]) {
      push({ key: item.key, name: item.name, contentType: item.contentType }, "conversation")
    }
  }
  return list
}

/** 附件按什么图标显示（和附件排的判断同一个） */
export function attachmentMentionKind(item: Pick<MentionableAttachment, "contentType">) {
  return agentAttachmentKind(item.contentType)
}

/**
 * 去掉这批附件的提及（输入区里删掉了那个附件）；连带吃掉紧跟的一个空格。别的提及和文字不动。
 */
export function removeAttachmentMentions(text: string, keys: readonly string[]): string {
  const gone = new Set(keys)
  if (gone.size === 0) return text
  let result = ""
  let cursor = 0
  for (const match of text.matchAll(ATTACHMENT_MENTION_PATTERN)) {
    if (!gone.has(match[1] ?? "")) continue
    result += text.slice(cursor, match.index)
    cursor = match.index + match[0].length
    if (text[cursor] === " ") cursor += 1
  }
  return result + text.slice(cursor)
}

// —— 清单的 provide / inject ——

export interface MentionAttachments {
  list: ComputedRef<MentionableAttachment[]>
  byKey: ComputedRef<Map<string, MentionableAttachment>>
}

const MENTION_ATTACHMENTS_KEY: InjectionKey<MentionAttachments> = Symbol("mention-attachments")

/** 对话框 / 快捷会话在自己的 setup 里调：子树里的输入区和 badge 都读这一份 */
export function provideMentionAttachments(source: () => readonly MentionableAttachment[]): MentionAttachments {
  const list = computed(() => [...source()])
  const byKey = computed(() => new Map(list.value.map((item) => [item.key, item])))
  const value = { list, byKey }
  provide(MENTION_ATTACHMENTS_KEY, value)
  return value
}

/** 没人 provide（单独挂一个消息组件的测试）就是空清单：附件提及显示成「已移除的附件」 */
export function useMentionAttachments(): MentionAttachments {
  const injected = inject(MENTION_ATTACHMENTS_KEY, null)
  if (injected) return injected
  const list = computed<MentionableAttachment[]>(() => [])
  return { list, byKey: computed(() => new Map()) }
}
