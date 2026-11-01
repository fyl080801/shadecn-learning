import { CANVAS_SERVICE, underFlowGuard, type CanvasService } from '@shadecn/mod-canvas/contract'
import { defineModule } from '@shadecn/server-kit/kernel'
import { flowAssets } from './assets.ts'
import { configureAssetStorage } from './client.ts'
import { storageConfig } from './config.ts'
import { STORAGE_SERVICE, type StorageService } from './contract.ts'
import { FlowAsset } from './entities.ts'
import { createAssetRoutes } from './routes.ts'

export { assetStorage, configureAssetStorage, replaceAssetStorage } from './client.ts'
export type { S3Client, S3GetResult, S3Options } from './s3.ts'

/** 画布资源上传接口的路径（挂在画布之下，叠 `canvas.flowGuard`） */
export const ASSETS_PATH = '/api/flows/:flowId/assets'

/**
 * 对象存储模块（REQ-MODULES §3.5）。它是库不是角色：web 的上传接口和 agent 的看图都用它，
 * 所以随 `web` 和 `agent` 两个角色加载，各自持有一个客户端。
 *
 * - 没配齐 S3（`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`）→ 模块关掉，原因进启动日志和 `/api/features`；
 * - 上传接口挂在画布之下（`canvas.flowGuard` 判成员），上传记录是本模块自己的表（`FlowAsset`）；
 * - 别的模块经 `storage` 服务查上传记录（`./contract.ts`），经 `./client` 拿客户端读字节。
 */
export default defineModule({
  name: 'storage',
  roles: ['web', 'agent'],
  dependsOn: ['canvas'],
  provides: [STORAGE_SERVICE],
  config: storageConfig,
  entities: [FlowAsset],
  routes: [{ path: ASSETS_PATH, role: 'web', access: 'user' }],
  enabled: (config) => config.s3 !== null || '没配 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY',
  setup(ctx) {
    configureAssetStorage(ctx.config.s3)
    const service: StorageService = { keyPrefix: ctx.config.keyPrefix, assets: flowAssets }
    ctx.provide(STORAGE_SERVICE, service)

    const canvas = ctx.service<CanvasService>(CANVAS_SERVICE)!
    const routes = createAssetRoutes({
      request: canvas.request,
      assets: flowAssets,
      limits: { maxUploadBytes: ctx.config.maxUploadBytes, keyPrefix: ctx.config.keyPrefix },
    })
    ctx.http.route(ASSETS_PATH, underFlowGuard(canvas, routes))
    return {
      shutdown() {
        configureAssetStorage(null)
      },
    }
  },
})
