<script setup lang="ts">
import { ref } from "vue"
import LightDirection from "@/components/LightDirection.vue"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const viewMode = ref<"front" | "perspective">("front")
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>3D Liginting</CardTitle>
        <CardDescription> 拖动光源，改变打光角度 </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex justify-center gap-2 mb-4">
          <Button
            :variant="viewMode === 'front' ? 'default' : 'outline'"
            size="sm"
            @click="viewMode = 'front'"
          >
            正面
          </Button>
          <Button
            :variant="viewMode === 'perspective' ? 'default' : 'outline'"
            size="sm"
            @click="viewMode = 'perspective'"
          >
            透视
          </Button>
        </div>
        <div class="flex justify-center">
          <LightDirection :view-mode="viewMode" :snap="true" />
        </div>
      </CardContent>
    </Card>
  </div>
</template>
