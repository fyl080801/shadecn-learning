import { createRouter, createWebHistory } from "vue-router"
import Home from "@/views/Home.vue"
import About from "@/views/About.vue"
import Demo3 from "@/views/Demo3.vue"
import SnakeGame from "@/views/SnakeGame.vue"
import Game2048 from "@/views/Game2048.vue"
import Canvas3D from "@/views/Canvas3D.vue"
import LightScene from "@/views/LightScene.vue"
import RichEditor from "@/views/RichEditor.vue"

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "Home",
      component: Home
    },
    {
      path: "/about",
      name: "About",
      component: About
    },
    {
      path: "/demo3",
      name: "Demo3",
      component: Demo3
    },
    {
      path: "/snake",
      name: "SnakeGame",
      component: SnakeGame
    },
    {
      path: "/2048",
      name: "Game2048",
      component: Game2048
    },
    {
      path: "/canvas3d",
      name: "Canvas3D",
      component: Canvas3D
    },
    {
      path: "/lightscene",
      name: "LightScene",
      component: LightScene
    },
    {
      path: "/richeditor",
      name: "RichEditor",
      component: RichEditor
    },
    {
      path: "/hic",
      name: "HtmlInCanvas",
      component: () => import('@/views/HiC.vue')
    },
    {
      path: "/three-editor",
      name: "ThreeEditor",
      component: () => import('@/views/ThreeEditor.vue')
    },
    {
      path: "/3d-scene",
      name: "3DScene",
      component: () => import('@/views/3DScene.vue')
    }
  ]
})

export default router
