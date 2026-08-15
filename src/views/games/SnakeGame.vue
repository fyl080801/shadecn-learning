<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

// 游戏配置
const GRID_SIZE = 20
const CELL_SIZE = 20
const INITIAL_SPEED = 150

// 方向类型
type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'
type Position = { x: number; y: number }

// 游戏状态
const canvas = ref<HTMLCanvasElement | null>(null)
const score = ref(0)
const highScore = ref(0)
const gameStarted = ref(false)
const gameOver = ref(false)
const isPaused = ref(false)

// 蛇和食物
const snake = ref<Position[]>([{ x: 10, y: 10 }])
const food = ref<Position>({ x: 15, y: 10 })
const direction = ref<Direction>('RIGHT')
const nextDirection = ref<Direction>('RIGHT')

// 游戏循环
let gameLoop: ReturnType<typeof setInterval> | null = null

// 计算画布尺寸
const canvasSize = computed(() => GRID_SIZE * CELL_SIZE)

// 生成随机食物位置
const generateFood = (): Position => {
  let newFood: Position
  do {
    newFood = {
      x: Math.floor(Math.random() * GRID_SIZE),
      y: Math.floor(Math.random() * GRID_SIZE)
    }
  } while (snake.value.some(segment => segment.x === newFood.x && segment.y === newFood.y))
  return newFood
}

// 绘制游戏
const draw = () => {
  if (!canvas.value) return
  
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  // 清空画布
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, canvasSize.value, canvasSize.value)

  // 绘制网格线
  ctx.strokeStyle = '#2a2a4e'
  ctx.lineWidth = 0.5
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath()
    ctx.moveTo(i * CELL_SIZE, 0)
    ctx.lineTo(i * CELL_SIZE, canvasSize.value)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * CELL_SIZE)
    ctx.lineTo(canvasSize.value, i * CELL_SIZE)
    ctx.stroke()
  }

  // 绘制蛇
  snake.value.forEach((segment, index) => {
    if (index === 0) {
      // 蛇头
      ctx.fillStyle = '#4ade80'
    } else {
      // 蛇身渐变
      const gradient = 1 - (index / snake.value.length) * 0.5
      ctx.fillStyle = `rgba(74, 222, 128, ${gradient})`
    }
    ctx.fillRect(
      segment.x * CELL_SIZE + 1,
      segment.y * CELL_SIZE + 1,
      CELL_SIZE - 2,
      CELL_SIZE - 2
    )
  })

  // 绘制食物
  ctx.fillStyle = '#f43f5e'
  ctx.beginPath()
  ctx.arc(
    food.value.x * CELL_SIZE + CELL_SIZE / 2,
    food.value.y * CELL_SIZE + CELL_SIZE / 2,
    CELL_SIZE / 2 - 2,
    0,
    Math.PI * 2
  )
  ctx.fill()

  // 游戏结束遮罩
  if (gameOver.value) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(0, 0, canvasSize.value, canvasSize.value)
    
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 24px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('游戏结束', canvasSize.value / 2, canvasSize.value / 2 - 20)
    ctx.font = '16px sans-serif'
    ctx.fillText(`最终得分: ${score.value}`, canvasSize.value / 2, canvasSize.value / 2 + 15)
  }

  // 暂停遮罩
  if (isPaused.value && !gameOver.value) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(0, 0, canvasSize.value, canvasSize.value)
    
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 24px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('已暂停', canvasSize.value / 2, canvasSize.value / 2)
  }
}

// 移动蛇
const moveSnake = () => {
  if (gameOver.value || isPaused.value) return

  // 更新方向
  direction.value = nextDirection.value

  const currentHead = snake.value[0]
  if (!currentHead) return
  const head: Position = { x: currentHead.x, y: currentHead.y }

  switch (direction.value) {
    case 'UP':
      head.y -= 1
      break
    case 'DOWN':
      head.y += 1
      break
    case 'LEFT':
      head.x -= 1
      break
    case 'RIGHT':
      head.x += 1
      break
  }

  // 检测撞墙
  if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
    endGame()
    return
  }

  // 检测撞自己
  if (snake.value.some(segment => segment.x === head.x && segment.y === head.y)) {
    endGame()
    return
  }

  // 移动蛇
  snake.value.unshift(head)

  // 检测吃到食物
  if (head.x === food.value.x && head.y === food.value.y) {
    score.value += 10
    food.value = generateFood()
    // 加速
    if (gameLoop && score.value % 50 === 0) {
      clearInterval(gameLoop)
      const newSpeed = Math.max(50, INITIAL_SPEED - Math.floor(score.value / 50) * 10)
      gameLoop = setInterval(gameStep, newSpeed)
    }
  } else {
    snake.value.pop()
  }

  draw()
}

