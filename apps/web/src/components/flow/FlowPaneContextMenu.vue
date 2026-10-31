<script setup lang="ts">
import { ref } from "vue"
import { Plus, Upload } from "@lucide/vue"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { addNodesFromFiles, FILE_NODE_ACCEPT } from "@/components/flow/file-nodes"
import { ADDABLE_NODE_TYPES, GROUP_NODE_TYPE } from "@/components/flow/node-types"
import { useFlowEditor } from "@/composables/flow/editor-context"

/**
 * 画布空白处的右键菜单（docs/13 §4.4.4）：「添加」子菜单 + 「上传」。
 *
 * 「添加」列的就是工具栏加号那张表（`ADDABLE_NODE_TYPES`），只是新节点落在**右键那一点**，不是画布中心。
 * 「上传」打开文件选择框（可多选），选中的文件逐个建成节点再往里传（`file-nodes.ts`）。
 *
 * 只在**空白处**弹：右键落在节点、连线、浮层面板、节点工具栏、输入框上时，在内层把事件拦下（`stopPropagation`，
 * 不 `preventDefault`）—— 触发器收不到，浏览器原生菜单照常出现（输入框里还要能粘贴）。
 * 拦的位置在内层 div 而不是触发器本身：同一个元素上两个监听器谁先跑说不准，冒泡顺序是确定的。
 *
 * 文件选择框放在菜单外面：菜单一关内容就卸了，框得留着接 `change`。
 */
const editor = useFlowEditor()
const { canvas } = editor

/** 不弹菜单的地方：节点（含连接点、节点工具栏）、连线、选区框、Vue Flow 面板、可编辑元素 */
const SKIP_SELECTOR = [
  ".vue-flow__node",
  ".vue-flow__edge",
  ".vue-flow__nodesselection",
  ".vue-flow__node-toolbar",
  ".vue-flow__panel",
  "input",
  "textarea",
  "[contenteditable]"
].join(",")

/** 右键那一点（屏幕坐标）；菜单项选中时拿它当落点 */
const point = ref({ x: 0, y: 0 })
/** 选文件期间用的落点：从点「上传」那一刻定下来，选完之前再右键别处也不变 */
let uploadPoint = { x: 0, y: 0 }
const input = ref<HTMLInputElement | null>(null)

/**
 * 分组框里的空白也算「空白处」：右键在那里「添加」，新节点就建进这个分组（`canvas.addNode` 按落点判归属）——
 * 组外的节点拖不进分组，往分组里加内容靠的就是这一下。只放行分组框自己的元素，组员照旧不弹。
 */
const GROUP_FRAME_SELECTOR = `.vue-flow__node-${GROUP_NODE_TYPE}`

function onContextMenu(event: MouseEvent) {
  const target = event.target as Element | null
  const skip = target?.closest(SKIP_SELECTOR)
  if (skip && !skip.matches(GROUP_FRAME_SELECTOR)) {
    event.stopPropagation()
    return
  }
  point.value = { x: event.clientX, y: event.clientY }
}

function addAt(type: string) {
  void canvas.addNode(type, { point: point.value })
}

function pickFiles() {
  uploadPoint = point.value
  input.value?.click()
}

function onFilesChange(event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  // 清空，下次选同一个文件也能触发 change
  target.value = ""
  if (files.length) void addNodesFromFiles(editor, files, uploadPoint)
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div class="h-full w-full">
        <div class="h-full w-full" @contextmenu="onContextMenu">
          <slot />
        </div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-44" data-testid="flow-pane-context-menu">
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Plus />
          添加
        </ContextMenuSubTrigger>
        <ContextMenuSubContent class="w-44">
          <ContextMenuItem
            v-for="def in ADDABLE_NODE_TYPES"
            :key="def.type"
            @select="addAt(def.type)"
          >
            <component :is="def.icon" />
            {{ def.label }}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem data-testid="flow-pane-upload" @select="pickFiles()">
        <Upload />
        上传
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  <input
    ref="input"
    type="file"
    multiple
    :accept="FILE_NODE_ACCEPT"
    class="hidden"
    data-testid="flow-pane-upload-input"
    @change="onFilesChange"
  />
</template>
