import { DataAccess } from '@learning/data-access'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { Inject, Injectable } from '@nestjs/common'
import { FlowAsset } from './entities.js'

export interface FlowAssetRecord {
  key: string
  contentType: string
}

/**
 * 画布资源的上传记录。对象本身在 S3，这里不存地址 —— 地址由 `S3Client.objectUrl(key)` 现算，换存储前缀 / 访问方式时不用改库。
 */
@Injectable()
export class FlowAssets {
  constructor(@Inject(DataAccess) private readonly dataAccess: DataAccess) {}

  /**
   * 上传成功后记一行。
   *
   * 分片上传的 complete 可能被重放（客户端超时重试、两个标签页），同一个键到这里两次：**靠 `key` 的唯一约束判输赢，不先查后写**（查和写之间另一个请求可能已经写了）。
   * 输家重查一次：同一张画布就算记好了（幂等）；别的画布持有这个键就按原错误抛 —— 归属不能被后来者改写，上传算失败（500）。
   */
  async record(input: { flowId: string; key: string; contentType: string; createdById: string }): Promise<void> {
    const em = this.dataAccess.em()
    em.create(FlowAsset, { key: input.key, flow: input.flowId, contentType: input.contentType, createdById: input.createdById })
    try {
      await em.flush()
    } catch (err) {
      if (!(err instanceof UniqueConstraintViolationException)) throw err
      const winner = await this.dataAccess.em().count(FlowAsset, { key: input.key, flow: input.flowId })
      if (winner === 0) throw err
    }
  }

  /** 这些键里**属于这张画布**的那些，按 `keys` 的顺序；调用方拿条数对不上来判「有不属于这张画布的」 */
  async findInFlow(flowId: string, keys: readonly string[]): Promise<FlowAssetRecord[]> {
    if (keys.length === 0) return []
    const rows = await this.dataAccess.em().find(FlowAsset, { flow: flowId, key: { $in: [...keys] } }, { fields: ['key', 'contentType'] })
    const byKey = new Map(rows.map((row) => [row.key, { key: row.key, contentType: row.contentType }]))
    return keys.flatMap((key) => {
      const found = byKey.get(key)
      return found ? [found] : []
    })
  }

  /** 这个键有没有经本服务上传过（哪张画布都算）：补缩略图只给自己传进来的原图补 */
  async exists(key: string): Promise<boolean> {
    return (await this.dataAccess.em().count(FlowAsset, { key })) > 0
  }
}
