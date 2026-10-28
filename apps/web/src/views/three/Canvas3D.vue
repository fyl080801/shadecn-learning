<script setup lang="ts">
import { ref } from "vue"
import Canvas3DView from "@/components/Canvas3DView.vue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"

const cameraRotation = ref({ yaw: 0, pitch: 0, zoomLevel: "unchanged" as const })

const zoomLabel: Record<string, string> = {
  in: "In",
  out: "Out",
  unchanged: "Normal"
}
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>3D Camera</CardTitle>
        <CardDescription> 拖动机位，改变摄影角度 </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex justify-center">
          <Canvas3DView v-model="cameraRotation" dark-mode :bottom-limit-degrees="55" />
        </div>
        <div class="mt-4 text-center text-sm text-muted-foreground">
          Camera rotation: Yaw {{ cameraRotation.yaw.toFixed(1) }}°, Pitch {{ cameraRotation.pitch.toFixed(1) }}°
          <span class="ml-2">Zoom: {{ zoomLabel[cameraRotation.zoomLevel] }}</span>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
