import { s3Config, s3Enabled } from '../config.ts'
import { createS3Client, type S3Client } from './s3.ts'

/**
 * 画布资源的对象存储。没配齐 S3（见 `config.ts` 的 `s3Config`）就是 null：上传接口回 503，不影响启动。
 * 和 agent 的 runtime 一样按需构造、可被测试替换。
 */
let client: S3Client | null | undefined

export function assetStorage(): S3Client | null {
  if (client === undefined) client = s3Enabled ? createS3Client(s3Config) : null
  return client
}

/** 测试用：换一个假的存储；传 undefined 回到按环境变量构造 */
export function replaceAssetStorage(next: S3Client | null | undefined): void {
  client = next
}
