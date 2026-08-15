import { createRouter, createWebHistory } from "vue-router"
import { fetchSession, goToLoginPage, useAuth } from "@/lib/auth"
import { setPageTitle } from "@/composables/usePageTitle"

declare module "vue-router" {
  interface RouteMeta {
    /** 'bare' = 不套侧栏，页面自己占满整屏 */
    layout?: "bare"
    /**
     * 标签页标题的「区域名」。
     * 名字要等数据加载才知道的页面（项目、画布），由页面自己用
     * `usePageTitle()` 补成「区域 - 名字」，见 `@/composables/usePageTitle`。
     */
    title?: string
  }
}

// 视图按功能分目录：canvas（项目与画布）/ three（3D）/ games（小游戏）/ demos（单页验证）
import Home from "@/views/Home.vue"
import About from "@/views/About.vue"
import Demo3 from "@/views/games/Demo3.vue"
import SnakeGame from "@/views/games/SnakeGame.vue"
import Game2048 from "@/views/games/Game2048.vue"
import Canvas3D from "@/views/three/Canvas3D.vue"
import LightScene from "@/views/three/LightScene.vue"
import RichEditor from "@/views/demos/RichEditor.vue"

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "Home",
      component: Home,
      meta: { title: "首页" }
    },
    {
      path: "/about",
      name: "About",
      component: About,
      meta: { title: "关于" }
    },
    {
      path: "/demo3",
      name: "Demo3",
      component: Demo3,
      meta: { title: "打砖块" }
    },
    {
      path: "/snake",
      name: "SnakeGame",
      component: SnakeGame,
      meta: { title: "贪吃蛇" }
    },
    {
      path: "/2048",
      name: "Game2048",
      component: Game2048,
      meta: { title: "2048" }
    },
    {
      path: "/canvas3d",
      name: "Canvas3D",
      component: Canvas3D,
      meta: { title: "机位角度演示" }
    },
    {
      path: "/lightscene",
      name: "LightScene",
      component: LightScene,
      meta: { title: "光源方向演示" }
    },
    {
      path: "/richeditor",
      name: "RichEditor",
      component: RichEditor,
      meta: { title: "富文本输入" }
    },
    {
      path: "/hic",
      name: "HtmlInCanvas",
      component: () => import("@/views/demos/HiC.vue"),
      meta: { title: "Canvas 绘制 DOM" }
    },
    {
      path: "/three-editor",
      name: "ThreeEditor",
      component: () => import("@/views/three/ThreeEditor.vue"),
      meta: { title: "场景编辑器" }
    },
    {
      path: "/3d-scene",
      name: "3DScene",
      component: () => import("@/views/three/3DScene.vue"),
      meta: { title: "3D 导演台" }
    },
    {
      path: "/vue-flow",
      name: "VueFlow",
      component: () => import("@/views/demos/FlowChart.vue"),
      meta: { title: "流程图画布" }
    },
    {
      path: "/projects",
      name: "Projects",
      component: () => import("@/views/canvas/Projects.vue"),
      meta: { title: "画布项目" }
    },
    {
      path: "/projects/:projectId",
      name: "ProjectHome",
      component: () => import("@/views/canvas/ProjectHome.vue"),
      props: true,
      meta: { title: "项目" }
    },
    {
      path: "/invite/:token",
      name: "InviteAccept",
      component: () => import("@/views/canvas/InviteAccept.vue"),
      props: true,
      meta: { title: "加入项目" }
    },
    {
      // 画布编辑器独占整屏：不套侧栏（见 App.vue 的 bare 分支）
      path: "/flows/:flowId",
      name: "FlowEditor",
      component: () => import("@/views/canvas/FlowEditor.vue"),
      props: true,
      meta: { title: "画布", layout: "bare" }
    }
  ]
})

/**
 * 兜底守卫。真正的闸门在服务端（server/frontend/guard.ts）：未登录根本拿不到
 * 这份 bundle，所以这里只处理「用着用着会话过期了」——整页跳到服务端渲染的
 * /login，而不是在 SPA 内部渲染一个登录页。
 */
router.beforeEach(async (to) => {
  await fetchSession()
  const { isAuthenticated, authEnabled } = useAuth()

  // 后端没配 Keycloak：整站放行
  if (!authEnabled.value || isAuthenticated.value) return true

  goToLoginPage(to.fullPath)
  return false
})

/**
 * 标题先按路由的区域名写一遍；带数据的页面加载完会再覆盖成「区域 - 名字」。
 * 放在 afterEach 而不是 beforeEach：导航被守卫拦下时不该改标题。
 */
router.afterEach((to) => {
  if (to.meta.title) setPageTitle(to.meta.title)
})

export default router
