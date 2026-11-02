import 'reflect-metadata'
import { ConfigService } from '@learning/config'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'
import { serverPort } from './server-options.js'

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())
app.enableShutdownHooks()
await app.listen(serverPort(app.get(ConfigService)))
console.log(`[platform] 已启动：${await app.getUrl()}`)
