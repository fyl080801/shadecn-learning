import { createRouter, createWebHistory, START_LOCATION } from "vue-router"
import { fetchSession, goToLoginPage, requestReLogin, useAuth } from "@/lib/auth"
import { setPageTitle } from "@/composables/usePageTitle"

declare module "vue-router" {
  interface RouteMeta {
    /**
     * 标签页标题的「区域名」。
     * 名字要等数据加载才知道的页面（项目、画布），由页面自己用
     * `usePageTitle()` 补成「区域 - 名字」，见 `@/composables/usePageTitle`。
     */
    title?: string
  }
}

// 模板页：带菜单的走 SidebarLayout，独占整屏的走 BlankLayout
import SidebarLayout from "@/layouts/SidebarLayout.vue"
import BlankLayout from "@/layouts/BlankLayout.vue"

// 视图按功能分目录：canvas（项目与画布）/ three（3D）/ games（小游戏）/ demos（单页验证）
import Home from "@/views/Home.vue"
import Demo3 from "@/views/games/Demo3.vue"
import SnakeGame from "@/views/games/SnakeGame.vue"
import Game2048 from "@/views/games/Game2048.vue"
import Canvas3D from "@/views/three/Canvas3D.vue"
import LightScene from "@/views/three/LightScene.vue"
import RichEditor from "@/views/demos/RichEditor.vue"

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // 带菜单的页面：路径仍然是一层平铺的，只是统一挂在 SidebarLayout 下面
    {
      path: "/",
      component: SidebarLayout,
      children: [
        {
          path: "",
          name: "Home",
          component: Home,
          meta: { title: "首页" }
        },
        {
          path: "settings",
          name: "Settings",
          component: () => import("@/views/Settings.vue"),
          meta: { title: "设置" }
        },
        {
          path: "demo3",
          name: "Demo3",
          component: Demo3,
          meta: { title: "打砖块" }
        },
        {
          path: "snake",
          name: "SnakeGame",
          component: SnakeGame,
          meta: { title: "贪吃蛇" }
        },
        {
          path: "2048",
          name: "Game2048",
          component: Game2048,
          meta: { title: "2048" }
        },
        {
          path: "canvas3d",
          name: "Canvas3D",
          component: Canvas3D,
          meta: { title: "机位角度演示" }
        },
        {
          path: "lightscene",
          name: "LightScene",
          component: LightScene,
          meta: { title: "光源方向演示" }
        },
        {
          path: "richeditor",
          name: "RichEditor",
          component: RichEditor,
          meta: { title: "富文本输入" }
        },
        {
          path: "hic",
          name: "HtmlInCanvas",
          component: () => import("@/views/demos/HiC.vue"),
          meta: { title: "Canvas 绘制 DOM" }
        },
        {
          path: "three-editor",
          name: "ThreeEditor",
          component: () => import("@/views/three/ThreeEditor.vue"),
          meta: { title: "场景编辑器" }
        },
        {
          path: "3d-scene",
          name: "3DScene",
          component: () => import("@/views/three/3DScene.vue"),
          meta: { title: "3D 导演台" }
        },
        {
          path: "vue-flow",
          name: "VueFlow",
          component: () => import("@/views/demos/FlowChart.vue"),
          meta: { title: "流程图画布" }
        },
        {
          path: "projects",
          name: "Projects",
          component: () => import("@/views/canvas/Projects.vue"),
          meta: { title: "画布项目" }
        },
        {
          path: "personal",
          name: "PersonalFlows",
          component: () => import("@/views/canvas/PersonalFlows.vue"),
          meta: { title: "个人画布" }
        },
        {
          path: "projects/:projectId",
          name: "ProjectHome",
          component: () => import("@/views/canvas/ProjectHome.vue"),
          props: true,
          meta: { title: "项目" }
        },
        // GalStory 控制台。`/galstory` 本身不是页面，重定向到故事库 ——
        // 侧栏两个入口各自指向自己的路径，这一条只兜住手输 `/galstory` 的情况。
        {
          path: "galstory",
          redirect: "/galstory/stories"
        },
        {
          path: "galstory/stories",
          name: "GalStories",
          component: () => import("@/views/galstory/Stories.vue"),
          meta: { title: "故事库" }
        },
        {
          path: "galstory/stories/:storyId",
          name: "GalStoryDetail",
          component: () => import("@/views/galstory/StoryDetail.vue"),
          props: true,
          meta: { title: "故事" }
        },
        {
          // 对局界面。**仍挂在 SidebarLayout 下**：它的 main 是 `h-0 flex-1`，故这一页
          // 用 `h-full` 就拿得到确定高度，聊天区自己滚 —— 不需要换成 BlankLayout。
          path: "galstory/play/:saveId",
          name: "GalStoryPlay",
          component: () => import("@/views/galstory/Play.vue"),
          props: true,
          meta: { title: "对局" }
        },
        {
          path: "galstory/config",
          name: "GalStoryConfig",
          component: () => import("@/views/galstory/ModelConfig.vue"),
          meta: { title: "模型配置" }
        },
        {
          path: "invite/:token",
          name: "InviteAccept",
          component: () => import("@/views/canvas/InviteAccept.vue"),
          props: true,
          meta: { title: "加入项目" }
        }
      ]
    },
    // 独占整屏的页面：不套侧栏，走另一张模板页
    {
      path: "/",
      component: BlankLayout,
      children: [
        {
          path: "flows/:flowId",
          name: "FlowEditor",
          component: () => import("@/views/canvas/FlowEditor.vue"),
          props: true,
          meta: { title: "画布" }
        }
      ]
    }
  ]
})

/**
 * 兜底守卫。真正的闸门在服务端（server/frontend/guard.ts）：未登录根本拿不到
 * 这份 bundle，所以这里只处理「用着用着会话过期了」——登录页是服务端渲染的，
 * 只能整页跳，不能在 SPA 内部渲染。
 */
router.beforeEach(async (to, from) => {
  await fetchSession()
  const { isAuthenticated, authEnabled } = useAuth()

  // 后端没配 Keycloak：整站放行
  if (!authEnabled.value || isAuthenticated.value) return true

  // 首屏就没会话：页面上本来什么都还没有，问也白问，直接跳
  if (from === START_LOCATION) {
    goToLoginPage(to.fullPath)
    return false
  }

  // 已经在应用里了：留在当前页，弹确认框问一句，用户点了才跳
  requestReLogin(to.fullPath)
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
