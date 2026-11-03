import { assertClusterDatabase, Cluster } from '@learning/cluster'
import { ConfigService } from '@learning/config'
import { databaseProviderOf } from '@learning/data-access'
import { Module } from '@nestjs/common'

const CLUSTER_DATABASE_CHECK = Symbol('CLUSTER_DATABASE_CHECK')

/**
 * cluster 和 data-access 互不依赖，在这里接线：规则在 `assertClusterDatabase`，数据库类型从 data-access 拿。
 * 只比较配置，不等 ORM 建好。provider 工厂抛错 = 启动失败，早于监听端口。
 * 放在本包：每个服务都要它，而本包本来就同时依赖这两个包，也正是它们对不上时最先出事的地方（SQLite 下各进程的会话互相看不见）。**每个根模块都要 import**。
 */
@Module({
  providers: [
    {
      provide: CLUSTER_DATABASE_CHECK,
      inject: [Cluster, ConfigService],
      useFactory: (cluster: Cluster, config: ConfigService) =>
        assertClusterDatabase({ mode: cluster.mode, isProduction: config.isProduction, databaseProvider: databaseProviderOf(config) }),
    },
  ],
})
export class ClusterDatabaseCheckModule {}
