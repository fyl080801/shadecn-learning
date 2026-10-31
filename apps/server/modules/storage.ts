import { createStorageModule } from '@shadecn/mod-storage'
import type { ServerApp } from '../app.ts'
import { s3Config, s3Enabled } from '../config.ts'

/**
 * 对象存储模块的装配点：能力在 `@shadecn/mod-storage`，这里只把宿主解析好的环境变量交进去。
 * `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` 缺一个就是没开 —— 上传接口 503，agent 没有看图工具，
 * `/api/features.storage` 为 false。
 */
export const storageModule = createStorageModule<ServerApp>({
  s3: s3Enabled ? s3Config : null,
  disabledReason: '没配 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY',
})
