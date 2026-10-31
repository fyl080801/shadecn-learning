import { s3Enabled } from '../config.ts'
import { defineModule } from '../kernel/module.ts'

/**
 * 对象存储（S3）模块。它是库不是角色（docs/28 §3.5）：web 的 `/api/assets` 和 agent 的看图都用它，各自按配置启用。
 *
 * 开关跟着配置走：`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` 缺一个就是没开 ——
 * 上传接口 503（`routes/assets.ts` 自己判 `s3Enabled`），agent 没有看图工具，`/api/features.storage` 为 false。
 * 第 1 期没有装配动作（客户端在 `storage/index.ts` 里惰性建）；路由随模块走在第 4 期。
 */
export const storageModule = defineModule({
  name: 'storage',
  roles: ['web', 'agent'],
  enabled: () => s3Enabled || '没配 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY',
  setup() {},
})
