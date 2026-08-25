<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"
import AboutDialog from "@/components/AboutDialog.vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  Info,
  Gamepad2,
  Grid3X3,
  Layers,
  Sun,
  Boxes,
  Video,
  Workflow,
  UserRoundPen,
  BookOpen,
  SlidersHorizontal,
  ChevronsUpDown,
  LogIn,
  LogOut,
  Settings,
  User as UserIcon
} from "@lucide/vue"
import { useAuth } from "@/lib/auth"
import { useAppLayout } from "@/composables/useAppLayout"

interface NavItem {
  label: string
  to: string
  icon: Component
  /**
   * 高亮判据。缺省是路径**全等** —— 详情页（`/galstory/stories/:id`）也要让它所属的
   * 那一项亮着，否则点进去侧栏就整个失去当前位置，所以那类入口写 `prefix`。
   */
  match?: "exact" | "prefix"
}

/**
 * 侧栏分组。`label` 为空的那一组不带标题（就是原来那条平铺的列表）。
 *
 * **为什么要分组**：GalStory 是一整块功能（故事 + 配置，将来还有对局），
 * 平铺进这串演示页里，「这两项是一起的」就只能靠位置猜。
 *
 * 「关于」不在任何一组里 —— 它和「设置」「退出」一起挂在底部的用户菜单下
 * （关于是个模态窗，不是页面）。
 */
interface NavGroup {
  label?: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    items: [
      { label: "Home", to: "/", icon: Home },
      { label: "贪吃蛇", to: "/snake", icon: Gamepad2 },
      { label: "2048", to: "/2048", icon: Grid3X3 },
      { label: "canvas3d", to: "/canvas3d", icon: Layers },
      { label: "lightscene", to: "/lightscene", icon: Sun },
      { label: "richeditor", to: "/richeditor", icon: Sun },
      { label: "Three Editor", to: "/three-editor", icon: Boxes },
      { label: "3D导演台", to: "/3d-scene", icon: Video },
      { label: "画布项目", to: "/projects", icon: Workflow },
      { label: "个人画布", to: "/personal", icon: UserRoundPen }
    ]
  },
  {
    label: "GalStory",
    items: [
      { label: "故事库", to: "/galstory/stories", icon: BookOpen, match: "prefix" },
      { label: "模型配置", to: "/galstory/config", icon: SlidersHorizontal }
    ]
  }
]

const { user, displayName, isAuthenticated, authEnabled, startLogin, startLogout } =
  useAuth()

const route = useRoute()
const router = useRouter()
const { isMobile, collapsed, toggleSidebar, mobileNavOpen, closeMobileNav } =
  useAppLayout()

/**
 * 菜单里那一行显示什么名字。没配 Keycloak 时后端整站放行，这时候说「未登录」
 * 是误导 —— 那是本地开发模式，不是会话没了。
 */
const accountLabel = computed(() =>
  isAuthenticated.value ? displayName.value : authEnabled.value ? "未登录" : "本地模式"
)

/** 当前路由算不算落在这一项上；详情页要让它所属的入口继续亮着（见 NavItem.match） */
function isActive(item: NavItem) {
  return item.match === "prefix" ? route.path.startsWith(item.to) : route.path === item.to
}

/** 菜单项里的跳转：吞掉 router.push 的 promise，免得守卫拦下时留个未处理的 rejection */
function go(path: string) {
  void router.push(path)
}

/** 「关于」的模态窗；菜单项只负责把它打开 */
const aboutOpen = ref(false)

/**
 * 退出前先问一句。退出是整页跳转（要过 Keycloak），点错了就得重新登一遍，
 * 而这一项就挨着「设置」「关于」，误点的代价和距离不成比例。
 */
const logoutConfirm = ref(false)

/** 手机端跳转后收起抽屉；桌面/平板的收缩状态不受路由影响 */
watch(
  () => route.fullPath,
  () => closeMobileNav()
)
</script>

