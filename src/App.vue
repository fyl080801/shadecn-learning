<script setup lang="ts">
import AppSidebar from '@/components/AppSidebar.vue'
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background">
    <AppSidebar />
    <main class="min-w-0 flex-1 overflow-auto h-full">
      <RouterView />
    </main>
  </div>
</template>