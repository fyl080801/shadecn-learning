import { Cluster } from '@learning/cluster'
import { Module } from '@nestjs/common'
import { PlatformBaseModule } from './platform-base.module.js'

const SPLIT_CONFIG_CHECK = Symbol('SPLIT_CONFIG_CHECK')

/**
 * `single` 时平台的房间和协同副本互不相通：生成任务照样显示成功，结果却到不了连在副本上的用户，撤权和复制前落库也传不过去。这种配错不报任何错，所以启动时就拒绝。
 * 副本那边有同样的检查（`apps/collab/src/app.module.ts`）。
 */
function assertSplitConfig(cluster: Cluster): void {
  if (cluster.mode !== 'redis') throw new Error('[platform] cluster.mode 必须是 redis：协同由副本提供时，平台要经 Redis 和副本同步房间')
}

/** 协同由副本提供时的根模块（入口 `main-without-collab.ts`，docs/30 §3）：`PlatformBaseModule` 加上这道配置检查。单进程的 `AppModule` 也 import `PlatformBaseModule`，可以用 `single`，所以检查不放在那里 */
@Module({
  imports: [PlatformBaseModule],
  providers: [{ provide: SPLIT_CONFIG_CHECK, inject: [Cluster], useFactory: assertSplitConfig }],
})
export class PlatformSplitModule {}
