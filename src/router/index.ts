import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Home.vue'
import About from '@/views/About.vue'
import Example from '@/views/Example.vue'
import Emu3DView from '@/views/Emu3DView.vue'
import Demo3 from '@/views/Demo3.vue'
import SnakeGame from '@/views/SnakeGame.vue'
import Game2048 from '@/views/Game2048.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Home',
      component: Home,
    },
    {
      path: '/about',
      name: 'About',
      component: About,
    },
    {
      path: '/example',
      name: 'Example',
      component: Example,
    },
    {
      path: '/3d-cube',
      name: '3DCube',
      component: Emu3DView,
    },
    {
      path: '/demo3',
      name: 'Demo3',
      component: Demo3,
    },
    {
      path: '/snake',
      name: 'SnakeGame',
      component: SnakeGame,
    },
    {
      path: '/2048',
      name: 'Game2048',
      component: Game2048,
    },
  ],
})

export default router