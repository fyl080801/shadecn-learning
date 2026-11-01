/**
 * 对象存储模块对外的契约（docs/28 §3.5）：别的模块（agent 的附件判权、看图）经 `ctx.service(STORAGE_SERVICE)` 拿。
 * 没加载存储模块（没配 S3、配置关掉、角色不带）时拿到 undefined —— 调用方按「没有对象存储」退化。
 * 这个入口不 import 实现。
 */
export const STORAGE_SERVICE = 'storage'

export interface FlowAssetRecord {
  key: string
  contentType: string
}

export interface StorageService {
  /** 对象键的根目录（`S3_KEY_PREFIX`） */
  readonly keyPrefix: string
  /** 画布资源的上传记录 */
  readonly assets: {
    /** 这些键里**属于这张画布**的那些，按 `keys` 的顺序；条数对不上 = 有不属于这张画布的 */
    findInFlow(flowId: string, keys: readonly string[]): Promise<FlowAssetRecord[]>
    /**
     * 服务端产出的字节存成这张画布的资源（生成节点的结果，docs/29 §3.8）：和浏览器上传走同一套键、缩略图、上传记录。
     * 只收图片 / 视频（同上传接口）；别的类型抛错
     */
    save(input: SaveFlowAssetInput): Promise<SavedFlowAsset>
    /**
     * 读**这张画布自己的**资源字节：地址先反解成本桶素材键（不发请求），再查归属。
     * 不是本桶的地址、不属于这张画布 → `null`（调用方按「不是我们的资源」处理，绝不去请求那个地址）；超过 `maxBytes` 抛错
     */
    read(flowId: string, url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<{ data: Uint8Array; contentType: string } | null>
  }
}

export interface SaveFlowAssetInput {
  flowId: string
  createdById: string
  data: Uint8Array
  contentType: string
  /** 文件名（只取扩展名，给人看的） */
  name?: string
}

export interface SavedFlowAsset {
  url: string
  key: string
  contentType: string
  size: number
}
