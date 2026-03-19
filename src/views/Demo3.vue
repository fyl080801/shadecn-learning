<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'

// 游戏状态类型
type GameState = 'idle' | 'playing' | 'paused' | 'gameOver' | 'won'

// 游戏配置
const config = {
  canvasWidth: 800,
  canvasHeight: 600,
  paddleWidth: 100,
  paddleHeight: 15,
  paddleSpeed: 8,
  ballRadius: 8,
  ballSpeed: 5,
  brickRows: 5,
  brickCols: 10,
  brickWidth: 70,
  brickHeight: 25,
  brickPadding: 8,
  brickOffsetTop: 60,
  brickOffsetLeft: 35,
  initialLives: 3
}

// 游戏状态
const gameState = ref<GameState>('idle')
const score = ref(0)
const lives = ref(config.initialLives)
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let animationId: number | null = null

// 挡板
const paddle = ref({
  x: config.canvasWidth / 2 - config.paddleWidth / 2,
  y: config.canvasHeight - 40,
  width: config.paddleWidth,
  height: config.paddleHeight,
  dx: 0
})

// 球
const ball = ref({
  x: config.canvasWidth / 2,
  y: config.canvasHeight - 60,
  radius: config.ballRadius,
  dx: config.ballSpeed,
  dy: -config.ballSpeed,
  attached: true // 是否附着在挡板上
})

// 砖块
interface Brick {
  x: number
  y: number
  width: number
  height: number
  alive: boolean
  color: string
}

const bricks = ref<Brick[]>([])
const bricksRemaining = computed(() => bricks.value.filter(b => b.alive).length)

// 砖块颜色
const brickColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6'] as const

// 初始化砖块
const initBricks = () => {
  bricks.value = []
  for (let row = 0; row < config.brickRows; row++) {
    for (let col = 0; col < config.brickCols; col++) {
      const x = col * (config.brickWidth + config.brickPadding) + config.brickOffsetLeft
      const y = row * (config.brickHeight + config.brickPadding) + config.brickOffsetTop
      bricks.value.push({
        x,
        y,
        width: config.brickWidth,
        height: config.brickHeight,
        alive: true,
        color: brickColors[row % brickColors.length]
      })
    }
  }
}

// 重置游戏
const resetGame = () => {
  score.value = 0
  lives.value = config.initialLives
  gameState.value = 'idle'
  
  paddle.value = {
    x: config.canvasWidth / 2 - config.paddleWidth / 2,
    y: config.canvasHeight - 40,
    width: config.paddleWidth,
    height: config.paddleHeight,
    dx: 0
  }
  
  ball.value = {
    x: config.canvasWidth / 2,
    y: config.canvasHeight - 60,
    radius: config.ballRadius,
    dx: config.ballSpeed * (Math.random() > 0.5 ? 1 : -1),
    dy: -config.ballSpeed,
    attached: true
  }
  
  initBricks()
}

// 开始游戏
const startGame = () => {
  if (gameState.value === 'idle' || gameState.value === 'gameOver' || gameState.value === 'won') {
    resetGame()
  }
  gameState.value = 'playing'
  ball.value.attached = false
}

// 暂停游戏
const togglePause = () => {
  if (gameState.value === 'playing') {
    gameState.value = 'paused'
  } else if (gameState.value === 'paused') {
    gameState.value = 'playing'
  }
}

// 键盘事件
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
    paddle.value.dx = -config.paddleSpeed
  } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
    paddle.value.dx = config.paddleSpeed
  } else if (e.key === ' ') {
    e.preventDefault()
    if (gameState.value === 'idle' || gameState.value === 'gameOver' || gameState.value === 'won') {
      startGame()
    } else if (ball.value.attached && gameState.value === 'playing') {
      ball.value.attached = false
    } else {
      togglePause()
    }
  }
}

const handleKeyUp = (e: KeyboardEvent) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A' || 
      e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
    paddle.value.dx = 0
  }
}

// 鼠标事件
const handleMouseMove = (e: MouseEvent) => {
  if (!canvasRef.value || gameState.value !== 'playing') return
  
  const rect = canvasRef.value.getBoundingClientRect()
  const scaleX = config.canvasWidth / rect.width
  const mouseX = (e.clientX - rect.left) * scaleX
  
  paddle.value.x = Math.max(0, Math.min(config.canvasWidth - paddle.value.width, mouseX - paddle.value.width / 2))
  
  if (ball.value.attached) {
    ball.value.x = paddle.value.x + paddle.value.width / 2
  }
}

const handleClick = () => {
  if (gameState.value === 'idle' || gameState.value === 'gameOver' || gameState.value === 'won') {
    startGame()
  } else if (ball.value.attached && gameState.value === 'playing') {
    ball.value.attached = false
  }
}

