<template>
  <div class="game-container">
    <h1 class="game-title">2048</h1>
    <div class="score-container">
      <div class="score-box">
        <div class="score-label">分数</div>
        <div class="score-value">{{ score }}</div>
      </div>
      <div class="score-box">
        <div class="score-label">最高分</div>
        <div class="score-value">{{ bestScore }}</div>
      </div>
    </div>
    <div class="game-controls">
      <button class="btn-new-game" @click="initGame">新游戏</button>
    </div>
    <div class="game-board">
      <div v-for="(row, rowIndex) in grid" :key="rowIndex" class="grid-row">
        <div
          v-for="(cell, colIndex) in row"
          :key="colIndex"
          class="grid-cell"
          :class="getTileClass(cell)"
        >
          {{ cell || '' }}
        </div>
      </div>
    </div>
    <div class="game-instructions">
      <p>使用方向键或滑动来移动方块</p>
      <p>合并相同数字的方块达到2048!</p>
    </div>
    <div v-if="gameOver" class="game-overlay">
      <div class="game-over-content">
        <h2>游戏结束!</h2>
        <p>最终分数: {{ score }}</p>
        <button class="btn-restart" @click="initGame">再玩一次</button>
      </div>
    </div>
    <div v-if="won && !continueGame" class="game-overlay win">
      <div class="game-over-content">
        <h2>恭喜获胜!</h2>
        <p>你达到了2048!</p>
        <div class="win-buttons">
          <button class="btn-restart" @click="initGame">新游戏</button>
          <button class="btn-continue" @click="continuePlaying">继续游戏</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const gridSize = 4
const grid = ref<number[][]>([])
const score = ref(0)
const bestScore = ref(0)
const gameOver = ref(false)
const won = ref(false)
const continueGame = ref(false)

// 初始化游戏
const initGame = () => {
  grid.value = Array(gridSize).fill(null).map(() => Array(gridSize).fill(0))
  score.value = 0
  gameOver.value = false
  won.value = false
  continueGame.value = false
  addRandomTile()
  addRandomTile()
}

// 添加随机方块
const addRandomTile = () => {
  const emptyCells: { row: number; col: number }[] = []
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      if (grid.value[i][j] === 0) {
        emptyCells.push({ row: i, col: j })
      }
    }
  }
  if (emptyCells.length > 0) {
    const randomCell = emptyCells[Math.floor(Math.random() * emptyCells.length)]
    grid.value[randomCell.row][randomCell.col] = Math.random() < 0.9 ? 2 : 4
  }
}

// 获取方块样式类
const getTileClass = (value: number) => {
  return {
    'tile-2': value === 2,
    'tile-4': value === 4,
    'tile-8': value === 8,
    'tile-16': value === 16,
    'tile-32': value === 32,
    'tile-64': value === 64,
    'tile-128': value === 128,
    'tile-256': value === 256,
    'tile-512': value === 512,
    'tile-1024': value === 1024,
    'tile-2048': value === 2048,
    'tile-super': value > 2048,
  }
}

// 滑动逻辑
const slide = (row: number[]): number[] => {
  let arr = row.filter(val => val !== 0)
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] === arr[i + 1]) {
      arr[i] *= 2
      score.value += arr[i]
      arr.splice(i + 1, 1)
      if (arr[i] === 2048 && !won.value && !continueGame.value) {
        won.value = true
      }
    }
  }
  while (arr.length < gridSize) {
    arr.push(0)
  }
  return arr
}

// 移动方向
const moveLeft = () => {
  let moved = false
  for (let i = 0; i < gridSize; i++) {
    const newRow = slide([...grid.value[i]])
    if (JSON.stringify(newRow) !== JSON.stringify(grid.value[i])) {
      moved = true
    }
    grid.value[i] = newRow
  }
  return moved
}

const moveRight = () => {
  let moved = false
  for (let i = 0; i < gridSize; i++) {
    const newRow = slide([...grid.value[i]].reverse()).reverse()
    if (JSON.stringify(newRow) !== JSON.stringify(grid.value[i])) {
      moved = true
    }
    grid.value[i] = newRow
  }
  return moved
}

const moveUp = () => {
  let moved = false
  for (let j = 0; j < gridSize; j++) {
    let col = []
    for (let i = 0; i < gridSize; i++) {
      col.push(grid.value[i][j])
    }
    const newCol = slide(col)
    for (let i = 0; i < gridSize; i++) {
      if (grid.value[i][j] !== newCol[i]) {
        moved = true
      }
      grid.value[i][j] = newCol[i]
    }
  }
  return moved
}

const moveDown = () => {
  let moved = false
  for (let j = 0; j < gridSize; j++) {
    let col = []
    for (let i = 0; i < gridSize; i++) {
      col.push(grid.value[i][j])
    }
    const newCol = slide(col.reverse()).reverse()
    for (let i = 0; i < gridSize; i++) {
      if (grid.value[i][j] !== newCol[i]) {
        moved = true
      }
      grid.value[i][j] = newCol[i]
    }
  }
  return moved
}

// 检查游戏是否结束
const checkGameOver = () => {
  // 检查是否有空格
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      if (grid.value[i][j] === 0) return false
    }
  }
  // 检查是否有可合并的相邻方块
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      if (j < gridSize - 1 && grid.value[i][j] === grid.value[i][j + 1]) return false
      if (i < gridSize - 1 && grid.value[i][j] === grid.value[i + 1][j]) return false
    }
  }
  return true
}

