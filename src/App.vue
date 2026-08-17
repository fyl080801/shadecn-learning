<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner"
import SessionExpiredDialog from "@/components/SessionExpiredDialog.vue"

/**
 * 应用根组件只做三件事：把当前路由的模板页渲染出来，挂一次全局 Toaster，
 * 再挂一次会话过期的确认框（哪个页面发的请求过期都用它）。
 * 「带不带菜单」不在这里判断 —— 见 src/layouts/，由路由表挑父级布局决定。
 */
</script>

<template>
  <RouterView />

  <Toaster rich-colors close-button />
  <SessionExpiredDialog />
</template>
