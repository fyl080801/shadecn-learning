import { createRouter, createWebHistory } from "vue-router"
import { fetchSession, useAuth } from "@/lib/auth"
import Login from "@/views/Login.vue"
import Home from "@/views/Home.vue"
import About from "@/views/About.vue"
import Demo3 from "@/views/Demo3.vue"
import SnakeGame from "@/views/SnakeGame.vue"
import Game2048 from "@/views/Game2048.vue"
import Canvas3D from "@/views/Canvas3D.vue"
import LightScene from "@/views/LightScene.vue"
import RichEditor from "@/views/RichEditor.vue"

declare module "vue-router" {
  interface RouteMeta {
    /** 免登录页面 */
    public?: boolean
    /** blank = 不套侧栏布局 */
    layout?: "blank"
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      // 唯一不需要登录的页面，也不套侧栏布局
      path: "/login",
      name: "Login",
      component: Login,
      meta: { public: true, layout: "blank" }
    },
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
      component: () => import("@/views/HiC.vue")
    },
    {
      path: "/three-editor",
      name: "ThreeEditor",
      component: () => import("@/views/ThreeEditor.vue")
    },
    {
      path: "/3d-scene",
      name: "3DScene",
      component: () => import("@/views/3DScene.vue")
    },
    {
      path: "/vue-flow",
      name: "VueFlow",
      component: () => import("@/views/FlowChart.vue")
    }
  ]
})

/**
 * 全局守卫：除了 meta.public 的路由，其余都要登录。
 * 登录态来自 /api/auth/me（httpOnly cookie），只在首次导航时问一次。
 */
router.beforeEach(async (to) => {
  await fetchSession()
  const { isAuthenticated, authEnabled } = useAuth()

  // 后端没配 Keycloak：整站放行，登录页也还能打开（会提示没配）
  if (!authEnabled.value) return true

  if (to.meta.public) {
    // 已经登录就别停在登录页了
    if (to.name === "Login" && isAuthenticated.value) {
      const redirect = to.query.redirect
      return typeof redirect === "string" && redirect.startsWith("/") ? redirect : "/"
    }
    return true
  }

  if (!isAuthenticated.value) {
    return { name: "Login", query: { redirect: to.fullPath } }
  }

  return true
})

export default router
