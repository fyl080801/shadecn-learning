import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Home.vue'
import About from '@/views/About.vue'
import Example from '@/views/Example.vue'
import Emu3DView from '@/views/Emu3DView.vue'

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
  ],
})

export default router