<template>
  <!-- 手机端抽屉的遮罩 -->
  <div
    v-if="isMobile && mobileNavOpen"
    class="fixed inset-0 z-30 bg-black/50"
    @click="closeMobileNav()"
  />

  <aside
    :class="[
      'flex h-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground',
      isMobile
        ? 'fixed inset-y-0 left-0 z-40 w-[260px] max-w-[80vw] transition-transform duration-200 ease-in-out'
        : 'transition-[width] duration-200 ease-in-out',
      isMobile && !mobileNavOpen ? '-translate-x-full' : 'translate-x-0'
    ]"
    :style="isMobile ? undefined : { width: collapsed ? '64px' : '240px' }"
  >
    <!-- Brand header：logo 处同时是收缩开关 -->
    <div
      :class="[
        'flex h-14 items-center gap-2 border-b',
        collapsed ? 'justify-center px-2' : 'px-4'
      ]"
    >
      <!-- 收起状态：logo 位置直接变成展开按钮（悬停时换成图标） -->
      <Button
        v-if="collapsed"
        variant="ghost"
        size="icon"
        class="group"
        title="展开侧边栏"
        @click="toggleSidebar()"
      >
        <img
          src="@/assets/vue.svg"
          class="h-6 w-6 group-hover:hidden"
          alt="Vue logo"
        />
        <PanelLeftOpen class="hidden h-5 w-5 group-hover:block" />
      </Button>

      <template v-else>
        <RouterLink to="/" class="flex items-center gap-2 overflow-hidden">
          <img src="@/assets/vue.svg" class="h-6 w-6 shrink-0" alt="Vue logo" />
          <span class="truncate font-bold">My App</span>
        </RouterLink>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <Badge variant="secondary">v1.0.0</Badge>
          <!-- 手机端是抽屉，收缩开关换成关闭按钮 -->
          <Button
            v-if="isMobile"
            variant="ghost"
            size="icon-sm"
            title="关闭菜单"
            @click="closeMobileNav()"
          >
            <X class="h-4 w-4" />
          </Button>
          <Button
            v-else
            variant="ghost"
            size="icon-sm"
            title="收起侧边栏"
            @click="toggleSidebar()"
          >
            <PanelLeftClose class="h-4 w-4" />
          </Button>
        </div>
      </template>
    </div>

    <!-- Navigation -->
    <nav class="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
      <template v-for="(group, index) in navGroups" :key="group.label ?? index">
        <!-- 收起时没地方写标题，换成一条分隔线：分组关系还在，只是不占宽度 -->
        <div
          v-if="group.label && !collapsed"
          class="px-3 pt-3 pb-1 text-xs font-medium text-sidebar-foreground/50"
        >
          {{ group.label }}
        </div>
        <div v-else-if="group.label" class="mx-2 my-2 border-t" />

        <ul class="flex flex-col gap-1">
          <li v-for="item in group.items" :key="item.to">
            <RouterLink
              :to="item.to"
              :title="collapsed ? item.label : undefined"
              :class="[
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                isActive(item)
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70',
                collapsed ? 'justify-center' : ''
              ]"
            >
              <component :is="item.icon" class="h-4 w-4 shrink-0" />
              <span v-if="!collapsed">{{ item.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </template>
    </nav>

    <!-- 底部用户区：设置、关于、登录/退出都收在这个菜单里 -->
    <div class="border-t p-2">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            :title="collapsed ? accountLabel : undefined"
            :class="[
              'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              collapsed ? 'justify-center' : ''
            ]"
          >
            <!-- 默认头像是透明底的像素图案，底下垫一层圆背景，形状才和无头像时那个圆一致 -->
            <img
              v-if="user?.avatarUrl"
              :src="user.avatarUrl"
              alt=""
              class="size-7 shrink-0 rounded-full bg-sidebar-accent object-cover"
            />
            <span
              v-else
              class="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground"
            >
              <UserIcon class="size-4" />
            </span>

            <div v-if="!collapsed" class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ accountLabel }}</p>
              <p v-if="user?.email" class="truncate text-xs text-muted-foreground">
                {{ user.email }}
              </p>
            </div>

            <ChevronsUpDown v-if="!collapsed" class="size-4 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>

        <!-- 菜单在侧边栏底部，往上弹 -->
        <DropdownMenuContent side="top" align="start" class="w-56">
          <DropdownMenuLabel class="truncate">{{ accountLabel }}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="go('/settings')">
            <Settings />
            设置
          </DropdownMenuItem>
          <DropdownMenuItem @select="aboutOpen = true">
            <Info />
            关于
          </DropdownMenuItem>
          <template v-if="authEnabled">
            <DropdownMenuSeparator />
            <DropdownMenuItem
              v-if="isAuthenticated"
              variant="destructive"
              @select="logoutConfirm = true"
            >
              <LogOut />
              退出登录
            </DropdownMenuItem>
            <DropdownMenuItem v-else @select="startLogin(route.fullPath)">
              <LogIn />
              登录
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </aside>

  <!-- 「关于」：一个模态窗，看完就关，人不离开当前页 -->
  <AboutDialog v-model:open="aboutOpen" />

  <!-- 退出确认：确认之后才整页跳去登出 -->
  <AlertDialog v-model:open="logoutConfirm">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>退出登录？</AlertDialogTitle>
        <AlertDialogDescription>
          退出后需要重新登录才能继续使用；页面上没保存的内容会丢失。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction @click="startLogout(route.fullPath)">退出</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
