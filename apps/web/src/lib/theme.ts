import { computed, watch, type ComputedRef, type Ref } from "vue"
import { useColorMode } from "@vueuse/core"

/**
 * 主题：深色 / 浅色 / 跟随系统。
 *
 * 配色本身早就齐了 —— `src/styles/tailwind.css` 里 `:root` 和 `.dark` 两套变量是
 * shadcn 带来的，`@custom-variant dark (&:is(.dark *))` 也在。缺的只是**没人往
 * `<html>` 上加那个 `.dark` 类**，所以这里做的就是这一件事。
 *
 * 和日期偏好（`@/lib/preferences`）、侧栏收缩（`useAppLayout`）一个路数：
 * 只存这台浏览器的 localStorage（`app:theme`），不上服务端 —— 它描述的是
 * 「这块屏幕上想看到什么」，跟账号无关。
 *
 * **首屏的闪白由 `index.html` 里那段内联脚本负责**，不是这里：这个模块要等
 * Vue 的 bundle 下载、解析完才跑得到，那之前页面已经按 `:root`（浅色）画过一帧了。
 */

export const THEME_STORAGE_KEY = "app:theme"

/** 「跟随系统」这一档，取 `prefers-color-scheme` */
export const THEME_AUTO = "auto"

export const THEMES = [THEME_AUTO, "light", "dark"] as const

export type ThemePreference = (typeof THEMES)[number]
/** 实际生效的那两档，auto 已经被解析掉了 */
export type ResolvedTheme = "light" | "dark"

/**
 * 模块级的一份。`useColorMode` 负责三件事：读写 localStorage、监听系统的
 * `prefers-color-scheme`、把结果作为类名写到 `<html>` 上（`light` / `dark`，
 * 切换时两个类互相摘）。
 */
const colorMode = useColorMode({
  storageKey: THEME_STORAGE_KEY,
  initialValue: THEME_AUTO,
  /**
   * 切换的一瞬间把全站的 transition 都掐掉。不掐的话，各处元素的背景色、边框色
   * 按各自的时长慢慢过渡到新主题，中间那几百毫秒是一堆对不上的颜色，看着像糊了一下。
   */
  disableTransition: true
})

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEMES as readonly unknown[]).includes(value)
}

/**
 * 存进去的值先过白名单，和日期偏好同理 —— localStorage 用户能手改。
 * 这里坏值的后果格外直观：`useColorMode` 会把那个词原样当类名加到 `<html>` 上，
 * 于是既不是 `light` 也不是 `dark`，页面回到浅色，看着像「设置丢了」。
 * 用 watch 而不是读的时候现算，是因为跨标签页改 localStorage 也会走到这里。
 */
watch(
  colorMode.store,
  (value) => {
    if (!isThemePreference(value)) colorMode.store.value = THEME_AUTO
  },
  { immediate: true }
)

/** 用户选的那一档（可能是 auto），改它就等于改主题 */
export const theme: Ref<ThemePreference> = colorMode.store
/**
 * 此刻真正生效的主题；auto 时等于 `systemTheme`。
 * 外面一层 computed 不只是为了收窄类型 —— 上面那个 watch 把坏值改回 auto 是在
 * 下一次 flush，中间这一瞬 `colorMode.state` 还是那个坏值，不该漏给调用方。
 */
export const resolvedTheme: ComputedRef<ResolvedTheme> = computed(() =>
  colorMode.state.value === "dark" ? "dark" : "light"
)
/** 系统当前是深是浅，给界面标个「跟随系统（现在是深色）」 */
export const systemTheme: ComputedRef<ResolvedTheme> = colorMode.system

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: THEME_AUTO, label: "跟随系统" }
]

export function useTheme() {
  return { theme, resolvedTheme, systemTheme }
}
