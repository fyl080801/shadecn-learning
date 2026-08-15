<script setup lang="ts">
import AppSidebar from "@/components/AppSidebar.vue"

/**
 * 带菜单的模板页 —— 绝大多数路由都挂在它下面。
 * 路由表里它是父级路由的 component，页面本身渲染在这里的 <RouterView /> 上。
 */
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background">
    <AppSidebar />
    <main class="min-w-0 flex-1 overflow-auto h-full">
      <RouterView />
    </main>
  </div>
</template>
