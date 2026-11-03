import type { Provider } from '@nestjs/common'
import { STORAGE_OPTIONS, type StorageOptions } from './options.js'
import { createS3Client, type S3Client } from './s3.js'

/** 进程里一份的 S3 客户端；没配齐是 null。构造不发请求，所以连不上存储也不影响启动。测试用 `overrideProvider` 换假的 */
export const S3_CLIENT = Symbol('S3_CLIENT')

export const s3ClientProvider: Provider<S3Client | null> = {
  provide: S3_CLIENT,
  inject: [STORAGE_OPTIONS],
  useFactory: (options: StorageOptions) => (options.s3 ? createS3Client(options.s3) : null),
}
