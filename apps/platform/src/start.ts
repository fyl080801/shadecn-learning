import { Cluster } from '@learning/cluster'
import { DataAccess } from '@learning/data-access'
import { type BootstrapOptions, bootstrapService } from '@learning/foundation'

const readiness: BootstrapOptions['readiness'] = (app) => ({
  database: () => app.get(DataAccess).orm.isConnected(),
  cluster: () => app.get(Cluster).health().ok,
})

/** 两个入口只有根模块不同 */
export async function startPlatform(rootModule: Parameters<typeof bootstrapService>[0]): Promise<void> {
  await bootstrapService(rootModule, { name: 'platform', readiness })
}