// 处理移动
const handleMove = (direction: 'left' | 'right' | 'up' | 'down') => {
  if (gameOver.value || (won.value && !continueGame.value)) return

  let moved = false
  switch (direction) {
    case 'left':
      moved = moveLeft()
      break
    case 'right':
      moved = moveRight()
      break
    case 'up':
      moved = moveUp()
      break
    case 'down':
      moved = moveDown()
      break
  }

  if (moved) {
    addRandomTile()
    if (score.value > bestScore.value) {
      bestScore.value = score.value
      localStorage.setItem('bestScore2048', bestScore.value.toString())
    }
    if (checkGameOver()) {
      gameOver.value = true
    }
  }
}

// 继续游戏
const continuePlaying = () => {
  continueGame.value = true
}

// 键盘事件处理
const handleKeydown = (e: KeyboardEvent) => {
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault()
      handleMove('left')
      break
    case 'ArrowRight':
      e.preventDefault()
      handleMove('right')
      break
    case 'ArrowUp':
      e.preventDefault()
      handleMove('up')
      break
    case 'ArrowDown':
      e.preventDefault()
      handleMove('down')
      break
  }
}

// 触摸事件处理
let touchStartX = 0
let touchStartY = 0

const handleTouchStart = (e: TouchEvent) => {
  touchStartX = e.touches[0].clientX
  touchStartY = e.touches[0].clientY
}

const handleTouchEnd = (e: TouchEvent) => {
  const touchEndX = e.changedTouches[0].clientX
  const touchEndY = e.changedTouches[0].clientY
  const diffX = touchEndX - touchStartX
  const diffY = touchEndY - touchStartY
  const minSwipeDistance = 50

  if (Math.abs(diffX) > Math.abs(diffY)) {
    if (Math.abs(diffX) > minSwipeDistance) {
      handleMove(diffX > 0 ? 'right' : 'left')
    }
  } else {
    if (Math.abs(diffY) > minSwipeDistance) {
      handleMove(diffY > 0 ? 'down' : 'up')
    }
  }
}

onMounted(() => {
  const savedBestScore = localStorage.getItem('bestScore2048')
  if (savedBestScore) {
    bestScore.value = parseInt(savedBestScore)
  }
  initGame()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.game-container {
  max-width: 500px;
  margin: 0 auto;
  padding: 20px;
  text-align: center;
  user-select: none;
}

.game-title {
  font-size: 60px;
  font-weight: bold;
  color: #776e65;
  margin: 0;
}

.score-container {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin: 20px 0;
}

.score-box {
  background: #bbada0;
  padding: 10px 25px;
  border-radius: 3px;
  color: white;
}

.score-label {
  font-size: 13px;
  color: #eee4da;
  text-transform: uppercase;
}

.score-value {
  font-size: 25px;
  font-weight: bold;
}

.game-controls {
  margin: 20px 0;
}

.btn-new-game {
  background: #8f7a66;
  border: none;
  color: white;
  padding: 10px 20px;
  font-size: 18px;
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.3s;
}

.btn-new-game:hover {
  background: #9f8b77;
}

.game-board {
  background: #bbada0;
  border-radius: 6px;
  padding: 15px;
  position: relative;
  touch-action: none;
}

.grid-row {
  display: flex;
  margin-bottom: 15px;
}

.grid-row:last-child {
  margin-bottom: 0;
}

.grid-cell {
  width: 100px;
  height: 100px;
  background: rgba(238, 228, 218, 0.35);
  border-radius: 3px;
  margin-right: 15px;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 55px;
  font-weight: bold;
  color: #776e65;
  transition: all 0.15s ease;
}

.grid-cell:last-child {
  margin-right: 0;
}

.tile-2 { background: #eee4da; }
.tile-4 { background: #ede0c8; }
.tile-8 { background: #f2b179; color: white; }
.tile-16 { background: #f59563; color: white; }
.tile-32 { background: #f67c5f; color: white; }
.tile-64 { background: #f65e3b; color: white; }
.tile-128 { background: #edcf72; color: white; font-size: 45px; }
.tile-256 { background: #edcc61; color: white; font-size: 45px; }
.tile-512 { background: #edc850; color: white; font-size: 45px; }
.tile-1024 { background: #edc53f; color: white; font-size: 35px; }
.tile-2048 { background: #edc22e; color: white; font-size: 35px; }
.tile-super { background: #3c3a32; color: white; font-size: 30px; }

.game-instructions {
  margin-top: 20px;
  color: #776e65;
  font-size: 14px;
}

.game-instructions p {
  margin: 5px 0;
}

.game-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(238, 228, 218, 0.73);
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 6px;
  z-index: 100;
}

.game-overlay.win {
  background: rgba(237, 194, 46, 0.5);
}

.game-over-content {
  text-align: center;
}

.game-over-content h2 {
  font-size: 40px;
  color: #776e65;
  margin: 0 0 20px 0;
}

.game-over-content p {
  font-size: 20px;
  color: #776e65;
  margin-bottom: 20px;
}

.win-buttons {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.btn-restart,
.btn-continue {
  background: #8f7a66;
  border: none;
  color: white;
  padding: 10px 20px;
  font-size: 18px;
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.3s;
}

.btn-restart:hover,
.btn-continue:hover {
  background: #9f8b77;
}

@media (max-width: 500px) {
  .game-container {
    padding: 10px;
  }
  
  .game-title {
    font-size: 40px;
  }
  
  .grid-cell {
    width: 70px;
    height: 70px;
    font-size: 35px;
    margin-right: 10px;
  }
  
  .grid-row {
    margin-bottom: 10px;
  }
  
  .game-board {
    padding: 10px;
  }
  
  .tile-128,
  .tile-256,
  .tile-512 {
    font-size: 30px;
  }
  
  .tile-1024,
  .tile-2048 {
    font-size: 25px;
  }
  
  .tile-super {
    font-size: 20px;
  }
}
</style>