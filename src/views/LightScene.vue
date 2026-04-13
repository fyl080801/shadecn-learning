<script setup lang="ts">
import LightDirection from "@/components/LightDirection.vue"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>3D Liginting</CardTitle>
        <CardDescription> 拖动光源，改变打光角度 </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex justify-center">
          <LightDirection />
        </div>
      </CardContent>
    </Card>
  </div>
</template>
