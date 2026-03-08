<script setup lang="ts">
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-2xl">
      <CardHeader>
        <CardTitle class="text-2xl">About</CardTitle>
        <CardDescription>
          Learn more about this project
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <p class="text-muted-foreground">
          This is a Vue.js application built with Vite and shadcn-vue components.
        </p>
        <p class="text-muted-foreground">
          It demonstrates the use of modern Vue 3 features including the Composition API,
          TypeScript support, and a beautiful UI component library.
        </p>
      </CardContent>
    </Card>
  </div>
</template>