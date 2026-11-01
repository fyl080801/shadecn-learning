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
  }
}
