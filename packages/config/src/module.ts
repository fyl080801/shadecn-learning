import { Global, Module } from '@nestjs/common'
import { ConfigService } from './config.service.js'
import { loadConfig } from './load.js'

/**
 * 配置模块：在根模块 import 一次，别的模块不用 import 就能注入 {@link ConfigService}。
 * 业务模块依赖这个全局 provider 而不是 import 本模块，所以测试能用 `@learning/config/testing` 整个替换。
 *
 * 文件在 provider 工厂里读，不在 import 时读：读坏了抛错发生在 `NestFactory.create` 内部（默认 abortOnError：记日志、exit(1)）。
 */
@Global()
@Module({
  providers: [{ provide: ConfigService, useFactory: () => loadConfig() }],
  exports: [ConfigService],
})
export class ConfigModule {}
