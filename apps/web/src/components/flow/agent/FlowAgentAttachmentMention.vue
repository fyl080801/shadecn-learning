<script setup lang="ts">
import { computed } from "vue"
import { Paperclip } from "@lucide/vue"
import { cn } from "@/lib/utils"
import { shortFileName, useMentionAttachments } from "./attachmentMention"

/**
 * 一枚「提及附件」badge —— 输入框里和消息列表里长得一样（docs/20 §3.10.12）。
 *
 * 和节点提及一眼分得开：回形针图标 + 文件名、中性底色（节点是类型图标 + 名字、主色淡底）。
 * 文件名过长从中间省略、保留扩展名（`shortFileName`），完整名字在悬停提示里。
 * 只拿键，名字从对话框 / 快捷会话 provide 的清单里查；查不到（附件从输入区删了、不是这个会话的）显示「已移除的附件」灰态。
 */
const props = defineProps<{ attachmentKey: string }>()

const { byKey } = useMentionAttachments()

const attachment = computed(() => byKey.value.get(props.attachmentKey) ?? null)

const label = computed(() => (attachment.value ? shortFileName(attachment.value.name) : "已移除的附件"))
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex max-w-48 items-center gap-1 rounded-md border px-1.5 align-middle text-xs leading-5',
        attachment
          ? 'border-border bg-muted text-foreground'
          : 'border-dashed border-muted-foreground/40 bg-muted text-muted-foreground line-through decoration-muted-foreground/50'
      )
    "
    :title="attachment ? `附件：${attachment.name}` : '这个附件已经不在这条消息 / 这个会话里了'"
    :data-mention-attachment="props.attachmentKey"
    :data-mention-missing="attachment ? undefined : 'true'"
  >
    <Paperclip class="size-3 shrink-0 opacity-70" />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
