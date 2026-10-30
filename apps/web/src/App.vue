<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import SessionExpiredDialog from "@/components/SessionExpiredDialog.vue"
import { resolvedTheme } from "@/lib/theme"

/**
 * 应用根组件只做这几件事：把当前路由的模板页渲染出来，挂一次全局 Toaster，
 * 再挂一次会话过期的确认框（哪个页面发的请求过期都用它），并用一个全局 TooltipProvider
 * 包住整个应用 —— 各组件直接写 Tooltip，不再各自包 Provider（要不同的延迟就在 Tooltip 上传 delay-duration）。
 * 「带不带菜单」不在这里判断 —— 见 apps/web/src/layouts/，由路由表挑父级布局决定。
 */
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <RouterView />
  </TooltipProvider>

  <!--
    vue-sonner 自己那套配色不认 `.dark` 类（它看的是自己的 theme prop），
    不传的话深色主题下会弹出一个白底的 toast。
  -->
  <Toaster :theme="resolvedTheme" rich-colors close-button />
  <SessionExpiredDialog />
</template>
