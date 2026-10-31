<script setup lang="ts">
import { computed, ref } from "vue"
import { toast } from "vue-sonner"
import { Plus } from "@lucide/vue"

import { useNodePart } from "@/components/flow/node-kit/context"
import {
  reportNodeUploadError,
  runNodeUpload,
  uploadImageToNode,
  uploadVideoToNode
} from "@/components/flow/node-upload"
import { fileNodeLabel } from "@/components/flow/file-nodes"
import { cn } from "@/lib/utils"

import ComposerInputTile from "./ComposerInputTile.vue"
import { INPUT_ORDER_KEY, acceptedInputMedia, inputMediaAccept, inputMediaKindOf, moveItem } from "./composer-inputs"

/**
 * 底部输入框上半部分：**连入节点预览**（docs/13 §3.7「底部输入框」）。
 *
 * - 一格一个上游节点（`ComposerInputTile`），顺序由父组件按 `data.inputOrder` 排好传进来（`upstreams`）；
 * - **拖动排序**：浏览器原生拖放，拖着时只改本地的预览顺序（跟手），松手落下才写一次 `data.inputOrder`（一条撤销）；
 *   拖出去 / Esc 取消就回到原来的顺序；
 * - 末尾一格虚线**加号**：点了选文件，**只能选媒体**（按这个类型能接的：图片 / 视频节点收图和视频，导演台只收图）。
 *   一个文件建一个连进来的图片 / 视频节点（`canvas.addInputNode`，节点 + 线一个事务），再往里传 ——
 *   和右键菜单「上传」同一条路（先建节点、再 `runNodeUpload`），进度在新节点身上，也在这一格上转圈。
 *
 * 整排固定一行高（56px 格子），多了横向滚动，不把输入框撑高。
 */
const props = defineProps<{ upstreams: readonly string[] }>()

const ctx = useNodePart()

const kinds = computed(() => acceptedInputMedia(ctx.type))
const accept = computed(() => inputMediaAccept(kinds.value))

const fileInput = ref<HTMLInputElement | null>(null)

// —— 拖动排序 ——

const dragging = ref<string | null>(null)
/** 拖动中的本地顺序（跟手）；不在拖就是 null，显示传进来的顺序 */
const preview = ref<string[] | null>(null)

const shown = computed(() => preview.value ?? [...props.upstreams])

function onDragStart(event: DragEvent, id: string) {
  dragging.value = id
  preview.value = [...props.upstreams]
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move"
    // Firefox 不带数据就不开始拖
    event.dataTransfer.setData("text/plain", id)
  }
}

function onDragOver(event: DragEvent, overId: string) {
  if (!dragging.value || !preview.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  if (overId === dragging.value) return
  preview.value = moveItem(preview.value, dragging.value, preview.value.indexOf(overId))
}

function onDrop(event: DragEvent) {
  if (!dragging.value || !preview.value) return
  event.preventDefault()
  const next = preview.value
  const changed = next.some((id, index) => id !== props.upstreams[index])
  endDrag()
  if (!changed) return
  ctx.editor.store.separateUndo()
  ctx.node.write("data", { set: { [INPUT_ORDER_KEY]: next } }, "调整连入顺序")
  ctx.editor.store.separateUndo()
}

/** 没落在任何格子上（拖出去了 / Esc）：dragend 来收尾，顺序回到原样 */
function endDrag() {
  dragging.value = null
  preview.value = null
}

// —— 加号：选媒体 → 建连入节点 → 上传 ——

async function onFilesPicked(event: Event) {
  const target = event.target as HTMLInputElement
  const files = target.files ? [...target.files] : []
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  const flowId = ctx.editor.flowId.value
  for (const file of files) {
    const kind = inputMediaKindOf(file, kinds.value)
    if (!kind) {
      toast.error(`只能添加${kinds.value.includes("video") ? "图片或视频" : "图片"}：${file.name}`)
      continue
    }
    const nodeId = await ctx.editor.canvas.addInputNode(ctx.id, kind, { label: fileNodeLabel(file.name) })
    if (!nodeId) continue
    const attach = (asset: { src: string; poster?: string }, actionLabel: string) =>
      ctx.editor.store.attachAsset(nodeId, asset, actionLabel)
    const task = kind === "image" ? uploadImageToNode : uploadVideoToNode
    void runNodeUpload(flowId, nodeId, (io) => task(flowId, file, io, attach)).catch(reportNodeUploadError)
  }
}
</script>

<template>
  <!-- nowheel：横向滚动这一排不该缩放画布；pb-1 给横向滚动条留一点位置 -->
  <div class="nowheel flex gap-2 overflow-x-auto pb-1" data-testid="composer-inputs">
    <div
      v-for="id in shown"
      :key="id"
      draggable="true"
      :class="cn('shrink-0 cursor-grab active:cursor-grabbing', dragging === id && 'opacity-40')"
      :data-input-sort="id"
      @dragstart="onDragStart($event, id)"
      @dragover="onDragOver($event, id)"
      @drop="onDrop"
      @dragend="endDrag"
    >
      <ComposerInputTile :node-id="id" />
    </div>

    <button
      v-if="kinds.length > 0"
      type="button"
      class="flex size-14 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground transition-colors hover:border-primary/60 hover:bg-accent hover:text-accent-foreground"
      :title="kinds.includes('video') ? '添加图片或视频' : '添加图片'"
      :aria-label="kinds.includes('video') ? '添加图片或视频' : '添加图片'"
      data-testid="composer-input-add"
      @click="fileInput?.click()"
    >
      <Plus class="size-5" />
    </button>
    <input
      ref="fileInput"
      type="file"
      multiple
      :accept="accept"
      class="hidden"
      data-testid="composer-input-file"
      @change="onFilesPicked"
    />
  </div>
</template>
