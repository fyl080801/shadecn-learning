<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

/**
 * 「关于」不再是一个页面，而是一个模态窗：它只是一段项目介绍，
 * 没必要占一条路由、也没必要把人从当前页面带走。入口在侧栏底部的用户菜单。
 */
defineProps<{ open: boolean }>()
defineEmits<{ "update:open": [value: boolean] }>()
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>关于</DialogTitle>
        <DialogDescription>这个项目是什么</DialogDescription>
      </DialogHeader>

      <div class="text-muted-foreground space-y-3 text-sm">
        <p>一个基于 Vite 构建、使用 shadcn-vue 组件的 Vue 3 应用。</p>
        <p>
          它用来验证一批前端技术：Composition API、TypeScript、Three.js 场景、
          Canvas 小游戏，以及基于 Yjs 的多人协同画布。
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
