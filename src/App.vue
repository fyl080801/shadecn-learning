<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner"

/**
 * 应用根组件只做两件事：把当前路由的模板页渲染出来，以及挂一次全局 Toaster。
 * 「带不带菜单」不在这里判断 —— 见 src/layouts/，由路由表挑父级布局决定。
 */
</script>

<template>
  <RouterView />

  <Toaster rich-colors close-button />
</template>
