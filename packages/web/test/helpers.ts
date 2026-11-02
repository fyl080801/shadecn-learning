import 'reflect-metadata'
import { testConfigModule } from '@learning/config/testing'
import { Controller, Get, Module, type ModuleMetadata } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { WebModule } from '../src/index.js'

@Controller('api')
class ApiController {
  @Get('hello')
  hello() {
    return 'Hello World!'
  }
}

@Module({ controllers: [ApiController] })
class ApiModule {}

/** config.yaml 的 `web` 段，加上用哪种模式（`mode` 不能配，由 isProduction 决定） */
export interface TestWebConfig {
  mode: 'dev' | 'static'
  root: string
  apiPrefix?: string
  htmlEntries?: Record<string, string>
  fallbackEntry?: string
  auth?: boolean | { loginPath?: string; publicPaths?: string[] }
}

/**
 * 真实监听随机端口：HMR 的 WebSocket 和 Vite 中间件都要走真实连接。
 * 不测闸门的用例不想关心它，这里默认关，测闸门的用例明确传 `auth`；默认开启这件事单独有用例。
 */
export async function createApp(
  { mode, ...web }: TestWebConfig,
  imports: NonNullable<ModuleMetadata['imports']> = [],
): Promise<{
  app: NestFastifyApplication
  baseUrl: string
}> {
  const config = testConfigModule({ web: { auth: false, ...web } }, { isProduction: mode === 'static' })
  const moduleRef = await Test.createTestingModule({
    imports: [config, ...imports, ApiModule, WebModule],
  }).compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  })
  await app.listen(0, '127.0.0.1')
  return { app, baseUrl: await app.getUrl() }
}
