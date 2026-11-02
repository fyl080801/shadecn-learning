import 'reflect-metadata'
import { Cluster } from '@learning/cluster'
import { DataAccess } from '@learning/data-access'
import { bootstrapService } from '@learning/foundation'
import { AppModule } from './app.module.js'

await bootstrapService(AppModule, {
  name: 'platform',
  readiness: (app) => ({
    database: () => app.get(DataAccess).orm.isConnected(),
    cluster: () => app.get(Cluster).health().ok,
  }),
})