// 碰撞检测
const checkPaddleCollision = () => {
  const b = ball.value
  const p = paddle.value
  
  if (b.y + b.radius >= p.y && 
      b.y - b.radius <= p.y + p.height &&
      b.x >= p.x && 
      b.x <= p.x + p.width) {
    
    // 根据球击中挡板的位置调整反弹角度
    const hitPos = (b.x - p.x) / p.width // 0 到 1
    const angle = (hitPos - 0.5) * Math.PI * 0.6 // -54° 到 54°
    
    const speed = Math.sqrt(b.dx * b.dx + b.dy * b.dy)
    b.dx = speed * Math.sin(angle)
    b.dy = -Math.abs(speed * Math.cos(angle))
    
    b.y = p.y - b.radius
  }
}

const checkBrickCollision = () => {
  const b = ball.value
  
  for (const brick of bricks.value) {
    if (!brick.alive) continue
    
    if (b.x + b.radius > brick.x && 
        b.x - b.radius < brick.x + brick.width &&
        b.y + b.radius > brick.y && 
        b.y - b.radius < brick.y + brick.height) {
      
      // 判断碰撞方向
      const overlapLeft = b.x + b.radius - brick.x
      const overlapRight = brick.x + brick.width - (b.x - b.radius)
      const overlapTop = b.y + b.radius - brick.y
      const overlapBottom = brick.y + brick.height - (b.y - b.radius)
      
      const minOverlapX = Math.min(overlapLeft, overlapRight)
      const minOverlapY = Math.min(overlapTop, overlapBottom)
      
      if (minOverlapX < minOverlapY) {
        b.dx = -b.dx
      } else {
        b.dy = -b.dy
      }
      
      brick.alive = false
      score.value += 10
      
      // 检查是否胜利
      if (bricksRemaining.value === 0) {
        gameState.value = 'won'
      }
      
      return
    }
  }
}

// 更新游戏状态
const update = () => {
  if (gameState.value !== 'playing') return
  
  const b = ball.value
  const p = paddle.value
  
  // 更新挡板位置
  if (!b.attached) {
    p.x += p.dx
    p.x = Math.max(0, Math.min(config.canvasWidth - p.width, p.x))
  }
  
  // 如果球附着在挡板上
  if (b.attached) {
    b.x = p.x + p.width / 2
    b.y = p.y - b.radius - 2
    return
  }
  
  // 更新球位置
  b.x += b.dx
  b.y += b.dy
  
  // 墙壁碰撞
  if (b.x - b.radius <= 0 || b.x + b.radius >= config.canvasWidth) {
    b.dx = -b.dx
    b.x = Math.max(b.radius, Math.min(config.canvasWidth - b.radius, b.x))
  }
  
  if (b.y - b.radius <= 0) {
    b.dy = -b.dy
    b.y = b.radius
  }
  
  // 球掉落
  if (b.y + b.radius >= config.canvasHeight) {
    lives.value--
    
    if (lives.value <= 0) {
      gameState.value = 'gameOver'
    } else {
      b.attached = true
      b.x = p.x + p.width / 2
      b.y = p.y - b.radius - 2
      b.dx = config.ballSpeed * (Math.random() > 0.5 ? 1 : -1)
      b.dy = -config.ballSpeed
    }
  }
  
  // 碰撞检测
  checkPaddleCollision()
  checkBrickCollision()
}

