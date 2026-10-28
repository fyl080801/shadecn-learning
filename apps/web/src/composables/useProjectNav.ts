import { ref } from "vue"

import { projectApi } from "@/lib/api"
import type { ProjectSummary } from "@shadecn/shared/canvas"

/**
 * 画布工作区侧栏里的「我的项目」列表。
 *
 * **状态在模块级，不在组件里**：个人画布页和项目主页是两个路由组件，各自包着一份
 * `CanvasWorkspace`，在两页之间切换时侧栏会随页面重新挂载。要是列表放在组件里，
 * 每次切换都会闪一遍 loading。放在模块级，首次使用时加载，之后复用缓存；
 * 需要刷新的时刻（新建 / 删除 / 改名）显式调 `refresh()`。
 */

/** 一次取满服务端允许的最大页；侧栏不做分页，放不下的在底部提示 */
export const PROJECT_NAV_PAGE_SIZE = 100

const projects = ref<ProjectSummary[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
let loaded = false
/** 防止并发刷新时旧请求盖掉新结果 */
let generation = 0

async function refresh() {
  const mine = ++generation
  loading.value = true
  error.value = null
  try {
    const data = await projectApi.list({ page: 1, pageSize: PROJECT_NAV_PAGE_SIZE })
    if (mine !== generation) return
    projects.value = data.items
    total.value = data.total
    loaded = true
  } catch (err) {
    if (mine !== generation) return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (mine === generation) loading.value = false
  }
}

/**
 * 不挂侧栏的页面（邀请页）改了「我在哪些项目里」时用：只刷新缓存。
 * 还没加载过就不必拉 —— 侧栏第一次挂载时自己会取。
 */
export function refreshProjectNav() {
  return loaded ? refresh() : Promise.resolve()
}

/** 首次使用时加载；已经有缓存（或正在加载）就什么都不做 */
function ensureLoaded() {
  if (loaded || loading.value) return
  void refresh()
}

/** 测试用：丢掉模块级缓存，让下一个用例像第一次进来一样 */
export function resetProjectNav() {
  generation++
  projects.value = []
  total.value = 0
  loading.value = false
  error.value = null
  loaded = false
}

export function useProjectNav() {
  ensureLoaded()
  return { projects, total, loading, error, refresh }
}
