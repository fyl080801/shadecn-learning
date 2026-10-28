import { watch, type WatchSource } from "vue"

/**
 * 浏览器标签页标题。
 *
 * 统一格式：`区域` 或 `区域 - 具体名`，例如「画布 - 下单主流程」。
 * 静态页面在路由表的 `meta.title` 里声明（`src/router/index.ts` 的 afterEach 负责写入），
 * 数据加载完才知道名字的页面用下面的 `usePageTitle()` 覆盖。
 */

export function setPageTitle(section: string, detail?: string | null) {
  document.title = detail ? `${section} - ${detail}` : section
}

/**
 * 跟着数据走的标题：`detail` 还没加载出来时只显示区域名，
 * 拿到之后自动补成「区域 - 名字」。
 */
export function usePageTitle(section: string, detail: WatchSource<string | null | undefined>) {
  watch(detail, (value) => setPageTitle(section, value), { immediate: true })
}
