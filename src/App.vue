<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'

const route = useRoute()
/** 登录页这类页面不套侧栏 */
const bare = computed(() => route.meta.layout === 'blank')
</script>

<template>
  <div v-if="bare" class="h-screen overflow-auto bg-background">
    <RouterView />
  </div>
  <div v-else class="flex h-screen overflow-hidden bg-background">
    <AppSidebar />
    <main class="min-w-0 flex-1 overflow-auto h-full">
      <RouterView />
    </main>
  </div>
</template>
