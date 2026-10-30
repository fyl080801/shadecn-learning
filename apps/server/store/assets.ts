import { db } from '../db.ts'
import { FlowAsset } from '../db/entities/index.ts'

/**
 * 画布资源的上传记录（`FlowAsset`）：上传接口写，引用资源的地方按「这张画布 + 键」查归属。
 * 对象本身在 S3，这里不存地址 —— 地址由 `storage.objectUrl(key)` 现算，换存储前缀 / 访问方式时不用改库。
 */

export interface FlowAssetRecord {
  key: string
  contentType: string
}

export const flowAssets = {
  /** 上传成功后记一行。键是服务端刚拼出来的 uuid 键，不会和已有的撞 */
  async record(input: { flowId: string; key: string; contentType: string; createdById: string }): Promise<void> {
    const em = db()
    em.create(FlowAsset, {
      key: input.key,
      flow: input.flowId,
      contentType: input.contentType,
      createdById: input.createdById,
    })
    await em.flush()
  },

  /**
   * 这些键里**属于这张画布**的那些（别的画布上传的、从没记过的都不在结果里）。
   * 结果按 `keys` 的顺序；调用方拿条数对不上来判「有不属于这张画布的」。
   */
  async findInFlow(flowId: string, keys: readonly string[]): Promise<FlowAssetRecord[]> {
    if (keys.length === 0) return []
    const rows = await db().find(FlowAsset, { flow: flowId, key: { $in: [...keys] } }, { fields: ['key', 'contentType'] })
    const byKey = new Map(rows.map((row) => [row.key, { key: row.key, contentType: row.contentType }]))
    return keys.flatMap((key) => {
      const found = byKey.get(key)
      return found ? [found] : []
    })
  },
}
