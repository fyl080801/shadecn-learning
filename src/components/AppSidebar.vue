<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useMediaQuery } from '@vueuse/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Menu,
  X,
  Home,
  Info,
  Box,
  Gamepad2,
  Grid3X3,
  Layers,
  Sun,
} from 'lucide-vue-next'

interface NavItem {
  label: string
  to: string
  icon: Component
}

const navItems: NavItem[] = [
  { label: 'Home', to: '/', icon: Home },
  { label: 'About', to: '/about', icon: Info },
  { label: 'Example', to: '/example', icon: Layers },
  { label: '3D Cube', to: '/3d-cube', icon: Box },
  { label: '贪吃蛇', to: '/snake', icon: Gamepad2 },
  { label: '2048', to: '/2048', icon: Grid3X3 },
  { label: 'canvas3d', to: '/canvas3d', icon: Layers },
  { label: 'lightscene', to: '/lightscene', icon: Sun },
]

const route = useRoute()
const isNarrow = useMediaQuery('(max-width: 768px)')
const collapsed = ref(false)

const isCollapsedDesktop = computed(() => collapsed.value && !isNarrow.value)

watch(isNarrow, (narrow) => {
  if (narrow) collapsed.value = true
}, { immediate: true })

const closeOnMobile = () => {
  if (isNarrow.value) collapsed.value = true
}

const toggleSidebar = () => {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <!-- Mobile overlay -->
  <div
    v-if="isNarrow && !collapsed"
    class="fixed inset-0 z-30 bg-black/50"
    @click="collapsed = true"
  />

  <aside
    :class="[
      'flex h-full flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out',
      isNarrow ? 'fixed inset-y-0 left-0 z-40' : '',
      collapsed && isNarrow ? '-translate-x-full' : 'translate-x-0',
    ]"
    :style="{ width: isCollapsedDesktop ? '64px' : '240px' }"
  >
    <!-- Brand header -->
    <div class="flex h-14 items-center gap-2 border-b px-4">
      <RouterLink to="/" class="flex items-center gap-2 overflow-hidden" @click="closeOnMobile">
        <img src="@/assets/vue.svg" class="h-6 w-6 shrink-0" alt="Vue logo" />
        <span v-if="!isCollapsedDesktop" class="truncate font-bold">My App</span>
      </RouterLink>
      <div v-if="!isCollapsedDesktop" class="ml-auto">
        <Badge variant="secondary">v1.0.0</Badge>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 overflow-y-auto px-2 py-2">
      <ul class="flex flex-col gap-1">
        <li v-for="item in navItems" :key="item.to">
          <RouterLink
            :to="item.to"
            :class="[
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              route.path === item.to
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70',
              isCollapsedDesktop ? 'justify-center' : '',
            ]"
            @click="closeOnMobile"
          >
            <component :is="item.icon" class="h-4 w-4 shrink-0" />
            <span v-if="!isCollapsedDesktop">{{ item.label }}</span>
          </RouterLink>
        </li>
      </ul>
    </nav>

    <!-- Collapse toggle (desktop only) -->
    <div v-if="!isNarrow" class="border-t p-2">
      <Button variant="ghost" size="sm" class="w-full justify-center" @click="toggleSidebar">
        <Menu v-if="collapsed" class="h-4 w-4" />
        <X v-else class="h-4 w-4" />
      </Button>
    </div>
  </aside>

  <!-- Mobile menu button -->
  <Button
    v-if="isNarrow && collapsed"
    variant="ghost"
    size="icon"
    class="fixed left-3 top-3 z-50"
    @click="collapsed = false"
  >
    <Menu class="h-5 w-5" />
  </Button>
</template>