// 游戏步骤
const gameStep = () => {
  moveSnake()
}

// 开始游戏
const startGame = () => {
  snake.value = [{ x: 10, y: 10 }]
  direction.value = 'RIGHT'
  nextDirection.value = 'RIGHT'
  food.value = generateFood()
  score.value = 0
  gameOver.value = false
  isPaused.value = false
  gameStarted.value = true

  if (gameLoop) {
    clearInterval(gameLoop)
  }
  gameLoop = setInterval(gameStep, INITIAL_SPEED)
  draw()
}

// 暂停/继续游戏
const togglePause = () => {
  if (gameOver.value || !gameStarted.value) return
  isPaused.value = !isPaused.value
  draw()
}

// 结束游戏
const endGame = () => {
  gameOver.value = true
  if (gameLoop) {
    clearInterval(gameLoop)
    gameLoop = null
  }
  if (score.value > highScore.value) {
    highScore.value = score.value
  }
  draw()
}

// 键盘控制
const handleKeydown = (e: KeyboardEvent) => {
  if (!gameStarted.value) return

  const key = e.key

  // 暂停控制
  if (key === ' ' || key === 'Escape') {
    e.preventDefault()
    togglePause()
    return
  }

  if (isPaused.value || gameOver.value) return

  // 方向控制
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      if (direction.value !== 'DOWN') {
        nextDirection.value = 'UP'
      }
      e.preventDefault()
      break
    case 'ArrowDown':
    case 's':
    case 'S':
      if (direction.value !== 'UP') {
        nextDirection.value = 'DOWN'
      }
      e.preventDefault()
      break
    case 'ArrowLeft':
    case 'a':
    case 'A':
      if (direction.value !== 'RIGHT') {
        nextDirection.value = 'LEFT'
      }
      e.preventDefault()
      break
    case 'ArrowRight':
    case 'd':
    case 'D':
      if (direction.value !== 'LEFT') {
        nextDirection.value = 'RIGHT'
      }
      e.preventDefault()
      break
  }
}

// 生命周期
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  draw()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (gameLoop) {
    clearInterval(gameLoop)
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-slate-900 to-slate-800 p-4">
    <Card class="w-full max-w-lg">
      <CardHeader class="text-center">
        <CardTitle class="text-3xl font-bold bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent">
          🐍 贪吃蛇游戏
        </CardTitle>
        <CardDescription>
          使用方向键或 WASD 控制蛇的移动
        </CardDescription>
      </CardHeader>
      
      <CardContent class="flex flex-col items-center gap-6">
        <!-- 分数显示 -->
        <div class="flex items-center gap-4">
          <Badge variant="secondary" class="text-lg px-4 py-2">
            得分: {{ score }}
          </Badge>
          <Badge variant="outline" class="text-lg px-4 py-2">
            最高分: {{ highScore }}
          </Badge>
        </div>

        <!-- 游戏画布 -->
        <div class="relative">
          <canvas
            ref="canvas"
            :width="canvasSize"
            :height="canvasSize"
            class="rounded-lg border-2 border-slate-700 shadow-lg shadow-green-500/10"
          ></canvas>
        </div>

        <!-- 控制按钮 -->
        <div class="flex gap-4">
          <Button 
            v-if="!gameStarted || gameOver" 
            @click="startGame"
            size="lg"
            class="bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700"
          >
            {{ gameOver ? '重新开始' : '开始游戏' }}
          </Button>
          <Button 
            v-if="gameStarted && !gameOver" 
            @click="togglePause"
            variant="secondary"
            size="lg"
          >
            {{ isPaused ? '继续' : '暂停' }}
          </Button>
        </div>

        <!-- 游戏说明 -->
        <Card class="w-full bg-slate-800/50 border-slate-700">
          <CardHeader class="pb-2">
            <CardTitle class="text-lg">游戏说明</CardTitle>
          </CardHeader>
          <CardContent class="text-sm text-muted-foreground space-y-2">
            <div class="flex items-center gap-2">
              <Badge variant="outline">↑ ↓ ← →</Badge>
              <span>或</span>
              <Badge variant="outline">W A S D</Badge>
              <span>控制方向</span>
            </div>
            <div class="flex items-center gap-2">
              <Badge variant="outline">空格</Badge>
              <span>或</span>
              <Badge variant="outline">ESC</Badge>
              <span>暂停/继续</span>
            </div>
            <p class="text-muted-foreground">
              吃到红色食物得分，撞墙或撞到自己游戏结束。每得50分速度提升！
            </p>
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  </div>
</template>