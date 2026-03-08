<script setup lang="ts">
import { ref } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Cube3D from '@/components/Cube3D.vue'

const rotation = ref({ x: -30, y: 45 })

function handleRotationUpdate(newRotation: { x: number; y: number }) {
  rotation.value = newRotation
}
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>3D Cube</CardTitle>
        <CardDescription>
          Drag to rotate the cube. A CSS-based 3D transformation demo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex justify-center">
          <Cube3D
            :size="200"
            :no-back-side="true"
            @update:rotation="handleRotationUpdate"
          />
        </div>

        <div class="mt-6 text-center text-sm text-muted-foreground">
          <p>Rotation: X {{ Math.round(rotation.x) }}° / Y {{ Math.round(rotation.y) }}°</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>