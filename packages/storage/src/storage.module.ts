import { CanvasModule } from '@learning/canvas'
import { ConfigService } from '@learning/config'
import { DATA_ACCESS_ENTITIES } from '@learning/data-access'
import { Module } from '@nestjs/common'
import { AssetBodyParsers } from './asset-body-parsers.js'
import { AssetStorage } from './asset-storage.js'
import { AssetsController } from './assets.controller.js'
import { FlowAsset } from './entities.js'
import { FlowAssets } from './flow-assets.js'
import { resolveStorageOptions, STORAGE_OPTIONS } from './options.js'
import { s3ClientProvider } from './s3-client.provider.js'
import { VariantBackfill } from './variants.js'

/**
 * 对象存储：上传接口、缩略图、上传记录，以及别的模块读写画布资源的 {@link AssetStorage}（docs/30 §2）。
 * 依赖方向是 storage → canvas：判权用 `CanvasModule` 的 `FlowMemberGuard`，`FlowAsset` 外键指向 `Flow`。canvas 不认识这里，
 * 复制画布不用通知谁（节点里的地址原样带过去，对象和记录都不动），画布真删靠数据库级联，撤权靠每个请求都重新判成员。
 * 没配对象存储时模块照样加载（接口回 503），是不是配了只有 `S3_CLIENT` 是不是 null 这一处差别。
 */
@Module({
  imports: [CanvasModule],
  controllers: [AssetsController],
  providers: [
    { provide: DATA_ACCESS_ENTITIES, useValue: [FlowAsset] },
    { provide: STORAGE_OPTIONS, inject: [ConfigService], useFactory: resolveStorageOptions },
    s3ClientProvider,
    FlowAssets,
    VariantBackfill,
    AssetBodyParsers,
    AssetStorage,
  ],
  exports: [AssetStorage],
})
export class StorageModule {}
