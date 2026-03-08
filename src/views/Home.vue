<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

const count = ref(0)
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <div class="flex items-center gap-4 mb-8">
      <a href="https://vite.dev" target="_blank">
        <img src="/vite.svg" class="h-16 w-16 transition-transform hover:scale-110" alt="Vite logo" />
      </a>
      <a href="https://vuejs.org/" target="_blank">
        <img src="@/assets/vue.svg" class="h-16 w-16 transition-transform hover:scale-110" alt="Vue logo" />
      </a>
    </div>

    <Card class="w-full max-w-md">
      <CardHeader>
        <CardTitle class="text-2xl">Vite + Vue</CardTitle>
        <CardDescription>
          A modern Vue.js development setup with Vite
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="flex items-center gap-2">
          <Badge variant="secondary">Counter: {{ count }}</Badge>
        </div>
        <Button @click="count++" class="w-full">
          Increment Count
        </Button>
        <p class="text-sm text-muted-foreground">
          Edit <code class="bg-muted px-1.5 py-0.5 rounded text-xs">components/HelloWorld.vue</code> to test HMR
        </p>
      </CardContent>
      <Separator />
      <CardFooter class="flex-col gap-2">
        <div class="flex gap-2">
          <Badge variant="outline">
            <a href="https://vuejs.org/guide/quick-start.html#local" target="_blank" class="hover:underline">
              create-vue
            </a>
          </Badge>
          <Badge variant="outline">
            <a href="https://vuejs.org/guide/scaling-up/tooling.html#ide-support" target="_blank" class="hover:underline">
              IDE Support
            </a>
          </Badge>
        </div>
        <p class="text-xs text-muted-foreground">Click on the Vite and Vue logos to learn more</p>
      </CardFooter>
    </Card>

    <div class="mt-8 flex items-center gap-2">
      <Badge>shadcn-vue</Badge>
      <Badge variant="secondary">Tailwind CSS</Badge>
      <Badge variant="outline">TypeScript</Badge>
    </div>
  </div>
</template>