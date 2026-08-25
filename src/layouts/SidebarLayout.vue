<script setup lang="ts">
import AppSidebar from "@/components/AppSidebar.vue"
import { Button } from "@/components/ui/button"
import { Menu } from "@lucide/vue"
import { useAppLayout } from "@/composables/useAppLayout"

/**
 * 带菜单的模板页 —— 绝大多数路由都挂在它下面。
 * 路由表里它是父级路由的 component，页面本身渲染在这里的 <RouterView /> 上。
 *
 * 三档规格（见 useAppLayout）：桌面/平板侧边栏就地占位（展开 240px / 收起 64px），
 * 手机端改成抽屉，正文上方多一条带汉堡按钮的顶栏。
 */
const { isMobile, openMobileNav } = useAppLayout()
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background">
    <AppSidebar />
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <!-- 手机端顶栏：抽屉盖住正文，入口只能放在这里 -->
      <header
        v-if="isMobile"
        class="flex h-14 shrink-0 items-center gap-2 border-b px-3"
      >
        <Button variant="ghost" size="icon" title="打开菜单" @click="openMobileNav()">
          <Menu class="h-5 w-5" />
        </Button>
        <span class="truncate font-bold">My App</span>
      </header>
      <!-- h-0 + flex-1：让正文里 h-full 的页面仍然拿得到确定高度 -->
      <main class="h-0 min-h-0 min-w-0 flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
  </div>
</template>
