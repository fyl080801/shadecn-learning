import { createS3Client, type S3Client, type S3Options } from './s3.ts'

/**
 * 画布资源的对象存储客户端，进程里一份。
 *
 * 存储模块装配时按本模块的配置段交进来（{@link configureAssetStorage}，见 `./index.ts`）；
 * 没配齐 S3 或者没装配过（测试）就是 null：上传接口回 503、agent 没有看图工具，不影响启动。
 * 第一次用到时才构造，可被测试替换。解析在 `./config.ts`。
 */
let options: S3Options | null = null
let client: S3Client | null | undefined

export function configureAssetStorage(next: S3Options | null): void {
  options = next
  client = undefined
}

export function assetStorage(): S3Client | null {
  if (client === undefined) client = options ? createS3Client(options) : null
  return client
}

/** 测试用：换一个假的存储；传 undefined 回到按装配时的参数构造 */
export function replaceAssetStorage(next: S3Client | null | undefined): void {
  client = next
}
