import { inject, provide, type InjectionKey, type Ref } from "vue"
import type { AssetVariant } from "@shadecn/shared/canvas"

import { flowApi } from "@/lib/api"

/**
 * 补缩略图（docs/27 §3.3）：某一档取不到（404）时请服务端补生成。
 *
 * 编辑器根组件 `provideAssetBackfill(flowId)` 一次（补档接口挂在画布下，判权按画布成员），
 * `AssetImage` 用 `useAssetBackfill()` 取；**没有提供就不补**（编辑器之外、单测里），图片照常退回原图。
 *
 * 去重是**模块级、按原图地址**的：一张图在画布上出现几次、图标和低清两档同时 404，整个页面只发一次请求。
 * 请求成功就记住结果（这一页里不再问）；失败（网络、5xx）不记，下次再遇到 404 再试。
 */
export type AssetBackfill = (src: string) => Promise<readonly AssetVariant[]>

const ASSET_BACKFILL_KEY: InjectionKey<AssetBackfill> = Symbol("asset-backfill")

const requests = new Map<string, Promise<readonly AssetVariant[]>>()

export function provideAssetBackfill(flowId: Ref<string>): void {
  provide(ASSET_BACKFILL_KEY, (src) => {
    const pending = requests.get(src)
    if (pending) return pending
    const task = flowApi
      .backfillAssetVariants(flowId.value, src)
      .then((result) => result.variants)
      .catch((err: unknown) => {
        requests.delete(src)
        console.warn(`[assets] 补缩略图失败 ${src}:`, err instanceof Error ? err.message : err)
        return []
      })
    requests.set(src, task)
    return task
  })
}

export function useAssetBackfill(): AssetBackfill | null {
  return inject(ASSET_BACKFILL_KEY, null)
}

/** 测试用：忘掉问过的图 */
export function resetAssetBackfill(): void {
  requests.clear()
}
