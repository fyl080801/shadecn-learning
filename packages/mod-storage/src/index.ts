import { defineModule, type ServerModule } from '@shadecn/server-kit/kernel'
import { configureAssetStorage } from './client.ts'
import type { S3Options } from './s3.ts'

export { assetStorage, configureAssetStorage, replaceAssetStorage } from './client.ts'
export type { S3Client, S3GetResult, S3Options } from './s3.ts'

/**
 * 对象存储模块（REQ-MODULES §3.5）。它是库不是角色：web 的 `/api/assets` 和 agent 的看图都用它，
 * 所以随 `web` 和 `agent` 两个角色加载，各自持有一个客户端。
 *
 * - `s3`：连接参数，宿主从环境变量解析好再交进来；`null` = 没配齐，模块关掉（原因进启动日志和 `/api/features`）。
 * - 没有路由：上传接口还在宿主（`apps/server/routes/assets.ts`），它要碰画布资源表和鉴权，那是底座的东西。
 */
export function createStorageModule<App>(options: { s3: S3Options | null; disabledReason?: string }): ServerModule<App> {
  return defineModule<App>({
    name: 'storage',
    roles: ['web', 'agent'],
    enabled: () => options.s3 !== null || options.disabledReason || '没配对象存储',
    setup() {
      configureAssetStorage(options.s3)
      return {
        shutdown() {
          configureAssetStorage(null)
        },
      }
    },
  })
}
