import { ConfigService } from '@learning/config'
import { Global, Module } from '@nestjs/common'
import { Cluster, openCluster } from './cluster.js'

/**
 * 跨进程共享状态：在根模块 import 一次，别的模块不用 import 就能注入 {@link Cluster}。
 * 配置是 config.yaml 的 `cluster` 段（校验在 options.ts），经全局的 `ConfigService` 取；这里不 import ConfigModule，测试才能换掉它。
 */
@Global()
@Module({
  providers: [{ provide: Cluster, inject: [ConfigService], useFactory: openCluster }],
  exports: [Cluster],
})
export class ClusterModule {}