// 绘制游戏
const draw = () => {
  if (!ctx) return
  
  // 清空画布
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, config.canvasWidth, config.canvasHeight)
  
  // 绘制砖块
  for (const brick of bricks.value) {
    if (!brick.alive) continue
    
    ctx.fillStyle = brick.color
    ctx.beginPath()
    ctx.roundRect(brick.x, brick.y, brick.width, brick.height, 4)
    ctx.fill()
    
    // 砖块高光
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
    ctx.fillRect(brick.x, brick.y, brick.width, brick.height / 3)
  }
  
  // 绘制挡板
  const p = paddle.value
  const gradient = ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.height)
  gradient.addColorStop(0, '#60a5fa')
  gradient.addColorStop(1, '#3b82f6')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.roundRect(p.x, p.y, p.width, p.height, 8)
  ctx.fill()
  
  // 挡板高光
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.fillRect(p.x + 5, p.y + 2, p.width - 10, 4)
  
  // 绘制球
  const b = ball.value
  const ballGradient = ctx.createRadialGradient(b.x - 2, b.y - 2, 0, b.x, b.y, b.radius)
  ballGradient.addColorStop(0, '#ffffff')
  ballGradient.addColorStop(1, '#e0e0e0')
  ctx.fillStyle = ballGradient
  ctx.beginPath()
  ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2)
  ctx.fill()
  
  // 绘制分数和生命值
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 20px Arial'
  ctx.textAlign = 'left'
  ctx.fillText(`分数: ${score.value}`, 20, 30)
  
  ctx.textAlign = 'right'
  ctx.fillText(`生命: ${'❤️'.repeat(lives.value)}`, config.canvasWidth - 20, 30)
  
  // 游戏状态提示
  ctx.textAlign = 'center'
  
  if (gameState.value === 'idle') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(0, config.canvasHeight / 2 - 60, config.canvasWidth, 120)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 32px Arial'
    ctx.fillText('打砖块游戏', config.canvasWidth / 2, config.canvasHeight / 2 - 15)
    ctx.font = '18px Arial'
    ctx.fillText('点击或按空格键开始游戏', config.canvasWidth / 2, config.canvasHeight / 2 + 20)
  } else if (gameState.value === 'paused') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(0, config.canvasHeight / 2 - 40, config.canvasWidth, 80)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 28px Arial'
    ctx.fillText('游戏暂停', config.canvasWidth / 2, config.canvasHeight / 2 + 10)
  } else if (gameState.value === 'gameOver') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(0, config.canvasHeight / 2 - 80, config.canvasWidth, 160)
    ctx.fillStyle = '#ef4444'
    ctx.font = 'bold 36px Arial'
    ctx.fillText('游戏结束', config.canvasWidth / 2, config.canvasHeight / 2 - 20)
    ctx.fillStyle = '#ffffff'
    ctx.font = '20px Arial'
    ctx.fillText(`最终得分: ${score.value}`, config.canvasWidth / 2, config.canvasHeight / 2 + 20)
    ctx.font = '16px Arial'
    ctx.fillText('点击或按空格键重新开始', config.canvasWidth / 2, config.canvasHeight / 2 + 50)
  } else if (gameState.value === 'won') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(0, config.canvasHeight / 2 - 80, config.canvasWidth, 160)
    ctx.fillStyle = '#22c55e'
    ctx.font = 'bold 36px Arial'
    ctx.fillText('恭喜通关！', config.canvasWidth / 2, config.canvasHeight / 2 - 20)
    ctx.fillStyle = '#ffffff'
    ctx.font = '20px Arial'
    ctx.fillText(`最终得分: ${score.value}`, config.canvasWidth / 2, config.canvasHeight / 2 + 20)
    ctx.font = '16px Arial'
    ctx.fillText('点击或按空格键重新开始', config.canvasWidth / 2, config.canvasHeight / 2 + 50)
  } else if (gameState.value === 'playing' && ball.value.attached) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
    ctx.font = '16px Arial'
    ctx.fillText('点击或按空格键发射球', config.canvasWidth / 2, config.canvasHeight / 2 + 50)
  }
}

// 游戏循环
const gameLoop = () => {
  update()
  draw()
  animationId = requestAnimationFrame(gameLoop)
}

// 初始化
onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  
  ctx = canvas.getContext('2d')
  if (!ctx) return
  
  canvas.width = config.canvasWidth
  canvas.height = config.canvasHeight
  
  resetGame()
  
  // 添加事件监听
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  
  // 开始游戏循环
  gameLoop()
})

onUnmounted(() => {
  // 移除事件监听
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  
  // 取消动画帧
  if (animationId) {
    cancelAnimationFrame(animationId)
  }
})
</script>

<template>
  <div class="game-container">
    <div class="game-wrapper">
      <canvas 
        ref="canvasRef" 
        class="game-canvas"
        @mousemove="handleMouseMove"
        @click="handleClick"
      ></canvas>
      
      <div class="game-controls">
        <div class="control-info">
          <span class="key">← →</span> 或 <span class="key">A D</span> 移动挡板
        </div>
        <div class="control-info">
          <span class="key">空格</span> 开始/发射/暂停
        </div>
        <div class="control-info">
          <span class="key">鼠标</span> 控制挡板移动
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  padding: 20px;
  box-sizing: border-box;
}

.game-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.game-canvas {
  border: 3px solid #3b82f6;
  border-radius: 12px;
  box-shadow: 
    0 0 30px rgba(59, 130, 246, 0.3),
    0 10px 40px rgba(0, 0, 0, 0.5);
  cursor: pointer;
  max-width: 100%;
  height: auto;
}

.game-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 20px;
  padding: 15px 25px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.control-info {
  color: #94a3b8;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.key {
  display: inline-block;
  padding: 4px 10px;
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid #3b82f6;
  border-radius: 6px;
  color: #60a5fa;
  font-weight: 600;
  font-size: 12px;
}

@media (max-width: 850px) {
  .game-container {
    padding: 10px;
  }
  
  .game-controls {
    gap: 10px;
    padding: 10px 15px;
  }
  
  .control-info {
    font-size: 12px;
  }
}

@media (max-width: 500px) {
  .game-controls {
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
}
</style>