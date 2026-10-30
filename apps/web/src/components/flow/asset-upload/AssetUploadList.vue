<script setup lang="ts">
import { ref } from "vue"
import { Plus } from "@lucide/vue"
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment"
import type { AssetUploadList } from "@/composables/useAssetUpload"
import AssetUploadTile from "./AssetUploadTile.vue"

/**
 * 附件上传组件（基于 `ui/attachment`）：最前面一个带加号的虚线方框（`Attachment` 的 `idle` 态，点开选文件、可多选），
 * 已添加的附件以缩略图小方块排在它后面，每个都能删（上传中删 = 取消）、失败的能重试。
 * 状态全在 `useAssetUploadList`（父组件建好传进来，发送时摘走、失败时还回来都是父组件的事）；这里只管选文件和画。
 *
 * 满了（`remaining` 为 0）加号方框就不显示；`disabled` 时既不能加也不能删。
 * `addable` 为 false 时不画加号方框，只排缩略图 —— 选文件的入口由父组件自己放（比如对话输入区发送按钮左边的加号）。
 */
const props = withDefaults(
  defineProps<{
    list: AssetUploadList
    /** 文件选择框的 `accept`；默认图片和视频（画布资源只收这两种） */
    accept?: string
    disabled?: boolean
    /** 加号方框的说明（无障碍名 + 悬停提示） */
    label?: string
    /** 画不画加号方框；false 时入口在父组件 */
    addable?: boolean
  }>(),
  { accept: "image/*,video/*", disabled: false, label: "添加附件", addable: true }
)

const input = ref<HTMLInputElement | null>(null)

function onChange(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files ? [...target.files] : []
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  if (files.length > 0) props.list.add(files)
}
</script>

<template>
  <!-- pt / pr 给附件右上角的删除角标留位置：AttachmentGroup 横向滚动，溢出的部分会被裁掉 -->
  <AttachmentGroup class="gap-2 pt-2 pr-2" aria-label="附件" data-testid="asset-upload-list">
    <Attachment
      v-if="props.addable && props.list.remaining > 0"
      state="idle"
      orientation="vertical"
      size="xs"
      class="w-16"
      :title="props.label"
    >
      <AttachmentMedia class="bg-transparent text-muted-foreground group-data-[size=xs]/attachment:w-full">
        <Plus class="size-5" />
      </AttachmentMedia>
      <AttachmentTrigger
        :aria-label="props.label"
        :disabled="props.disabled"
        data-testid="asset-upload-add"
        @click="input?.click()"
      />
      <input
        ref="input"
        type="file"
        multiple
        :accept="props.accept"
        class="hidden"
        data-testid="asset-upload-input"
        @change="onChange"
      />
    </Attachment>
    <AssetUploadTile
      v-for="item in props.list.items"
      :key="item.id"
      :item="item"
      :disabled="props.disabled"
      @remove="props.list.remove(item.id)"
      @retry="props.list.retry(item.id)"
    />
  </AttachmentGroup>
</template>
