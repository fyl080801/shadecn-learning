import 'reflect-metadata'
import { AppModule } from './app.module.js'
import { startPlatform } from './start.js'

await startPlatform(AppModule)
