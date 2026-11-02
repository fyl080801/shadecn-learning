import { ref } from "vue"
import type { AppInfo } from "@shadecn/shared/apps"

import { appApi } from "@/lib/api"

/**
 * 应用列表（docs/29，`GET /api/apps`）。**状态在模块级**：画布上每个生成节点的选择器都要它，挂几十个节点不该发几十次请求；
 * 第一次用到时加载，之后复用（配置改了要重启服务端，页面不用轮询）。加载失败留着错误，下次 `ensure()` 再试。
 */
const apps = ref<AppInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let pending: Promise<void> | null = null
let loaded = false

function ensure(): Promise<void> {
  if (loaded) return Promise.resolve()
  pending ??= (async () => {
    loading.value = true
    error.value = null
    try {
      apps.value = await appApi.list()
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
      pending = null
    }
  })()
  return pending
}

export function useApps() {
  void ensure()
  return { apps, loading, error, ensure }
}

/** 测试用：清掉缓存 */
export function resetApps() {
  apps.value = []
  loading.value = false
  error.value = null
  pending = null
  loaded = false
}
