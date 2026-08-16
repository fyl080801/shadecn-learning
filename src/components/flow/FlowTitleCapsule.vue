<script setup lang="ts">
import { ref } from "vue"
import { Copy, Menu, Plus, Trash2, Workflow } from "lucide-vue-next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { useFlowEditor } from "@/composables/flow"

/**
 * 左上角悬浮胶囊：logo（回项目）+ 可就地编辑的画布名 + 保存状态 + 菜单。
 *
 * 页面是 bare 布局没有应用侧栏，所以这枚胶囊是「出去」的唯一入口，
 * 也是画布级动作（新建 / 复制 / 删除）的收口处。
 *
 * 定位不在这里：编辑器把它和右边的在场头像栏放进同一个左上角容器（FlowEditor.vue），
 * 这样画布名长短变化时头像栏会跟着挪，不会压在一起。
 */
const { store, document: doc } = useFlowEditor()

const editingName = ref(false)
const nameDraft = ref("")

function startRename() {
  nameDraft.value = store.meta?.name ?? ""
  editingName.value = true
}

function submitRename() {
  editingName.value = false
  void doc.rename(nameDraft.value)
}

const confirmingDelete = ref(false)
</script>

<template>
  <!-- h-10 是左上角这一排胶囊的统一高度，在场头像栏也用它对齐 -->
  <div
    class="flex h-10 items-center gap-1 rounded-full border bg-card/95 pl-1 pr-1.5 shadow-lg backdrop-blur"
  >
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full"
      title="返回项目"
      @click="doc.backToProject()"
    >
      <Workflow class="text-primary" />
    </Button>

    <Input
      v-if="editingName"
      v-model="nameDraft"
      class="h-7 w-40 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
      autofocus
      @blur="submitRename"
      @keydown.enter="submitRename"
      @keydown.esc="editingName = false"
    />
    <button
      v-else
      class="max-w-40 truncate px-1 text-sm font-medium hover:text-primary"
      title="点击重命名"
      @click="startRename"
    >
      {{ store.meta?.name ?? "无标题" }}
    </button>

    <button
      class="whitespace-nowrap px-1 text-xs text-muted-foreground"
      :class="
        doc.saveActionable.value ? 'text-destructive hover:underline' : ''
      "
      @click="doc.onSaveIndicatorClick"
    >
      {{ doc.saveText.value }}
    </button>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="icon" class="size-8 rounded-full">
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-40">
        <!-- 复制 / 新建都要先把未保存的落库，慢，进行中就把入口按住 -->
        <DropdownMenuItem :disabled="doc.creatingSibling.value" @select="doc.createSibling()">
          <Plus />
          新建画布
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="doc.duplicating.value" @select="doc.duplicate()">
          <Copy />
          复制
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          @select="confirmingDelete = true"
        >
          <Trash2 />
          删除
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="doc.backToProject()"
          >返回项目</DropdownMenuItem
        >
      </DropdownMenuContent>
    </DropdownMenu>
  </div>

  <AlertDialog v-model:open="confirmingDelete">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle
          >删除画布「{{ store.meta?.name }}」？</AlertDialogTitle
        >
        <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction :disabled="doc.removing.value" @click="doc.remove()">
          删除
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
