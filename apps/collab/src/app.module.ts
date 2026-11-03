import { Cluster, ClusterModule } from '@learning/cluster'
import { CollabGatewayModule } from '@learning/collab'
import { ConfigModule, ConfigService } from '@learning/config'
import { DataAccessModule } from '@learning/data-access'
import { ApiSessionGuard, ClusterDatabaseCheckModule, SessionIdentityModule } from '@learning/session'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'

const REPLICA_CONFIG_CHECK = Symbol('REPLICA_CONFIG_CHECK')

/**
 * 这个服务只作为「平台 + 若干副本」的一部分存在，两种配错都不能悄悄跑起来：
 * - `single`：副本各持一份 Y.Doc 互不通信，平台的撤权和复制前落库也到不了这里；
 * - 默认的 `schemaSync: apply`：表结构归平台，多个副本一起跑 DDL 会撞车。
 */
function assertReplicaConfig(cluster: Cluster, config: ConfigService): void {
  if (cluster.mode !== 'redis') throw new Error('[collab-service] cluster.mode 必须是 redis：协同副本不能各自在内存里持有文档')
  if (config.mapping('database').schemaSync !== 'off') throw new Error('[collab-service] database.schemaSync 必须写 off：表结构由平台同步')
}

/**
 * 协同副本：只有协同的入口，画布的判权经 `CollabGatewayModule` 带进来，没有页面、登录流程和画布 REST（docs/30 §3）。
 * 配置和平台一样读 `<dataDir>/config.yaml`，示例见 `config.example.yaml`。握手要续期会话，所以 `auth` 段和平台相同。
 */
@Module({
  imports: [ConfigModule, DataAccessModule, ClusterModule, SessionIdentityModule, CollabGatewayModule, ClusterDatabaseCheckModule],
  providers: [
    { provide: APP_GUARD, useClass: ApiSessionGuard },
    { provide: REPLICA_CONFIG_CHECK, inject: [Cluster, ConfigService], useFactory: assertReplicaConfig },
  ],
})
export class AppModule {}
