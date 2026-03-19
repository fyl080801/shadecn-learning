# 项目页面功能说明

## 项目概述

这是一个基于 Vue 3 + Vite + shadcn-vue 构建的现代化前端项目，包含多个演示页面和小游戏。

---

## 页面列表

### 1. 首页 (Home)

- **路径**: `/`
- **组件**: `src/views/Home.vue`
- **功能描述**:
  - 项目入口页面，展示 Vite 和 Vue 的 Logo
  - 包含一个计数器演示组件，点击按钮可增加计数
  - 使用 shadcn-vue 的 Card、Button、Badge 等组件
  - 提供快速链接到 Vue.js 官方文档

---

### 2. 关于页面 (About)

- **路径**: `/about`
- **组件**: `src/views/About.vue`
- **功能描述**:
  - 展示项目基本信息
  - 介绍项目技术栈：Vue.js、Vite、shadcn-vue、TypeScript
  - 使用 Card 组件展示内容

---

### 3. 交互演示 (Example)

- **路径**: `/example`
- **组件**: `src/views/Example.vue`
- **功能描述**:
  - 交互式点位拖拽演示
  - 用户可以在区域内拖动一个点
  - 点与四个角之间会绘制连线
  - 实时显示点的坐标位置

---

### 4. 3D立方体 (3D Cube)

- **路径**: `/3d-cube`
- **组件**: `src/views/Emu3DView.vue`
- **功能描述**:
  - CSS 3D 变换演示
  - 用户可以通过拖拽旋转立方体
  - 实时显示旋转角度（X轴和Y轴）
  - 使用纯 CSS 实现的 3D 效果

---

### 5. 打砖块游戏 (Demo3)

- **路径**: `/demo3`
- **组件**: `src/views/Demo3.vue`
- **功能描述**:
  - 经典打砖块游戏
  - 使用 Canvas 绘制游戏画面
  - 支持键盘控制挡板移动
  - 游戏特性：
    - 5行10列彩色砖块
    - 3条生命值
    - 实时分数统计
    - 游戏状态管理（开始、暂停、结束、胜利）

---

### 6. 贪吃蛇游戏 (Snake Game)

- **路径**: `/snake`
- **组件**: `src/views/SnakeGame.vue`
- **功能描述**:
  - 经典贪吃蛇游戏
  - 使用 Canvas 绘制游戏画面
  - 游戏特性：
    - 20x20 网格
    - 方向键控制蛇的移动
    - 分数和最高分记录
    - 暂停/继续功能
    - 游戏结束检测

---

### 7. 2048游戏 (Game2048)

- **路径**: `/2048`
- **组件**: `src/views/Game2048.vue`
- **功能描述**:
  - 经典 2048 数字合并游戏
  - 游戏特性：
    - 4x4 网格
    - 方向键或滑动移动方块
    - 分数和最高分记录
    - 游戏结束检测
    - 胜利后可选择继续游戏

---

## 技术栈

| 技术 | 说明 |
|------|------|
| Vue 3 | 前端框架，使用 Composition API |
| Vite | 构建工具 |
| TypeScript | 类型支持 |
| Vue Router | 路由管理 |
| shadcn-vue | UI 组件库 |
| Tailwind CSS | 样式框架 |

---

## 组件结构

```
src/
├── views/           # 页面组件
│   ├── Home.vue
│   ├── About.vue
│   ├── Example.vue
│   ├── Emu3DView.vue
│   ├── Demo3.vue
│   ├── SnakeGame.vue
│   └── Game2048.vue
├── components/      # 通用组件
│   ├── AppHeader.vue
│   ├── Cube3D.vue
│   ├── HelloWorld.vue
│   ├── InteractiveSquare.vue
│   └── ui/          # shadcn-vue UI组件
└── router/          # 路由配置
    └── index.ts