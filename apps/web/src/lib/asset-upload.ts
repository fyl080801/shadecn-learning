import {
  ASSET_PART_SIZE,
  type AssetUploadPart,
  type AssetUploadSession,
  type UploadedAsset
} from "@shadecn/shared/canvas"
import { ApiError, flowApi } from "@/lib/api"

/** 同时在传的片数：太多会挤占画布协同那条 WebSocket 的带宽，太少大文件又慢 */
const PART_CONCURRENCY = 3
/** 每片失败后再试几次（网络抖一下不该让整个大文件重来） */
const PART_RETRIES = 2

/** 4xx 是请求本身不对（键不对、片太大、没权限），重试也一样；只有网络错误和 5xx 值得再试 */
function retryable(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500
}

/**
 * 取消上传时抛出的错误（和 `fetch` 被 abort 时一样是 `AbortError`），调用方据此区分「取消」和「失败」。
 * 按 `name` 认，不用 `instanceof DOMException`：`DOMException` 不止一个实现（测试里 jsdom 和 Node 各一个）。
 */
export function isUploadCanceled(error: unknown) {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError"
}

async function withRetry<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (signal?.aborted || attempt >= PART_RETRIES || !retryable(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      signal?.throwIfAborted()
    }
  }
}

export interface UploadFlowAssetOptions {
  filename?: string
  /** 取消：正在发的请求立刻断开，分片上传顺带放弃（S3 删掉已传的片），最后抛 `AbortError` */
  signal?: AbortSignal
  /**
   * 进度（已传字节 / 总字节）。**只有分片上传才报**，按传完的片累计；一次传完的没有中间进度，一次都不调。
   */
  onProgress?: (loaded: number, total: number) => void
}

/**
 * 把一个画布资源传到对象存储，回 S3 原始地址。
 *
 * **不超过一片（`ASSET_PART_SIZE`）一次传完；更大的分片上传**：开一次上传 → 按服务端给的分片大小切片、
 * 最多 `PART_CONCURRENCY` 片并发、每片失败重试 → 按片号交回回执拼成对象。
 * 中途失败或被取消就放弃这次上传（尽力而为，放弃本身失败不再追究 —— 残片由桶的生命周期规则兜底），再把原错误抛出去。
 */
export async function uploadFlowAsset(
  flowId: string,
  file: Blob,
  options: UploadFlowAssetOptions = {}
): Promise<UploadedAsset> {
  const { signal, onProgress } = options
  const name = options.filename ?? (file instanceof File ? file.name : "file")
  if (file.size <= ASSET_PART_SIZE) return flowApi.uploadAsset(flowId, file, name, signal)

  const session = await flowApi.startAssetUpload(
    flowId,
    { filename: name, contentType: file.type, size: file.size },
    signal
  )
  try {
    const parts = await uploadParts(flowId, file, session, options)
    onProgress?.(file.size, file.size)
    return await flowApi.completeAssetUpload(flowId, session, parts, signal)
  } catch (error) {
    await flowApi.abortAssetUpload(flowId, session).catch(() => undefined)
    throw error
  }
}

async function uploadParts(
  flowId: string,
  file: Blob,
  session: AssetUploadSession,
  { signal, onProgress }: UploadFlowAssetOptions
): Promise<AssetUploadPart[]> {
  const parts: AssetUploadPart[] = new Array(session.partCount)
  let next = 0
  let loaded = 0
  let failed = false
  onProgress?.(0, file.size)

  // 几个「工人」轮流领下一片；一片彻底失败（或被取消）后别的工人不再领新片
  async function worker() {
    while (!failed && next < session.partCount) {
      signal?.throwIfAborted()
      const index = next++
      const chunk = file.slice(index * session.partSize, (index + 1) * session.partSize)
      try {
        parts[index] = await withRetry(
          () => flowApi.uploadAssetPart(flowId, session, index + 1, chunk, signal),
          signal
        )
      } catch (error) {
        failed = true
        throw error
      }
      loaded += chunk.size
      // 最后一片传完还要等拼对象，100% 留给 complete 之前那一下
      if (loaded < file.size) onProgress?.(loaded, file.size)
    }
  }

  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, session.partCount) }, worker))
  return parts
}
