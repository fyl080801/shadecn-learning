import { AGENT_ATTACHMENT_MAX_COUNT, AGENT_ATTACHMENT_NAME_MAX_LENGTH, type AgentAttachment } from "@shadecn/shared/agent"
import type { AssetUploadItem } from "@/composables/useAssetUpload"

/** 一条消息最多带几个附件：附件列表（`useAssetUploadList`）的 `max` 用它，和服务端的校验同一个数 */
export const AGENT_ATTACHMENT_LIMIT = AGENT_ATTACHMENT_MAX_COUNT

/**
 * 发送时摘下来的附件项（都已传完）→ 发给 agent 的附件。文件名按服务端的上限截断（超长整条消息会被 400），
 * 去掉控制字符；没传完的项不该出现在这里（输入区在有附件没传完时不让发），万一有也跳过。
 */
export function attachmentsOf(items: readonly AssetUploadItem[]): AgentAttachment[] {
  return items.flatMap((item) => {
    const name = displayName(item.name)
    const uploaded = item.upload.result
    if (item.upload.status !== "done" || !uploaded) return []
    return [{ key: uploaded.key, url: uploaded.url, contentType: uploaded.contentType, name: name || "附件" }]
  })
}

/** 控制字符换成空格、按服务端的上限截断（按 UTF-16 计，和服务端一样；不切开一个代理对） */
function displayName(raw: string): string {
  let name = ""
  for (const char of raw) {
    const code = char.charCodeAt(0)
    const next = code < 0x20 || code === 0x7f ? " " : char
    if (name.length + next.length > AGENT_ATTACHMENT_NAME_MAX_LENGTH) break
    name += next
  }
  return name.trim()
}
