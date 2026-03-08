<script setup lang="ts">
import { ref } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import InteractiveSquare from '@/components/InteractiveSquare.vue'

const position = ref({ x: 150, y: 150 })

function handlePositionUpdate(newPosition: { x: number; y: number }) {
  position.value = newPosition
}
</script>

<template>
  <div class="flex flex-col items-center justify-center p-8">
    <Card class="w-full max-w-xl">
      <CardHeader>
        <CardTitle>Interactive Point</CardTitle>
        <CardDescription>
          Drag the point within the area. Lines connect to all four corners of the square.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex justify-center">
          <InteractiveSquare
            :square-size="200"
            :drag-area-scale="1.5"
            @update:position="handlePositionUpdate"
          />
        </div>

        <div class="mt-4 text-center text-sm text-muted-foreground">
          <p>Point position: ({{ Math.round(position.x) }}, {{ Math.round(position.y) }})</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>