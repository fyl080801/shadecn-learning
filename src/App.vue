<script setup lang="ts">
import { computed } from "vue"
import { useRoute } from "vue-router"
import AppSidebar from "@/components/AppSidebar.vue"
import { Toaster } from "@/components/ui/sonner"

/**
 * 绝大多数路由都套侧栏。画布编辑器要独占整屏，所以留了一个 bare 分支 ——
 * 由路由的 meta.layout 决定，AppSidebar 组件本身不用改。
 * 注意这不是登录态的例外：bare 路由同样是登录后才进得来。
 */
const route = useRoute()
const bare = computed(() => route.meta.layout === "bare")
</script>

<template>
  <div v-if="bare" class="h-screen overflow-hidden bg-background">
    <RouterView />
  </div>

  <div v-else class="flex h-screen overflow-hidden bg-background">
    <AppSidebar />
    <main class="min-w-0 flex-1 overflow-auto h-full">
      <RouterView />
    </main>
  </div>

  <Toaster rich-colors close-button />
</template>
