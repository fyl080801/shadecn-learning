import 'reflect-metadata'
import { bootstrapService } from '@learning/foundation'
import { AppModule } from './app.module.js'

await bootstrapService(AppModule, { name: 'platform' })
