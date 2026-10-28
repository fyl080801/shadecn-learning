import { computed, ref } from "vue"
import { useMediaQuery, useStorage } from "@vueuse/core"

/** 三档规格：手机 < 768，平板 768–1023，桌面 ≥ 1024 */
export const MOBILE_MAX_WIDTH = 767
export const DESKTOP_MIN_WIDTH = 1024

export type DeviceKind = "mobile" | "tablet" | "desktop"

/**
 * 侧边栏的收缩偏好。
 * "auto" = 用户没手动切过，跟随当前档位的默认值（平板收起、桌面展开）；
 * 一旦手动切过就固定成 collapsed / expanded —— 这样档位自动切换（甚至刷新页面）
 * 前后，收缩状态保持不变，不会被断点重置。
 */
type CollapsePreference = "auto" | "collapsed" | "expanded"

/**
 * 状态放在模块级，是因为侧边栏和外壳布局都要读同一份：
 * 组件内各建一份的话，两边的抽屉开关就对不上了。
 */
const collapsePreference = useStorage<CollapsePreference>(
  "app:sidebar-collapse",
  "auto"
)

/** 手机端抽屉的开合，和收缩偏好完全分开存，所以进出手机档不会弄丢偏好 */
const mobileNavOpen = ref(false)

export function useAppLayout() {
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
  const isDesktop = useMediaQuery(`(min-width: ${DESKTOP_MIN_WIDTH}px)`)

  const device = computed<DeviceKind>(() =>
    isMobile.value ? "mobile" : isDesktop.value ? "desktop" : "tablet"
  )
  const isTablet = computed(() => device.value === "tablet")

  /** 手机端是抽屉，展开时永远是全宽，收缩态只对平板/桌面有意义 */
  const collapsed = computed(() => {
    if (isMobile.value) return false
    if (collapsePreference.value === "auto") return isTablet.value
    return collapsePreference.value === "collapsed"
  })

  const toggleSidebar = () => {
    collapsePreference.value = collapsed.value ? "expanded" : "collapsed"
  }

  const openMobileNav = () => {
    mobileNavOpen.value = true
  }

  const closeMobileNav = () => {
    mobileNavOpen.value = false
  }

  return {
    device,
    isMobile,
    isTablet,
    isDesktop,
    collapsed,
    toggleSidebar,
    mobileNavOpen,
    openMobileNav,
    closeMobileNav
  }
}
