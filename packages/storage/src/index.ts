/**
 * @learning/storage —— S3、上传、缩略图（docs/13 §3.7、docs/27、docs/30 §2）。{@link StorageModule} 是唯一的入口，别的模块注入 {@link AssetStorage}。
 *
 * 表归这里（`entities.ts`），经 `DATA_ACCESS_ENTITIES` 登记；和 `@shadecn/mod-storage` 是两份定义，互不同步。
 * **依赖边界**（`test/package.test.ts` 钉着）：不依赖 `@shadecn/*`；`@learning/*`、`@nestjs/*`、`@mikro-orm/core` 都是 peerDependency，进程里的注入 token 和实体基类只有应用装的那一份。sharp 没有这种要求，是自己的依赖。
 */
export { AssetStorage, type SavedFlowAsset, type SaveFlowAssetInput } from './asset-storage.js'
export { FlowAsset } from './entities.js'
export type { FlowAssetRecord } from './flow-assets.js'
export { S3_CLIENT } from './s3-client.provider.js'
export type { S3Client, S3GetResult, S3Options } from './s3.js'
export { StorageModule } from './storage.module.js'
